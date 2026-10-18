import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aggregate, detectTestFormat, parseJUnit, parseTap, parseTestReport, renderTestMarkdown, renderWithin, verdict } from "./junit.ts";
import { annotationsFor, outputsFor } from "./report.ts";

const fixture = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

test("chainsaw JUNIT-TEST (v0.2.15, real run): one case per test, time=\"\" suites, message-attribute failure", () => {
  const r = parseJUnit(fixture("junit/chainsaw-junit-test.xml"), "chainsaw-junit-test.xml");
  assert.equal(r.cases.length, 2);
  assert.deepEqual(r.cases.map((c) => [c.suite, c.name, c.status]), [
    ["/tests/pass-cm", "configmap-roundtrip", "passed"],
    ["/tests/fail-cm", "configmap-wrong-value", "failed"],
  ]);
  assert.match(r.cases[1].message, /\* data\.key: Invalid value: "value": Expected value: "other"\n/);
  assert.match(r.cases[1].message, /-  key: other\n\+  key: value/);
  assert.equal(r.duration, 10.294714); // root time — the suites' time="" are skipped
});

test("chainsaw JUNIT-STEP: steps (incl. cleanup) are the cases, suites are the tests", () => {
  const r = aggregate([parseJUnit(fixture("junit/chainsaw-junit-step.xml"), "s.xml")]);
  assert.equal(r.totals.total, 6);
  assert.equal(r.totals.failed, 1);
  assert.deepEqual(r.suites.map((s) => s.name), ["configmap-roundtrip", "configmap-wrong-value"]);
  assert.equal(r.cases.find((c) => c.status === "failed")?.name, "assert-mismatch");
  assert.equal(r.conclusion, "failure");
});

test("chainsaw JUNIT-OPERATION: operation type is the classname", () => {
  const r = parseJUnit(fixture("junit/chainsaw-junit-operation.xml"), "o.xml");
  assert.equal(r.cases.length, 8);
  const failed = r.cases.find((c) => c.status === "failed");
  assert.equal(failed?.classname, "assert");
  assert.equal(failed?.name, "assert-mismatch / operation 2");
});

test("chainsaw upstream testdata: skipped cases and no XML prolog", () => {
  const r = aggregate([parseJUnit(fixture("junit/chainsaw-upstream-junit-test-skipped.xml"), "u.xml")]);
  assert.deepEqual([r.totals.total, r.totals.failed, r.totals.skipped], [2, 1, 1]);
  assert.equal(r.cases[0].message, "dummy");
});

test("pytest: failure body + error + skipped, file/line kept for annotations", () => {
  const r = aggregate([parseJUnit(fixture("junit/pytest.xml"), "pytest.xml")]);
  assert.deepEqual(r.totals, { total: 5, passed: 2, failed: 1, errors: 1, skipped: 1 });
  const f = r.cases.find((c) => c.status === "failed");
  assert.equal(f?.message, "AssertionError: assert 404 == 204");
  assert.match(f?.details || "", />\s+assert client\.delete/);
  assert.equal(f?.file, "tests/test_api.py");
  assert.equal(f?.line, 31);
  const a = annotationsFor(r);
  assert.equal(a.length, 2);
  assert.deepEqual([a[0].path, a[0].start_line, a[0].annotation_level], ["tests/test_api.py", 31, "failure"]);
  assert.equal(r.duration, 1.234);
});

test("surefire: single <testsuite> root, namespaces, CDATA failure body", () => {
  const r = parseJUnit(fixture("junit/surefire.xml"), "TEST-x.xml");
  assert.equal(r.suites[0].name, "dev.planeo.CalculatorTest");
  const f = r.cases.find((c) => c.status === "failed");
  assert.equal(f?.message, "expected: <Infinity> but was: <NaN>");
  assert.match(f?.details || "", /CalculatorTest\.java:27/);
});

test("TAP 13: ok / not ok / SKIP / TODO, YAML diagnostics", () => {
  const r = parseTap(fixture("tap/node-test.tap"), "out/node-test.tap");
  assert.deepEqual(r.cases.map((c) => c.status), ["passed", "failed", "skipped", "skipped"]);
  assert.equal(r.cases[1].message, "Expected values to be strictly equal");
  assert.match(r.cases[1].details, /failureType/);
  assert.equal(r.cases[1].time, 0.01225);
  assert.equal(r.cases[2].message, "no token in CI");
  assert.equal(r.cases[0].suite, "node-test.tap");
});

