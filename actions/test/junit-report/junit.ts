// ✅ Test-report model, parsers and markdown — pure functions (unit-tested in junit.test.ts).
//
// Formats (what the old ohanalabs-ai/ohana-github docker-compose-devsecops-test-workflow.yaml rendered —
// its own python table over JUnit XML, plus test-summary/test-summary-action, which reads JUnit XML and TAP):
//   junit  JUnit XML — a <testsuites> or a single <testsuite> root, nested suites, <failure>/<error>/<skipped>
//          with the text in the `message` attribute, the body (incl. CDATA) or both. Covers pytest, Maven
//          surefire/failsafe, Gradle, jest-junit, go-junit-report/gotestsum, and Kyverno Chainsaw
//          ≥ v0.2.10 `--report-format JUNIT-TEST | JUNIT-STEP | JUNIT-OPERATION` (and the deprecated XML).
//   tap    TAP 12/13/14 — `ok` / `not ok`, `# SKIP` / `# TODO`, YAML diagnostics (`message`, `duration_ms`).
import { childrenNamed, localName, numAttr, parseXml } from "../lib/xml.ts";
import type { XmlElement } from "../lib/xml.ts";
import { cell, clip, details, fenced, formatDuration } from "../lib/markdown.ts";

export type Status = "passed" | "failed" | "error" | "skipped";
export type TestFormat = "junit" | "tap";

export interface TestCase {
  report: string;      // the report file it came from (display path)
  suite: string;
  classname: string;
  name: string;
  time: number;        // seconds
  status: Status;
  message: string;     // the one-line reason (failure/skipped message attribute, TAP `message:`)
  details: string;     // the body: stack trace, diff, TAP YAML block
  file?: string;       // source file, when the report names one (pytest `file`, gotestsum)
  line?: number;
}

export interface SuiteSummary { report: string; name: string; tests: number; passed: number; failed: number; errors: number; skipped: number; time: number }
export interface Totals { total: number; passed: number; failed: number; errors: number; skipped: number }
export interface ParsedReport { report: string; format: TestFormat; cases: TestCase[]; suites: SuiteSummary[]; duration: number }

export interface TestReport {
  reports: ParsedReport[];
  problems: string[];   // "<file>: <why it could not be read>"
  cases: TestCase[];
  suites: SuiteSummary[];
  totals: Totals;
  duration: number;
  conclusion: "success" | "failure" | "neutral"; // neutral = no test cases at all
}

const num = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);

export function detectTestFormat(text: string, path = ""): TestFormat {
  const head = text.replace(/^﻿/, "").trimStart();
  if (head.startsWith("<")) return "junit";
  if (/\.tap$/i.test(path) || /^(TAP version \d+|\d+\.\.\d+|(not )?ok\b)/m.test(head)) return "tap";
  return "junit";
}

function totalsOf(cases: TestCase[]): Totals {
  const t: Totals = { total: cases.length, passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const c of cases) {
    if (c.status === "passed") t.passed++;
    else if (c.status === "failed") t.failed++;
    else if (c.status === "error") t.errors++;
    else t.skipped++;
  }
  return t;
}

function suiteSummary(report: string, name: string, cases: TestCase[], time: number): SuiteSummary {
  const t = totalsOf(cases);
  return { report, name, tests: t.total, passed: t.passed, failed: t.failed, errors: t.errors, skipped: t.skipped, time: num(time) || cases.reduce((s, c) => s + c.time, 0) };
}

function caseOf(el: XmlElement, report: string, suite: string): TestCase {
  let status: Status = "passed";
  let message = "";
  let body = "";
  for (const k of el.children) {
    const n = localName(k);
    const st: Status | undefined = n === "failure" ? "failed" : n === "error" ? "error" : n === "skipped" ? "skipped" : undefined;
    if (!st) continue;
    // failure/error win over skipped when a runner emits both
    if (status === "passed" || (status === "skipped" && st !== "skipped")) {
      status = st;
      message = (k.attrs.message || k.attrs.type || "").trim();
      body = k.text.trim();
    }
  }
  const line = numAttr(el, "line");
  return {
    report, suite,
    classname: el.attrs.classname || el.attrs.class || "",
    name: el.attrs.name || "(unnamed)",
    time: num(numAttr(el, "time")),
    status, message, details: body,
    file: el.attrs.file || undefined,
    line: Number.isFinite(line) && line > 0 ? line : undefined,
  };
}

