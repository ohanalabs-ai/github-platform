// web-pr-rundown capture — runs INSIDE the pinned mcr.microsoft.com/playwright image (its Chromium), with `playwright` as the
// one npm dependency (capture/package-lock.json, the image's exact version). It drives two local servers — the PR's image (HEAD_URL)
// and the baseline image (BASE_URL, optional) — and writes OUT/rundown.json + OUT/shots/*.jpg:
//   - every page reachable from "/" (BFS over internal <a href>, ≤ MAX_PAGES), at each VIEWPORTS width, full-page;
//   - a pixel diff head vs base per view and per <section> (in a canvas, so no image library), crops of the changed sections;
//   - videos: the media URL answers, a muted play() actually plays, autoplay videos play on their own and are muted;
//   - console errors, failed requests (≥ 400 or network failure), broken internal links, deny-list hits in the rendered DOM and
//     in every text response (line number + selector only; console/request text is redacted before it is written).
// Env: HEAD_URL, HEAD_IMAGE, HEAD_LABEL, BASE_URL?, BASE_IMAGE?, BASE_LABEL?, VIEWPORTS="390,768,1440", PAGES? (comma list,
//      overrides the crawl), MAX_PAGES=20, THRESHOLD=0.001, DENYLIST (file path, optional), OUT.
import { chromium, type Browser, type Page } from "playwright";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA, parseDenylist, redact, sectionKey, pairSections, shotName, summarize, validateRundown,
  type DenyHit, type DenyPattern, type PageReport, type Rundown, type SectionDiff, type Shot, type VideoCheck, type View, type BrokenLink,
} from "../rundown.ts";

const env = (k: string, d = "") => process.env[k] ?? d;
const HEAD = env("HEAD_URL").replace(/\/$/, "");
const BASE = env("BASE_URL").replace(/\/$/, "");
const OUT = env("OUT", "out");
const VIEWPORTS = env("VIEWPORTS", "390,768,1440").split(",").map((x) => Number(x.trim())).filter((x) => x > 0);
const MAX_PAGES = Number(env("MAX_PAGES", "20"));
const THRESHOLD = Number(env("THRESHOLD", "0.001"));
const MAX_H = 16_000; // px: canvas + screenshot ceiling; taller pages are cut (noted in the view)
const deny: DenyPattern[] = env("DENYLIST") && existsSync(env("DENYLIST")) ? parseDenylist(readFileSync(env("DENYLIST"), "utf8")) : [];
if (!HEAD) throw new Error("HEAD_URL is required");
mkdirSync(join(OUT, "shots"), { recursive: true });

const FREEZE = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

async function open(b: Browser, url: string, width: number) {
  const ctx = await b.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(async () => page.goto(url, { waitUntil: "load", timeout: 45_000 }));
  return { ctx, page, status: res?.status() ?? 0 };
}

/** Scroll through (reveals, lazy media), freeze animations, park every video on frame 0, then measure the sections. */
async function settle(page: Page) {
  await page.addStyleTag({ content: FREEZE });
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
    window.scrollTo(0, 0);
    await Promise.all([...document.querySelectorAll("video")].map((v) => new Promise<void>((done) => {
      v.pause();
      if (v.readyState === 0 || v.currentTime === 0) return done();
      const t = setTimeout(done, 2000); v.addEventListener("seeked", () => { clearTimeout(t); done(); }, { once: true }); v.currentTime = 0;
    })));
    await document.fonts.ready;
  });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const top = [...document.querySelectorAll("section")].filter((s) => !s.parentElement?.closest("section"));
    return {
      height: document.documentElement.scrollHeight,
      sections: top.map((s) => { const r = s.getBoundingClientRect(); return { id: s.id, label: s.getAttribute("aria-label"), heading: s.querySelector("h1,h2,h3")?.textContent ?? "", y: Math.round(r.top + window.scrollY), h: Math.round(r.height) }; }),
    };
  });
}

interface Cap { png: Buffer; width: number; height: number; fullHeight: number; sections: Array<{ key: string; y: number; h: number }> }
async function capture(b: Browser, url: string, width: number): Promise<Cap | null> {
  const { ctx, page, status } = await open(b, url, width);
  try {
    if (status >= 400 || status === 0) return null;
    const m = await settle(page);
    const height = Math.min(m.height, MAX_H);
    const png = await page.screenshot({ fullPage: m.height <= MAX_H, clip: m.height > MAX_H ? { x: 0, y: 0, width, height } : undefined, animations: "disabled" });
    return { png, width, height, fullHeight: m.height, sections: m.sections.map((s, i) => ({ key: sectionKey(s, i), y: s.y, h: s.h })) };
  } finally { await ctx.close(); }
}

