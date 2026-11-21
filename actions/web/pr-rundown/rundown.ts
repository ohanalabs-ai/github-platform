// web-pr-rundown — the pure part (no I/O, no dependencies): the rundown.json schema, deny-list parsing/scanning/redaction,
// section pairing, the per-PR assets branch layout, and the sticky PR comment. Imported by capture/capture.ts (inside the
// Playwright container) and by publish.ts / prune.ts (github-script). Tested by rundown.test.ts (node --test).

export const SCHEMA = "web-pr-rundown/v1";
export const MARKER = "<!-- web-pr-rundown -->";
export const COMMENT_MAX = 60_000; // GitHub's comment limit is 65 536 characters

export interface Shot { path: string; width: number; height: number } // path is relative to the rundown's out dir (shots/…)
export interface SectionDiff { key: string; diffRatio: number | null; changed: boolean; head: Shot | null; base: Shot | null }
export interface View {
  viewport: number;
  head: Shot | null; // null = not uploaded (unchanged view, no reason to show it)
  base: Shot | null;
  headHeight: number;
  baseHeight: number | null;
  diffRatio: number | null; // fraction of differing pixels, null when there is no baseline
  changed: boolean;
  sections: SectionDiff[];
}
export interface DenyHit { line: number; where: string } // the deny-list LINE NUMBER and a selector — never the matched text
export interface PageReport {
  path: string;
  title: string;
  inBase: boolean;
  views: View[];
  console: string[]; // redacted
  failedRequests: string[]; // redacted
  denylist: DenyHit[];
}
export interface VideoCheck {
  page: string;
  src: string;
  autoplay: boolean;
  muted: boolean;
  status: number; // HTTP status of the media URL
  autoplaying: boolean | null; // only for autoplay videos: playing without any interaction
  playable: boolean; // a muted play() reaches readyState >= 2 and advances currentTime
  ok: boolean;
  problem: string;
}
export interface BrokenLink { from: string; href: string; status: number | string }
export interface Rundown {
  schema: typeof SCHEMA;
  generatedAt: string;
  head: { image: string; label: string };
  base: { image: string; label: string } | null;
  viewports: number[];
  threshold: number;
  pages: PageReport[];
  videos: VideoCheck[];
  links: { checked: number; external: number; broken: BrokenLink[] };
  summary: Summary;
}
export interface Summary {
  pages: number; views: number; changedViews: number; videosOk: number; videosTotal: number;
  consoleErrors: number; failedRequests: number; brokenLinks: number; denylistHits: number;
}

// ---------- deny-list ----------
export interface DenyPattern { line: number; source: string }
/** One case-insensitive ECMAScript regex per line; `#` comments and blank lines are skipped (contract/vendor/denylist.txt FORMAT). */
export function parseDenylist(text: string): DenyPattern[] {
  const out: DenyPattern[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith("#")) return;
    new RegExp(l, "i"); // throws on an invalid entry — fail loudly, never skip a rule
    out.push({ line: i + 1, source: l });
  });
  return out;
}
/** Line numbers of the deny-list entries that match `text`. */
export function scanText(patterns: DenyPattern[], text: string): number[] {
  return patterns.filter((p) => new RegExp(p.source, "i").test(text)).map((p) => p.line);
}
/** Replace every deny-listed match with █ so console/network text can be shown in a PR without leaking a banned name. */
export function redact(patterns: DenyPattern[], text: string): string {
  let t = text;
  for (const p of patterns) t = t.replace(new RegExp(p.source, "gi"), (m) => "█".repeat(Math.min(m.length, 8)));
  return t;
}