test("format detection and the non-JUnit root error", () => {
  assert.equal(detectTestFormat("<testsuites/>"), "junit");
  assert.equal(detectTestFormat("TAP version 14\nok 1"), "tap");
  assert.equal(detectTestFormat("1..2\nok 1\nok 2"), "tap");
  assert.equal(parseTestReport("ok 1 - a", "x.tap").format, "tap");
  assert.throws(() => parseJUnit("<coverage/>", "c.xml"), /not a JUnit report \(root element <coverage>\)/);
});

test("aggregate: verdicts and conclusions", () => {
  assert.equal(aggregate([]).conclusion, "neutral");
  assert.equal(verdict(aggregate([])), "⚪ no test cases found");
  const ok = aggregate([parseTap("ok 1 - a\nok 2 - b", "t.tap")]);
  assert.equal(ok.conclusion, "success");
  assert.equal(verdict(ok), "✅ 2 passed");
  const unreadable = aggregate([parseTap("ok 1 - a", "t.tap")], ["bad.xml: XML: unclosed <a>"]);
  assert.equal(unreadable.conclusion, "failure");
  assert.match(verdict(unreadable), /1 unreadable/);
});

test("markdown: counts, the command, failures with their message, suite + case tables", () => {
  const r = aggregate([parseJUnit(fixture("junit/chainsaw-junit-step.xml"), "reports/chainsaw-JUNIT-STEP.xml")]);
  const md = renderTestMarkdown(r, { title: "✅ Chainsaw", command: "chainsaw test --report-format JUNIT-STEP", collapse: true });
  assert.match(md, /^## ✅ Chainsaw — ❌ 1 failed/);
  assert.match(md, /\| 6 \| 5 \| 1 \| 0 \| 0 \| 10\.2s \|/);
  assert.match(md, /```shell\nchainsaw test --report-format JUNIT-STEP\n```/);
  assert.match(md, /### ❌ Failures \(1\)/);
  assert.match(md, /<code>configmap-wrong-value › assert-mismatch<\/code>/);
  assert.match(md, /Expected value: "other"/);
  assert.match(md, /<summary>Suites \(2\)<\/summary>/);
  assert.match(md, /<summary>All test cases \(6\)<\/summary>/);
  assert.match(md, /`reports\/chainsaw-JUNIT-STEP\.xml` \(junit\)/);
});

test("markdown: a backtick fence in a failure body cannot break out of its code block", () => {
  const r = aggregate([parseJUnit(`<testsuite name="s"><testcase name="t"><failure message="a"><![CDATA[x \`\`\` y]]></failure></testcase></testsuite>`, "x.xml")]);
  assert.match(renderTestMarkdown(r, { title: "T" }), /````text\na\n\nx ``` y\n````/);
});

test("renderWithin: sheds passing cases first to fit a PR comment", () => {
  const many = Array.from({ length: 3000 }, (_, i) => `<testcase classname="c" name="passing-case-number-${i}" time="0.01"/>`).join("");
  const r = aggregate([parseJUnit(`<testsuite name="big">${many}<testcase name="broken"><failure message="boom"/></testcase></testsuite>`, "big.xml")]);
  const full = renderTestMarkdown(r, { title: "T", maxCases: 5000 });
  assert.ok(full.length > 65000);
  const fit = renderWithin(r, { title: "T", collapse: true, maxCases: 5000 }, 65000);
  assert.ok(fit.length <= 65000);
  assert.match(fit, /Passing test cases were omitted/);
  assert.match(fit, /broken/);
  assert.doesNotMatch(fit, /passing-case-number-1\b/);
});

test("outputs: counts, conclusion and the matched files", () => {
  const r = aggregate([parseJUnit(fixture("junit/pytest.xml"), "pytest.xml")]);
  assert.deepEqual(outputsFor(r, ["/w/a.xml", "/w/b.xml"]), {
    total: "5", passed: "2", failed: "1", errors: "1", skipped: "1", duration: "1.234",
    conclusion: "failure", files: "2", "file-list": "/w/a.xml\n/w/b.xml",
  });
});