/** JUnit XML → cases + per-suite rollup. Throws on malformed XML or a non-JUnit root. */
export function parseJUnit(xml: string, report: string): ParsedReport {
  const root = parseXml(xml);
  const rootName = localName(root);
  if (rootName !== "testsuites" && rootName !== "testsuite") throw new Error(`not a JUnit report (root element <${root.name}>)`);
  const cases: TestCase[] = [];
  const suites: SuiteSummary[] = [];
  const topSuites = rootName === "testsuite" ? [root] : childrenNamed(root, "testsuite");
  // a <testsuites> may also hold bare <testcase>s (some runners)
  const visit = (s: XmlElement, prefix: string) => {
    const name = [prefix, s.attrs.name || s.attrs.package || ""].filter(Boolean).join(" › ") || "(unnamed suite)";
    const own = childrenNamed(s, "testcase").map((c) => caseOf(c, report, name));
    cases.push(...own);
    if (own.length) suites.push(suiteSummary(report, name, own, numAttr(s, "time")));
    for (const child of childrenNamed(s, "testsuite")) visit(child, name);
  };
  for (const s of topSuites) visit(s, "");
  if (rootName === "testsuites") {
    const bare = childrenNamed(root, "testcase").map((c) => caseOf(c, report, root.attrs.name || "(tests)"));
    if (bare.length) { cases.push(...bare); suites.push(suiteSummary(report, root.attrs.name || "(tests)", bare, NaN)); }
  }
  // duration: the root's own time, else the top-level suites' times, else the cases' (Chainsaw
  // JUNIT-TEST writes time="" on its suites — so the fallbacks matter)
  const rootTime = numAttr(root, "time");
  const suiteTimes = topSuites.map((s) => numAttr(s, "time")).filter((t) => Number.isFinite(t));
  const duration = num(rootTime) || (suiteTimes.length ? suiteTimes.reduce((a, b) => a + b, 0) : 0) || cases.reduce((s, c) => s + c.time, 0);
  return { report, format: "junit", cases, suites, duration };
}

