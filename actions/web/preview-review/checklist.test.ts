import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, parseRules, sections, render } from "./checklist.ts";

test("glob: ** spans directories, * stays in one segment", () => {
  assert.ok(globToRegExp("public/film/**").test("public/film/hero-loop.mp4"));
  assert.ok(globToRegExp("public/film/**").test("public/film/a/b.jpg"));
  assert.ok(!globToRegExp("public/film/**").test("public/filmx/a.mp4"));
  assert.ok(globToRegExp("src/**/*.tsx").test("src/components/media/FilmPlayer.tsx"));
  assert.ok(globToRegExp("src/**/*.tsx").test("src/page.tsx"));
  assert.ok(!globToRegExp("src/*.tsx").test("src/a/b.tsx"));
  assert.ok(globToRegExp("server/static.mjs").test("server/static.mjs"));
  assert.ok(!globToRegExp("server/static.mjs").test("server/staticXmjs"));
});

test("rules: validated", () => {
  assert.throws(() => parseRules('{"rules": {}}'));
  assert.throws(() => parseRules('{"rules": [{"name": "x"}]}'));
  assert.equal(parseRules('{"rules": []}').rules.length, 0);
});

const rules = parseRules(JSON.stringify({
  title: "Visual LGTM",
  rules: [
    { name: "Film", globs: ["public/film/**"], items: ["hero loop plays", "the 14 s transition"] },
    { name: "Sections", globs: ["src/content/**", "src/components/sections/**"], items: ["the touched sections render"] },
  ],
  generic: ["mobile / iOS Safari", "no CSP errors in the console"],
}));

test("sections: only matching rules, with their files, in rule order", () => {
  const s = sections(rules, ["public/film/planeo-glide.mp4", "README.md", "src/content/home.ts"]);
  assert.deepEqual(s.map((x) => x.name), ["Film", "Sections"]);
  assert.deepEqual(s[0].files, ["public/film/planeo-glide.mp4"]);
  assert.equal(sections(rules, ["README.md"]).length, 0);
});

test("render: URL, image, SHA, checklist and the generic list", () => {
  const md = render(rules, sections(rules, ["public/film/a.mp4"]), {
    url: "https://landing-pr16.platform.planeo.dev", image: "ghcr.io/o/r/pr/16:head-abc", headSha: "abc",
    environment: "website-preview", ready: "✅ image pushed", changedCount: 1,
  });
  assert.match(md, /\*\*Preview:\*\* https:\/\/landing-pr16\.platform\.planeo\.dev/);
  assert.match(md, /`ghcr\.io\/o\/r\/pr\/16:head-abc`/);
  assert.match(md, /- \[ \] the 14 s transition/);
  assert.match(md, /- \[ \] mobile \/ iOS Safari/);
  assert.match(md, /visual LGTM/);
  assert.match(render(rules, [], { url: "u", image: "i", headSha: "s", environment: "e", ready: "r", changedCount: 3 }), /No checklist rule matches the 3/);
});

test("render: long file lists are truncated", () => {
  const files = Array.from({ length: 12 }, (_, i) => `public/film/f${i}.mp4`);
  assert.match(render(rules, sections(rules, files), { url: "u", image: "i", headSha: "s", environment: "e", ready: "r", changedCount: 12 }), /and 4 more/);
});

import { splitImage } from "./prepare.ts";
test("splitImage: registry / name / tag", () => {
  assert.deepEqual(splitImage("ghcr.io/planeodev/website/pr/16:head-abc"), { registry: "ghcr.io", name: "planeodev/website/pr/16", tag: "head-abc" });
  assert.throws(() => splitImage("website:latest"));
  assert.throws(() => splitImage("ghcr.io/a/b@sha256:00"));
});
