import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MARKER, SCHEMA, COMMENT_MAX, parseDenylist, scanText, redact, sectionKey, pairSections, shotName, summarize, validateRundown,
  assetsBranch, assetUrl, referencedShots, parseFailOn, failures, renderComment, type Rundown,
} from "./rundown.ts";

const DENY = "# header\n\n\\bacme\\b\n# more\nwidget\\.example\\.com\n";

test("deny-list: comments/blank lines skipped, 1-based line numbers, invalid regex throws", () => {
  const p = parseDenylist(DENY);
  assert.deepEqual(p.map((x) => x.line), [3, 5]);
  assert.throws(() => parseDenylist("ok\n(unclosed\n"));
});

test("deny-list: scan is case-insensitive and word-bounded as written; redact never leaks the term", () => {
  const p = parseDenylist(DENY);
  assert.deepEqual(scanText(p, "Built on ACME tech"), [3]);
  assert.deepEqual(scanText(p, "acmeish"), []);
  assert.deepEqual(scanText(p, "GET https://widget.example.com/x"), [5]);
  const r = redact(p, "Acme failed at widget.example.com");
  assert.ok(!/acme/i.test(r) && !/widget\.example/.test(r));
  assert.match(r, /█/);
});

test("sections: key falls back id → aria-label → heading → position; duplicates get #n; unmatched pair with null", () => {
  assert.equal(sectionKey({ id: "film" }, 0), "film");
  assert.equal(sectionKey({ label: "Hero" }, 0), "Hero");
  assert.equal(sectionKey({ heading: "  A   day\nwith Planeo " }, 0), "A day with Planeo");
  assert.equal(sectionKey({}, 4), "section 5");
  const pairs = pairSections([{ key: "a" }, { key: "x" }, { key: "x" }, { key: "new" }], [{ key: "a" }, { key: "x" }, { key: "gone" }]);
  assert.deepEqual(pairs.map((p) => [p.key, Boolean(p.head), Boolean(p.base)]), [["a", true, true], ["x", true, true], ["x #2", true, false], ["new", true, false], ["gone", false, true]]);
});

test("shot names stay inside shots/ and are slugged", () => {
  assert.equal(shotName("/", 1440, "head"), "shots/home-1440-head.jpg");
  assert.equal(shotName("/solutions/fintech/", 390, "base", 2), "shots/solutions-fintech-390-base-s3.jpg");
  assert.equal(shotName("/../../etc", 390, "head"), "shots/etc-390-head.jpg");
});

const shot = (path: string) => ({ path, width: 1440, height: 900 });
function sample(over: Partial<Rundown> = {}): Rundown {
  const base: Omit<Rundown, "summary"> = {
    schema: SCHEMA, generatedAt: "2026-11-21T00:00:00Z",
    head: { image: "ghcr.io/o/web/pr/9:head-abc", label: "PR #9 @ abc1234" }, base: { image: "ghcr.io/o/web:develop-1234567", label: "develop-1234567" },
    viewports: [390, 1440], threshold: 0.001,
    pages: [
      { path: "/", title: "Home", inBase: true, console: [], failedRequests: [], denylist: [], views: [
        { viewport: 1440, head: shot("shots/home-1440-head.jpg"), base: shot("shots/home-1440-base.jpg"), headHeight: 5000, baseHeight: 4000, diffRatio: 0.2, changed: true,
          sections: [{ key: "Hero", diffRatio: 0.5, changed: true, head: shot("shots/home-1440-head-s1.jpg"), base: shot("shots/home-1440-base-s1.jpg") }, { key: "Quiet", diffRatio: 0, changed: false, head: null, base: null }] },
        { viewport: 390, head: shot("shots/home-390-head.jpg"), base: null, headHeight: 7000, baseHeight: 7000, diffRatio: 0, changed: false, sections: [] },
      ] },
      { path: "/evidence", title: "Evidence", inBase: true, console: ["boom"], failedRequests: [], denylist: [{ line: 3, where: "section 2 > p" }], views: [] },
    ],
    videos: [{ page: "/", src: "/film/a.mp4", autoplay: true, muted: true, status: 206, autoplaying: true, playable: true, ok: true, problem: "" },
      { page: "/", src: "/film/b.mp4", autoplay: true, muted: false, status: 206, autoplaying: true, playable: true, ok: false, problem: "autoplays with sound" }],
    links: { checked: 7, external: 2, broken: [{ from: "/", href: "/nope", status: 404 }] },
  };
  const r = { ...base, ...over } as Omit<Rundown, "summary">;
  return { ...r, summary: summarize(r) };
}

