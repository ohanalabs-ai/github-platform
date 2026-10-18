import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { badgeUrl, detectCoverageFormat, health, overall, parseCobertura, parseCoverage, parseGoCover, parseJaCoCo, parseLcov, parseThresholds, renderCoverageMarkdown } from "./coverage.ts";
import { coverageOutputs } from "./report.ts";

const fixture = (p: string) => readFileSync(new URL(`../fixtures/coverage/${p}`, import.meta.url), "utf8");
const T = { low: 70, high: 85 };

test("cobertura (coverage.py): packages from class lines (not method lines), branch conditions, root totals", () => {
  const r = parseCobertura(fixture("cobertura-coveragepy.xml"), "coverage.xml");
  assert.deepEqual(r.groups.map((g) => [g.name, g.linesCovered, g.linesValid, g.branchesCovered, g.branchesValid]), [
    ["app", 5, 6, 3, 4],
    ["app.db", 3, 4, 0, 0],
  ]);
  assert.equal(r.groups[1].branchRate, null); // no branch data — not a misleading 0%
  assert.deepEqual([r.totals.linesCovered, r.totals.linesValid, r.totals.lineRate], [8, 10, 0.8]);
  assert.equal(r.totals.branchRate, 0.75);
  assert.equal(r.totals.complexity, 0);
});

test("cobertura with only rates (no <line>s) falls back to the attributes", () => {
  const r = parseCobertura(`<coverage line-rate="0.5" branch-rate="0.25"><packages><package name="p" line-rate="0.5" branch-rate="0.25" complexity="3"/></packages></coverage>`, "c.xml");
  assert.equal(r.groups[0].lineRate, 0.5);
  assert.equal(r.groups[0].branchRate, 0.25);
  assert.equal(r.totals.lineRate, 0.5);
});

test("jacoco: package and report counters, DOCTYPE skipped, slashes → dots", () => {
  const r = parseJaCoCo(fixture("jacoco.xml"), "jacoco.xml");
  assert.deepEqual(r.groups.map((g) => [g.name, g.linesCovered, g.linesValid, g.complexity]), [
    ["dev.planeo", 8, 10, 5],
    ["dev.planeo.util", 5, 10, 4],
  ]);
  assert.equal(r.groups[1].branchRate, null);
  assert.deepEqual([r.totals.linesCovered, r.totals.linesValid, r.totals.branchesCovered, r.totals.branchesValid, r.totals.complexity], [13, 20, 3, 4, 9]);
});

test("lcov: LF/LH when present, DA/BRDA counted otherwise, grouped by directory", () => {
  const r = parseLcov(fixture("lcov.info"), "lcov.info");
  assert.deepEqual(r.groups.map((g) => [g.name, g.linesCovered, g.linesValid, g.branchesCovered, g.branchesValid]), [
    ["server", 5, 6, 1, 2],
    ["lib", 2, 4, 1, 2],
  ]);
  assert.deepEqual([r.totals.linesCovered, r.totals.linesValid, r.totals.lineRate], [7, 10, 0.7]);
});

test("go coverprofile: statements per package, merged duplicate blocks keep the max count", () => {
  const r = parseGoCover(fixture("go-cover.out"), "cover.out");
  assert.deepEqual(r.groups.map((g) => [g.name, g.linesCovered, g.linesValid, g.branchRate]), [
    ["api", 4, 5, null],
    ["store", 3, 4, null],
  ]);
  assert.deepEqual([r.totals.linesCovered, r.totals.linesValid], [7, 9]);
});

test("format detection", () => {
  assert.equal(detectCoverageFormat(fixture("cobertura-coveragepy.xml")), "cobertura");
  assert.equal(detectCoverageFormat(fixture("jacoco.xml")), "jacoco");
  assert.equal(detectCoverageFormat(fixture("lcov.info")), "lcov");
  assert.equal(detectCoverageFormat(fixture("go-cover.out")), "go");
  assert.throws(() => detectCoverageFormat("hello"), /unknown coverage format/);
  assert.throws(() => parseCoverage("<testsuites/>", "x.xml", "cobertura"), /not a Cobertura report/);
});