// The diff page: decode both PNGs into canvases, compare pixels, cut JPEG crops. All in Chromium — no image dependency.
let diffPage: Page;
interface DiffIn { head: string; base: string | null; pairs: Array<{ hy: number; hh: number; by: number; bh: number } | null>; wantFullBase: boolean }
interface DiffOut { ratio: number | null; sections: Array<{ ratio: number | null; head: string | null; base: string | null }>; headJpg: string; baseJpg: string | null }
async function diff(a: DiffIn, threshold: number): Promise<DiffOut> {
  return diffPage.evaluate(async ({ a, threshold }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const canvas = (i: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = i.naturalWidth; c.height = i.naturalHeight; const x = c.getContext("2d", { willReadFrequently: true })!; x.drawImage(i, 0, 0); return { c, x }; };
    const crop = (c: HTMLCanvasElement, y: number, h: number) => { const o = document.createElement("canvas"); o.width = c.width; o.height = Math.max(1, Math.min(h, c.height - y)); o.getContext("2d")!.drawImage(c, 0, y, c.width, o.height, 0, 0, c.width, o.height); return o.toDataURL("image/jpeg", 0.82); };
    const cmp = (A: CanvasRenderingContext2D, ay: number, ah: number, B: CanvasRenderingContext2D, by: number, bh: number, w: number) => {
      const h = Math.min(ah, bh); if (h <= 0) return 1;
      const da = A.getImageData(0, ay, w, h).data, db = B.getImageData(0, by, w, h).data;
      let n = 0; for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 24 || Math.abs(da[i + 1] - db[i + 1]) > 24 || Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
      return (n + w * Math.abs(ah - bh)) / (w * Math.max(ah, bh));
    };
    const H = canvas(await load(a.head));
    const headJpg = H.c.toDataURL("image/jpeg", 0.8);
    if (!a.base) return { ratio: null, sections: a.pairs.map(() => ({ ratio: null, head: null, base: null })), headJpg, baseJpg: null };
    const B = canvas(await load(a.base));
    const w = Math.min(H.c.width, B.c.width);
    const ratio = cmp(H.x, 0, H.c.height, B.x, 0, B.c.height, w);
    const sections = a.pairs.map((p) => {
      if (!p) return { ratio: null, head: null, base: null };
      const r = p.hh > 0 && p.bh > 0 ? cmp(H.x, p.hy, Math.min(p.hh, H.c.height - p.hy), B.x, p.by, Math.min(p.bh, B.c.height - p.by), w) : 1;
      return r > threshold ? { ratio: r, head: p.hh > 0 ? crop(H.c, p.hy, p.hh) : null, base: p.bh > 0 ? crop(B.c, p.by, p.bh) : null } : { ratio: r, head: null, base: null };
    });
    return { ratio, sections, headJpg, baseJpg: ratio > threshold || a.wantFullBase ? B.c.toDataURL("image/jpeg", 0.8) : null };
  }, { a, threshold });
}
function save(dataUrl: string, rel: string, width: number, height: number): Shot {
  writeFileSync(join(OUT, rel), Buffer.from(dataUrl.split(",")[1], "base64"));
  return { path: rel, width, height };
}