test("summary counts views, changes, videos, problems", () => {
  const s = sample().summary;
  assert.deepEqual(s, { pages: 2, views: 2, changedViews: 1, videosOk: 1, videosTotal: 2, consoleErrors: 1, failedRequests: 0, brokenLinks: 1, denylistHits: 1 });
});

test("validate: schema, viewports, and every shot path confined to shots/", () => {
  assert.equal(validateRundown(JSON.parse(JSON.stringify(sample()))).schema, SCHEMA);
  assert.throws(() => validateRundown({ ...sample(), schema: "x" }), /schema/);
  const bad = sample(); bad.pages[0].views[0].head = shot("../../.github/workflows/x.yaml");
  assert.throws(() => validateRundown(bad), /outside shots/);
  assert.throws(() => validateRundown({ ...sample(), viewports: [0] }), /viewports/);
});

test("assets: per-PR branch name is validated; blob URLs are encoded and raw", () => {
  assert.equal(assetsBranch("pr-rundown-", 21), "pr-rundown-21");
  assert.throws(() => assetsBranch("bad/../", 1));
  assert.equal(assetUrl("o", "web", "pr-rundown-21", "shots/home-1440-head.jpg"), "https://github.com/o/web/blob/pr-rundown-21/shots/home-1440-head.jpg?raw=true");
  assert.deepEqual(referencedShots(sample()), ["shots/home-1440-base-s1.jpg", "shots/home-1440-base.jpg", "shots/home-1440-head-s1.jpg", "shots/home-1440-head.jpg", "shots/home-390-head.jpg"]);
});

test("fail-on: validated list; only the selected categories fail", () => {
  assert.throws(() => parseFailOn("denylist,typo"));
  assert.deepEqual(parseFailOn(""), []);
  const r = sample();
  assert.deepEqual(failures(r, parseFailOn("denylist,video")), ["1 deny-list hit(s) on the rendered pages", "1 video(s) failed their check"]);
  assert.equal(failures(r, []).length, 0);
});

const opts = { url: (p: string) => `https://x/${p}`, runUrl: "https://run", headSha: "abc1234def", artifact: "pr-rundown-9", failed: [] as string[] };

test("comment: sticky marker, before/after of changed sections and full pages, problems, never the deny-listed text", () => {
  const md = renderComment(sample(), opts);
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /vs `develop-1234567`/);
  assert.match(md, /<code>\/<\/code> · 1440 px · 20\.0% of pixels · height 4000 → 5000/);
  assert.match(md, /\| Hero \(50\.0%\) \| <a href="https:\/\/x\/shots\/home-1440-base-s1\.jpg">/);
  assert.ok(!md.includes("Quiet"), "unchanged sections are not listed");
  assert.match(md, /deny-list line 3 matched in `section 2 > p`/);
  assert.match(md, /❌ autoplays with sound/);
  assert.match(md, /broken link on <code>\/<\/code> → <code>\/nope<\/code> \(404\)/);
  assert.match(md, /Every page in this PR \(2 screenshots\)/);
});

test("comment: one cover screenshot of the landing page sits above the collapsed every-page grid", () => {
  const md = renderComment(sample(), opts);
  const cover = md.indexOf("### The landing page");
  const grid = md.lastIndexOf("<details", md.indexOf("<summary>Every page"));
  assert.ok(cover > 0 && cover < grid, "cover heading comes before the grid");
  const between = md.slice(cover, grid);
  assert.match(between, /<img src="https:\/\/x\/[^"]+" width="720" alt="\/ 1440 px \(this PR\)">/);
  assert.ok(!between.includes("<details"), "the cover is outside any collapsed block");
});

test("comment: no baseline → head-only grid open; failures shown; long output truncated", () => {
  const r = sample({ base: null });
  const md = renderComment(r, { ...opts, failed: ["1 deny-list hit(s)"] });
  assert.match(md, /no baseline image found/);
  assert.match(md, /<details open><summary>Every page/);
  assert.match(md, /> \[!CAUTION\]\n> 1 deny-list hit/);
  const big = sample();
  big.pages[1].console = Array.from({ length: 10 }, () => "x".repeat(200));
  for (let i = 0; i < 400; i++) big.links.broken.push({ from: "/" + "p".repeat(150), href: "/q", status: 404 });
  big.pages.push(...Array.from({ length: 300 }, (_, i) => ({ ...big.pages[0], path: `/p${i}` })));
  assert.ok(renderComment(big, opts).length <= COMMENT_MAX);
});