/** TAP → cases. Indented lines are diagnostics/subtests of the previous test point. */
export function parseTap(text: string, report: string): ParsedReport {
  const suite = report.replace(/^.*\//, "") || "tap";
  const cases: TestCase[] = [];
  let yaml: string[] | null = null;
  let last: TestCase | undefined;
  const flushYaml = () => {
    if (!yaml || !last) { yaml = null; return; }
    const block = yaml.join("\n");
    const msg = /^\s*message:\s*['"]?(.*?)['"]?\s*$/m.exec(block);
    if (msg && !last.message) last.message = msg[1];
    const dur = /^\s*duration_ms:\s*([\d.]+)/m.exec(block);
    if (dur) last.time = Number(dur[1]) / 1000;
    if (last.status !== "passed") last.details = block;
    yaml = null;
  };
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (yaml) {
      if (/^\s+\.\.\.\s*$/.test(raw)) { flushYaml(); continue; }
      yaml.push(raw.replace(/^ {2}/, ""));
      continue;
    }
    if (/^\s+---\s*$/.test(raw) && last) { yaml = []; continue; }
    if (/^\s/.test(raw)) continue; // subtest output / comments of a nested level
    const bail = /^Bail out!\s*(.*)$/.exec(raw);
    if (bail) { cases.push({ report, suite, classname: "", name: "Bail out!", time: 0, status: "error", message: bail[1] || "bailed out", details: "" }); continue; }
    const m = /^(not )?ok\b\s*(\d+)?\s*(?:-\s*)?(.*)$/.exec(raw);
    if (!m) continue;
    let desc = m[3];
    let directive = "";
    let reason = "";
    const d = /\s*(?<!\\)#\s*(SKIP|TODO)\S*\s*(.*)$/i.exec(desc);
    if (d) { directive = d[1].toUpperCase(); reason = d[2].trim(); desc = desc.slice(0, d.index); }
    const notOk = Boolean(m[1]);
    const status: Status = directive === "SKIP" || directive === "TODO" ? "skipped" : notOk ? "failed" : "passed";
    last = { report, suite, classname: "", name: desc.trim() || `test ${m[2] || cases.length + 1}`, time: 0, status, message: reason, details: "" };
    cases.push(last);
  }
  if (yaml) flushYaml();
  return { report, format: "tap", cases, suites: cases.length ? [suiteSummary(report, suite, cases, NaN)] : [], duration: cases.reduce((s, c) => s + c.time, 0) };
}

export function parseTestReport(text: string, report: string, format: "auto" | TestFormat = "auto"): ParsedReport {
  const f = format === "auto" ? detectTestFormat(text, report) : format;
  return f === "tap" ? parseTap(text, report) : parseJUnit(text, report);
}

export function aggregate(reports: ParsedReport[], problems: string[] = []): TestReport {
  const cases = reports.flatMap((r) => r.cases);
  const totals = totalsOf(cases);
  const bad = totals.failed + totals.errors > 0 || problems.length > 0;
  return {
    reports, problems, cases,
    suites: reports.flatMap((r) => r.suites),
    totals,
    duration: reports.reduce((s, r) => s + r.duration, 0),
    conclusion: bad ? "failure" : totals.total === 0 ? "neutral" : "success",
  };
}

export const ICON: Record<Status, string> = { passed: "✅", failed: "❌", error: "💥", skipped: "⏭️" };

export function verdict(r: TestReport): string {
  const { totals: t } = r;
  if (r.conclusion === "neutral") return r.problems.length ? "❌ unreadable reports" : "⚪ no test cases found";
  if (r.conclusion === "success") return `✅ ${t.passed} passed`;
  const parts = [t.failed ? `${t.failed} failed` : "", t.errors ? `${t.errors} errors` : "", r.problems.length ? `${r.problems.length} unreadable` : ""].filter(Boolean);
  return `❌ ${parts.join(", ")}`;
}

export interface RenderOptions {
  title: string;
  command?: string;        // how the tests ran (shown verbatim, like the old workflow's `docker compose … run …`)
  runUrl?: string;         // link back to the full report (PR comment / check run)
  collapse?: boolean;      // fold the per-case table (and the failures in a comment) into <details>
  includePassing?: boolean;// list passing cases in the full table (false = failures/skips only)
  maxFailures?: number;    // failing cases rendered with their message
  maxDetail?: number;      // chars per failure body
  maxCases?: number;       // rows in the per-case table
  note?: string;           // e.g. "some passing cases were omitted to fit this comment"
}

function caseLabel(c: TestCase): string {
  return [c.suite, c.classname && c.classname !== c.suite ? c.classname : "", c.name].filter(Boolean).join(" › ");
}

export function renderTestMarkdown(r: TestReport, o: RenderOptions): string {
  const t = r.totals;
  const md: string[] = [`## ${o.title} — ${verdict(r)}`, ""];
  md.push(
    "| Total | ✅ Passed | ❌ Failed | 💥 Errors | ⏭️ Skipped | ⏱️ Duration |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${t.total} | ${t.passed} | ${t.failed} | ${t.errors} | ${t.skipped} | ${formatDuration(r.duration)} |`,
    "",
  );
  if (o.command) md.push("Tests were executed with:", "", fenced(o.command, "shell"), "");
  if (o.runUrl) md.push("> [!TIP]", `> Full report: the job summary of ${o.runUrl}`, "");
  if (o.note) md.push(`> [!NOTE]`, `> ${o.note}`, "");
  if (r.problems.length) {
    md.push(`### ⚠️ Unreadable reports (${r.problems.length})`, "", ...r.problems.map((p) => `- ${cell(p)}`), "");
  }

  const bad = r.cases.filter((c) => c.status === "failed" || c.status === "error");
  if (bad.length) {
    const max = o.maxFailures ?? 50;
    const per = o.maxDetail ?? 4000;
    md.push(`### ❌ Failures (${bad.length})`, "");
    for (const c of bad.slice(0, max)) {
      const body = [c.message, c.details && c.details !== c.message ? c.details : ""].filter(Boolean).join("\n\n") || "(no message in the report)";
      const where = c.file ? ` — \`${cell(c.file)}${c.line ? `:${c.line}` : ""}\`` : "";
      md.push(details(`${ICON[c.status]} <code>${cell(caseLabel(c))}</code> (${formatDuration(c.time)})${where}`, fenced(clip(body, per))), "");
    }
    if (bad.length > max) md.push(`… and ${bad.length - max} more failing cases (see the uploaded report artifact).`, "");
  }

  if (r.suites.length > 1) {
    const rows = [
      "| Suite | Tests | ✅ | ❌ | 💥 | ⏭️ | ⏱️ |",
      "|---|---:|---:|---:|---:|---:|---:|",
      ...r.suites.map((s) => `| ${s.failed + s.errors ? "❌" : s.tests === s.skipped ? "⏭️" : "✅"} ${cell(s.name)} | ${s.tests} | ${s.passed} | ${s.failed} | ${s.errors} | ${s.skipped} | ${formatDuration(s.time)} |`),
    ].join("\n");
    md.push(o.collapse ? details(`Suites (${r.suites.length})`, rows) : `### Suites\n\n${rows}`, "");
  }

  const listed = r.cases.filter((c) => o.includePassing !== false || c.status !== "passed");
  if (listed.length) {
    const maxCases = o.maxCases ?? 1000;
    const rows = [
      "| Result | Suite | Test | Duration |",
      "|:---:|---|---|---:|",
      ...listed.slice(0, maxCases).map((c) => `| ${ICON[c.status]} | ${cell(c.suite)} | ${cell(c.classname && c.classname !== c.suite ? `${c.classname} › ${c.name}` : c.name)} | ${formatDuration(c.time)} |`),
    ];
    if (listed.length > maxCases) rows.push(`| … | ${listed.length - maxCases} more | | |`);
    const label = o.includePassing === false ? `Failed and skipped test cases (${listed.length})` : `All test cases (${listed.length})`;
    md.push(o.collapse ? details(label, rows.join("\n")) : `### ${label}\n\n${rows.join("\n")}`, "");
  }

  const files = r.reports.map((p) => `\`${cell(p.report)}\` (${p.format})`);
  if (files.length) md.push(`<sub>Reports: ${files.join(", ")}</sub>`, "");
  return md.join("\n");
}

/**
 * Render within `limit` characters, shedding detail the way the old workflow did for PR comments
 * (drop passing cases first — "Some test case results were removed to fit to this comment"), then
 * shorter failure bodies, then fewer failures; the job summary keeps everything.
 */
export function renderWithin(r: TestReport, o: RenderOptions, limit: number): string {
  const attempts: RenderOptions[] = [
    o,
    { ...o, includePassing: false, note: "Passing test cases were omitted to fit this comment — the job summary lists all of them." },
    { ...o, includePassing: false, maxDetail: 800, maxCases: 200, note: "Passing cases omitted and failure output shortened to fit — see the job summary." },
    { ...o, includePassing: false, maxDetail: 300, maxFailures: 20, maxCases: 50, note: "Heavily shortened to fit — see the job summary and the report artifact." },
  ];
  for (const a of attempts) {
    const md = renderTestMarkdown(r, a);
    if (md.length <= limit) return md;
  }
  return clip(renderTestMarkdown(r, attempts[attempts.length - 1]), limit - 20);
}