test("thresholds, health and the irongut-style badge", () => {
  assert.deepEqual(parseThresholds("70 85"), { low: 70, high: 85 });
  assert.deepEqual(parseThresholds("60"), { low: 60, high: 60 });
  assert.deepEqual(parseThresholds(""), { low: 50, high: 75 });
  assert.throws(() => parseThresholds("90 80"), /low ≤ high/);
  assert.equal(health(0.9, T), "healthy");
  assert.equal(health(0.8, T), "warning");
  assert.equal(health(0.5, T), "unhealthy");
  assert.equal(health(null, T), "unknown");
  assert.equal(badgeUrl(0.8, T), "https://img.shields.io/badge/Code%20Coverage-80%25-yellow?style=flat");
  assert.equal(badgeUrl(0.9, T), "https://img.shields.io/badge/Code%20Coverage-90%25-success?style=flat");
});

test("overall: several reports sum their line counts", () => {
  const all = overall([parseLcov(fixture("lcov.info"), "a"), parseGoCover(fixture("go-cover.out"), "b")]);
  assert.deepEqual([all.linesCovered, all.linesValid], [14, 19]);
});

test("markdown: badge, per-package table with summary row, health legend", () => {
  const md = renderCoverageMarkdown([parseCobertura(fixture("cobertura-coveragepy.xml"), "build/coverage.xml")], [], { title: "☂️ Code coverage", thresholds: T });
  assert.match(md, /^## ☂️ Code coverage — 80% ➖/);
  assert.match(md, /!\[Code Coverage\]\(https:\/\/img\.shields\.io\/badge\/Code%20Coverage-80%25-yellow/);
  assert.match(md, /\| Package \| Line rate \| Branch rate \| Complexity \| Health \|/);
  assert.match(md, /\| app \| 83\.33% \(5\/6\) \| 75% \(3\/4\) \| 0 \| ➖ \|/);
  assert.match(md, /\| app\.db \| 75% \(3\/4\) \| — \| 0 \| ➖ \|/);
  assert.match(md, /\| \*\*Summary\*\* \| \*\*80% \(8\/10\)\*\* \| \*\*75% \(3\/4\)\*\* \| \*\*0\*\* \| ➖ \|/);
  assert.match(md, /❌ below 70% · ➖ 70–85% · ✅ 85% and above/);
});

test("markdown: a Go report has no branch / complexity columns; no reports renders a placeholder", () => {
  const md = renderCoverageMarkdown([parseGoCover(fixture("go-cover.out"), "cover.out")], [], { title: "C", thresholds: T, badge: false });
  assert.match(md, /\| Package \| Line rate \| Health \|/);
  assert.doesNotMatch(md, /shields\.io/);
  assert.match(renderCoverageMarkdown([], ["x.xml: XML: unclosed <a>"], { title: "C", thresholds: T }), /⚪ no coverage report[\s\S]*Unreadable reports \(1\)/);
});

test("outputs: rates as percentages, health, below-min", () => {
  const r = parseCobertura(fixture("cobertura-coveragepy.xml"), "c.xml");
  const o = coverageOutputs(r.totals, T, ["/w/c.xml"], true);
  assert.equal(o["line-rate"], "80.00");
  assert.equal(o["branch-rate"], "75.00");
  assert.equal(o.health, "warning");
  assert.equal(o["below-min"], "false");
  assert.equal(coverageOutputs(r.totals, { low: 90, high: 95 }, [], true)["below-min"], "true");
  assert.equal(coverageOutputs(r.totals, T, [], false).health, "unknown");
});

test("markdown: the per-report heading uses <code>, never backticks (Markdown is not rendered inside <summary>)", () => {
  const reports = [parseGoCover(fixture("go-cover.out"), "actions/test/fixtures/coverage/go-cover.out")];
  for (const collapse of [true, false]) {
    const md = renderCoverageMarkdown(reports, [], { title: "C", thresholds: T, badge: false, collapse });
    assert.match(md, /<code>actions\/test\/fixtures\/coverage\/go-cover\.out<\/code> \(go\) — 77\.78% ➖/);
    assert.doesNotMatch(md, /`actions\/test\/fixtures/);
  }
  const collapsed = renderCoverageMarkdown(reports, [], { title: "C", thresholds: T, badge: false, collapse: true });
  assert.match(collapsed, /<summary><code>actions\/test\/fixtures\/coverage\/go-cover\.out<\/code> \(go\) — 77\.78% ➖<\/summary>/);
});