/** Load once at the widest viewport: console errors, failed requests, deny-list hits (DOM + text responses), links. */
async function inspect(b: Browser, url: string, scanned: Set<string>) {
  const ctx = await b.newContext({ viewport: { width: Math.max(...VIEWPORTS), height: 900 } });
  const page = await ctx.newPage();
  const consoleErr: string[] = [], failed: string[] = [], hits: DenyHit[] = [];
  const bodies: Promise<void>[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErr.push(redact(deny, m.text())); });
  page.on("pageerror", (e) => consoleErr.push(redact(deny, `uncaught: ${e.message}`)));
  page.on("requestfailed", (r) => failed.push(redact(deny, `${r.method()} ${new URL(r.url()).pathname} — ${r.failure()?.errorText ?? "failed"}`)));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400) failed.push(redact(deny, `${r.request().method()} ${u.pathname} — HTTP ${r.status()}`));
    const ct = r.headers()["content-type"] || "";
    if (!deny.length || scanned.has(u.pathname) || !/text\/|javascript|json|svg|xml/.test(ct)) return;
    scanned.add(u.pathname);
    bodies.push(r.text().then((t) => { for (const p of deny) if (new RegExp(p.source, "i").test(t)) hits.push({ line: p.line, where: `response ${u.pathname}` }); }).catch(() => {}));
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await Promise.all(bodies);
  const info = await page.evaluate((pats) => {
    const res: Array<{ line: number; where: string }> = [];
    const rx = pats.map((p) => ({ line: p.line, re: new RegExp(p.source, "i") }));
    const where = (el: Element) => {
      const sec = el.closest("section"); const all = [...document.querySelectorAll("section")];
      const tag = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "");
      return sec ? `section ${all.indexOf(sec) + 1} > ${tag}` : tag;
    };
    const test = (text: string, w: string) => { for (const r of rx) if (r.re.test(text)) res.push({ line: r.line, where: w }); };
    test(document.title, "title");
    document.querySelectorAll("meta[content]").forEach((m) => test(m.getAttribute("content") || "", `meta[${m.getAttribute("name") || m.getAttribute("property") || "?"}]`));
    document.querySelectorAll("*").forEach((el) => {
      for (const a of ["alt", "title", "aria-label", "placeholder"]) { const v = el.getAttribute(a); if (v) test(v, `${where(el)}[${a}]`); }
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
      if (own.trim()) test(own, where(el));
    });
    const links = [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href);
    const ids = new Set([...document.querySelectorAll("[id]")].map((e) => e.id));
    return { title: document.title, hits: res, links, ids: [...ids] };
  }, deny);
  await ctx.close();
  const uniq = [...hits, ...info.hits].filter((h, i, xs) => xs.findIndex((y) => y.line === h.line && y.where === h.where) === i).map((h) => ({ line: h.line, where: redact(deny, h.where) }));
  return { title: redact(deny, info.title), console: consoleErr, failed, hits: uniq, links: info.links, ids: new Set(info.ids) };
}

async function videos(b: Browser, path: string): Promise<VideoCheck[]> {
  const ctx = await b.newContext({ viewport: { width: Math.max(...VIEWPORTS), height: 900 } });
  const page = await ctx.newPage();
  await page.goto(HEAD + path, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const vids = await page.evaluate(() => [...document.querySelectorAll("video")].map((v, i) => {
    v.dataset.rundown = String(i);
    return { i, src: v.currentSrc || v.src || v.querySelector("source")?.src || "", autoplay: v.autoplay, muted: v.muted, autoplaying: v.autoplay ? !v.paused && v.readyState >= 2 && v.currentTime > 0 : null };
  }));
  const out: VideoCheck[] = [];
  for (const v of vids) {
    let status = 0;
    if (v.src) status = await page.request.get(v.src, { headers: { Range: "bytes=0-1023" } }).then((r) => r.status()).catch(() => 0);
    const playable = await page.evaluate(async (i) => {
      const el = document.querySelector(`video[data-rundown="${i}"]`) as HTMLVideoElement;
      el.muted = true; el.scrollIntoView();
      try { await el.play(); } catch { /* reported below */ }
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) { if (el.readyState >= 2 && el.currentTime > 0.05) { el.pause(); return true; } await new Promise((r) => setTimeout(r, 200)); }
      return false;
    }, v.i);
    const problems = [
      !v.src && "no source",
      v.src && status >= 400 && `HTTP ${status}`,
      v.src && status === 0 && "unreachable",
      !playable && "does not play",
      v.autoplay && !v.muted && "autoplays with sound",
      v.autoplay && v.autoplaying === false && "autoplay did not start",
    ].filter(Boolean) as string[];
    out.push({ page: path, src: v.src.replace(HEAD, ""), autoplay: v.autoplay, muted: v.muted, status, autoplaying: v.autoplaying, playable, ok: !problems.length, problem: problems.join(", ") });
  }
  await ctx.close();
  return out;
}

async function crawl(b: Browser, origin: string): Promise<string[]> {
  if (env("PAGES")) return env("PAGES").split(",").map((p) => p.trim()).filter(Boolean);
  const queue = ["/"], found = new Set<string>(["/"]);
  const ctx = await b.newContext(); const page = await ctx.newPage();
  while (queue.length && found.size < MAX_PAGES) {
    const p = queue.shift()!;
    const ok = await page.goto(origin + p, { waitUntil: "domcontentloaded", timeout: 30_000 }).then((r) => (r?.status() ?? 0) < 400).catch(() => false);
    if (!ok) continue;
    const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href));
    for (const h of hrefs) {
      const u = new URL(h);
      if (u.origin !== new URL(origin).origin || /\.[a-z0-9]{2,5}$/i.test(u.pathname)) continue; // pages only, not files
      const path = u.pathname.replace(/\/+$/, "") || "/";
      if (!found.has(path) && found.size < MAX_PAGES) { found.add(path); queue.push(path); }
    }
  }
  await ctx.close();
  return [...found].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