// ---------- capture helpers ----------
export function summarize(r: Omit<Rundown, "summary">): Summary {
  const views = r.pages.flatMap((p) => p.views);
  return {
    pages: r.pages.length,
    views: views.length,
    changedViews: views.filter((v) => v.changed).length,
    videosOk: r.videos.filter((v) => v.ok).length,
    videosTotal: r.videos.length,
    consoleErrors: r.pages.reduce((n, p) => n + p.console.length, 0),
    failedRequests: r.pages.reduce((n, p) => n + p.failedRequests.length, 0),
    brokenLinks: r.links.broken.length,
    denylistHits: r.pages.reduce((n, p) => n + p.denylist.length, 0),
  };
}
/** A stable key for a page section: its id, else aria-label, else its first heading, else its position. */
export function sectionKey(s: { id?: string | null; label?: string | null; heading?: string | null }, index: number): string {
  const pick = (s.id || s.label || (s.heading || "").replace(/\s+/g, " ").trim().slice(0, 48) || "").trim();
  return pick ? pick : `section ${index + 1}`;
}
/** Pair head/base sections by key (keys repeated on a page get a #n suffix); unmatched ones pair with null. */
export function pairSections<T extends { key: string }>(head: T[], base: T[]): Array<{ key: string; head: T | null; base: T | null }> {
  const uniq = (xs: T[]) => { const seen = new Map<string, number>(); return xs.map((x) => { const n = (seen.get(x.key) || 0) + 1; seen.set(x.key, n); return { k: n > 1 ? `${x.key} #${n}` : x.key, x }; }); };
  const h = uniq(head), b = uniq(base);
  const bm = new Map(b.map((e) => [e.k, e.x]));
  const out = h.map((e) => ({ key: e.k, head: e.x, base: bm.get(e.k) ?? null }));
  for (const e of b) if (!h.some((x) => x.k === e.k)) out.push({ key: e.k, head: null, base: e.x });
  return out;
}
/** Shot file name: <page slug>-<viewport>-<head|base>[-s<n>].jpg */
export function shotName(path: string, viewport: number, side: "head" | "base", section?: number): string {
  const slug = path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
  return `shots/${slug}-${viewport}-${side}${section === undefined ? "" : `-s${section + 1}`}.jpg`;
}

// ---------- validation ----------
export function validateRundown(x: unknown): Rundown {
  const r = x as Rundown;
  const fail = (m: string): never => { throw new Error(`rundown.json: ${m}`); };
  if (!r || typeof r !== "object") fail("not an object");
  if (r.schema !== SCHEMA) fail(`schema must be ${SCHEMA}, got ${JSON.stringify(r.schema)}`);
  if (!r.head?.image) fail("head.image missing");
  if (!Array.isArray(r.viewports) || !r.viewports.every((v) => Number.isInteger(v) && v > 0)) fail("viewports must be positive integers");
  if (!Array.isArray(r.pages) || !Array.isArray(r.videos) || !r.links || !Array.isArray(r.links.broken)) fail("pages/videos/links missing");
  for (const p of r.pages) {
    if (typeof p.path !== "string" || !p.path.startsWith("/")) fail(`page path ${JSON.stringify(p.path)} must start with /`);
    for (const v of p.views) {
      for (const s of [v.head, v.base, ...v.sections.flatMap((x) => [x.head, x.base])]) {
        if (s && !/^shots\/[a-z0-9._-]+\.(jpg|png)$/.test(s.path)) fail(`shot path ${JSON.stringify(s.path)} is outside shots/`);
      }
    }
    for (const d of p.denylist) if (!Number.isInteger(d.line) || typeof d.where !== "string") fail("denylist hits are {line, where}");
  }
  return r;
}

// ---------- assets branch ----------
/** One orphan branch per PR, rewritten (parentless commit) on every run and deleted when the PR closes: no history growth, no races. */
export function assetsBranch(prefix: string, pr: number): string {
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) throw new Error(`assets-branch-prefix ${JSON.stringify(prefix)} must be [A-Za-z0-9._-]+`);
  return `${prefix}${pr}`;
}
export function assetUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}?raw=true`;
}
/** Every shot path a rundown references (what publish uploads). */
export function referencedShots(r: Rundown): string[] {
  const s = new Set<string>();
  for (const p of r.pages) for (const v of p.views) for (const x of [v.head, v.base, ...v.sections.flatMap((y) => [y.head, y.base])]) if (x) s.add(x.path);
  return [...s].sort();
}

// ---------- failure policy ----------
export type FailOn = "denylist" | "video" | "links" | "console" | "requests";
export function parseFailOn(s: string): FailOn[] {
  const all: FailOn[] = ["denylist", "video", "links", "console", "requests"];
  const xs = s.split(",").map((x) => x.trim()).filter(Boolean);
  for (const x of xs) if (!all.includes(x as FailOn)) throw new Error(`fail-on: unknown ${JSON.stringify(x)} (allowed: ${all.join(", ")})`);
  return xs as FailOn[];
}
export function failures(r: Rundown, on: FailOn[]): string[] {
  const s = r.summary, out: string[] = [];
  if (on.includes("denylist") && s.denylistHits) out.push(`${s.denylistHits} deny-list hit(s) on the rendered pages`);
  if (on.includes("video") && s.videosOk < s.videosTotal) out.push(`${s.videosTotal - s.videosOk} video(s) failed their check`);
  if (on.includes("links") && s.brokenLinks) out.push(`${s.brokenLinks} broken internal link(s)`);
  if (on.includes("console") && s.consoleErrors) out.push(`${s.consoleErrors} console error(s)`);
  if (on.includes("requests") && s.failedRequests) out.push(`${s.failedRequests} failed request(s)`);
  return out;
}

// ---------- the sticky PR comment ----------
export interface RenderOpts { url: (path: string) => string; runUrl: string; headSha: string; artifact: string; failed: string[] }
const pct = (x: number | null) => (x === null ? "—" : x === 0 ? "0%" : x < 0.001 ? "<0.1%" : `${(x * 100).toFixed(1)}%`);
const esc = (s: string) => s.replace(/[|<>]/g, (c) => ({ "|": "\\|", "<": "&lt;", ">": "&gt;" })[c] as string);
const img = (o: RenderOpts, s: Shot | null, w: number, alt: string) => (s ? `<a href="${o.url(s.path)}"><img src="${o.url(s.path)}" width="${w}" alt="${esc(alt)}"></a>` : "—");

export function renderComment(r: Rundown, o: RenderOpts): string {
  const s = r.summary;
  const ok = (b: boolean) => (b ? "✅" : "❌");
  const L: string[] = [MARKER, `## 📸 PR rundown — \`${o.headSha.slice(0, 7)}\`${r.base ? ` vs \`${r.base.label}\`` : " (no baseline image found)"}`, ""];
  L.push(
    `| Pages | Views | Changed | Videos | Console errors | Failed requests | Broken links | Deny-list |`,
    `|---|---|---|---|---|---|---|---|`,
    `| ${s.pages} | ${s.views} (${r.viewports.join(" / ")} px) | **${r.base ? s.changedViews : "n/a"}** | ${ok(s.videosOk === s.videosTotal)} ${s.videosOk}/${s.videosTotal} | ${s.consoleErrors} | ${s.failedRequests} | ${ok(!s.brokenLinks)} ${s.brokenLinks} | ${ok(!s.denylistHits)} ${s.denylistHits} |`,
    "",
  );
  if (o.failed.length) L.push(`> [!CAUTION]`, ...o.failed.map((f) => `> ${f}`), "");

  const changed = r.pages.flatMap((p) => p.views.filter((v) => v.changed).map((v) => ({ p, v })));
  if (r.base) {
    L.push(`### What changed (before = \`${r.base.label}\`, after = this PR)`, "");
    if (!changed.length) L.push(`No visual change at ${r.viewports.join(" / ")} px on ${s.pages} page(s) (threshold ${pct(r.threshold)} of pixels).`, "");
    for (const { p, v } of changed) {
      const title = `<code>${esc(p.path)}</code> · ${v.viewport} px · ${pct(v.diffRatio)} of pixels${v.baseHeight !== null && v.baseHeight !== v.headHeight ? ` · height ${v.baseHeight} → ${v.headHeight}` : ""}${p.inBase ? "" : " · new page"}`;
      L.push(`<details open><summary>${title}</summary>`, "");
      const secs = v.sections.filter((x) => x.changed && (x.head || x.base));
      if (secs.length) {
        L.push(`| Section | Before | After |`, `|---|---|---|`);
        for (const x of secs) L.push(`| ${esc(x.key)} (${pct(x.diffRatio)}) | ${img(o, x.base, 360, `before: ${x.key}`)} | ${img(o, x.head, 360, `after: ${x.key}`)} |`);
        L.push("");
      }
      L.push(`| Full page before | Full page after |`, `|---|---|`, `| ${img(o, v.base, 300, `before ${p.path} ${v.viewport}`)} | ${img(o, v.head, 300, `after ${p.path} ${v.viewport}`)} |`, "", `</details>`, "");
    }
  }
  const all = r.pages.flatMap((p) => p.views.filter((v) => v.head).map((v) => ({ p, v })));
  if (all.length) {
    L.push(`<details${r.base ? "" : " open"}><summary>Every page in this PR (${all.length} screenshots)</summary>`, "", `| Page | ${r.viewports.map((w) => `${w} px`).join(" | ")} |`, `|---|${r.viewports.map(() => "---").join("|")}|`);
    for (const p of r.pages) L.push(`| <code>${esc(p.path)}</code> ${esc(p.title)} | ${r.viewports.map((w) => { const v = p.views.find((x) => x.viewport === w); return img(o, v?.head ?? null, w >= 1000 ? 220 : 120, `${p.path} ${w}`); }).join(" | ")} |`);
    L.push("", `</details>`, "");
  }

  const vbad = r.videos.filter((v) => !v.ok);
  L.push(`<details${vbad.length ? " open" : ""}><summary>Videos ${ok(!vbad.length)} ${s.videosOk}/${s.videosTotal}</summary>`, "", `| Page | Video | Autoplay | Muted | HTTP | Plays | Result |`, `|---|---|---|---|---|---|---|`);
  for (const v of r.videos) L.push(`| <code>${esc(v.page)}</code> | <code>${esc(v.src.replace(/^https?:\/\/[^/]+/, ""))}</code> | ${v.autoplay ? (v.autoplaying ? "▶︎ playing" : "⏸ not playing") : "no"} | ${v.muted ? "yes" : "no"} | ${v.status} | ${v.playable ? "yes" : "no"} | ${v.ok ? "✅" : `❌ ${esc(v.problem)}`} |`);
  L.push("", `</details>`, "");

  const issues = r.pages.filter((p) => p.console.length || p.failedRequests.length || p.denylist.length);
  if (issues.length || r.links.broken.length) {
    L.push(`<details open><summary>Problems found</summary>`, "");
    for (const p of issues) {
      L.push(`**<code>${esc(p.path)}</code>**`);
      for (const d of p.denylist) L.push(`- deny-list line ${d.line} matched in \`${d.where.replace(/`/g, "'")}\``);
      for (const c of p.console.slice(0, 10)) L.push(`- console: \`${c.slice(0, 200).replace(/`/g, "'")}\``);
      for (const f of p.failedRequests.slice(0, 10)) L.push(`- request: \`${f.slice(0, 200).replace(/`/g, "'")}\``);
      L.push("");
    }
    for (const b of r.links.broken.slice(0, 20)) L.push(`- broken link on <code>${esc(b.from)}</code> → <code>${esc(b.href)}</code> (${b.status})`);
    L.push("", `</details>`, "");
  }
  L.push(`Internal links checked: ${r.links.checked} · external (not fetched): ${r.links.external} · machine-readable: \`rundown.json\` in the run artifact **${o.artifact}** · [run](${o.runUrl})`);
  let md = L.join("\n");
  if (md.length > COMMENT_MAX) md = md.slice(0, COMMENT_MAX - 200) + `\n\n… truncated — the full rundown is in the [run](${o.runUrl}) artifact **${o.artifact}**.`;
  return md;
}