const browser = await chromium.launch();
diffPage = await (await browser.newContext()).newPage();
const paths = await crawl(browser, HEAD);
const basePaths = BASE ? new Set(await crawl(browser, BASE)) : new Set<string>();
const scanned = new Set<string>();
const pages: PageReport[] = [];
const vids: VideoCheck[] = [];
const linkStatus = new Map<string, number | string>();
const broken: BrokenLink[] = [];
let external = 0;

for (const path of paths) {
  const views: View[] = [];
  for (const vp of VIEWPORTS) {
    const h = await capture(browser, HEAD + path, vp);
    if (!h) continue;
    const b = BASE ? await capture(browser, BASE + path, vp) : null;
    const pairs = b ? pairSections(h.sections, b.sections) : h.sections.map((s) => ({ key: s.key, head: s, base: null }));
    const d = await diff({
      head: `data:image/png;base64,${h.png.toString("base64")}`,
      base: b ? `data:image/png;base64,${b.png.toString("base64")}` : null,
      pairs: pairs.map((p) => (p.head || p.base ? { hy: p.head?.y ?? 0, hh: p.head?.h ?? 0, by: p.base?.y ?? 0, bh: p.base?.h ?? 0 } : null)),
      wantFullBase: false,
    }, THRESHOLD);
    const changed = !b ? Boolean(BASE) : (d.ratio ?? 0) > THRESHOLD; // a page missing in base is a change when a baseline exists
    const sections: SectionDiff[] = pairs.map((p, i) => {
      const s = d.sections[i] ?? { ratio: null, head: null, base: null };
      const sc = b ? (s.ratio ?? 1) > THRESHOLD : false;
      return {
        key: redact(deny, p.key), diffRatio: s.ratio, changed: sc,
        head: s.head ? save(s.head, shotName(path, vp, "head", i), vp, p.head?.h ?? 0) : null,
        base: s.base ? save(s.base, shotName(path, vp, "base", i), vp, p.base?.h ?? 0) : null,
      };
    });
    views.push({
      viewport: vp,
      head: save(d.headJpg, shotName(path, vp, "head"), vp, h.height),
      base: d.baseJpg && b ? save(d.baseJpg, shotName(path, vp, "base"), vp, b.height) : null,
      headHeight: h.fullHeight, baseHeight: b ? b.fullHeight : null,
      diffRatio: d.ratio, changed, sections,
    });
    console.log(`${path} @${vp}: ${b ? `diff ${((d.ratio ?? 0) * 100).toFixed(2)}%` : "no baseline"} · ${sections.filter((s) => s.changed).length} section(s) changed`);
  }
  const ins = await inspect(browser, HEAD + path, scanned);
  for (const href of ins.links) {
    const u = new URL(href);
    if (u.origin !== new URL(HEAD).origin) { external++; continue; }
    if (u.hash && (u.pathname.replace(/\/+$/, "") || "/") === path) { if (!ins.ids.has(decodeURIComponent(u.hash.slice(1))) && u.hash !== "#") broken.push({ from: path, href: u.pathname + u.hash, status: "missing anchor" }); continue; }
    const key = u.pathname;
    if (!linkStatus.has(key)) linkStatus.set(key, await diffPage.request.get(u.origin + key).then((r) => r.status()).catch((e) => String(e).slice(0, 60)));
    const st = linkStatus.get(key)!;
    if (typeof st !== "number" || st >= 400) broken.push({ from: path, href: key, status: st });
  }
  vids.push(...(await videos(browser, path)));
  pages.push({ path, title: ins.title, inBase: !BASE || basePaths.has(path), views, console: ins.console, failedRequests: ins.failed, denylist: ins.hits });
}
await browser.close();

const partial: Omit<Rundown, "summary"> = {
  schema: SCHEMA, generatedAt: new Date().toISOString(),
  head: { image: env("HEAD_IMAGE", HEAD), label: env("HEAD_LABEL", "head") },
  base: BASE ? { image: env("BASE_IMAGE", BASE), label: env("BASE_LABEL", "base") } : null,
  viewports: VIEWPORTS, threshold: THRESHOLD, pages, videos: vids,
  links: { checked: linkStatus.size, external, broken },
};
const rundown = validateRundown({ ...partial, summary: summarize(partial) });
writeFileSync(join(OUT, "rundown.json"), JSON.stringify(rundown, null, 2));
console.log(JSON.stringify(rundown.summary));
