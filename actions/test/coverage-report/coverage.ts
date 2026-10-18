// ☂️ Coverage-report model, parsers and markdown — pure functions (unit-tested in coverage.test.ts).
//
// The old ohanalabs-ai/ohana-github docker-compose-devsecops-test-workflow.yaml rendered COBERTURA XML with
// irongut/CodeCoverageSummary (badge + per-package Line/Branch/Complexity/Health table, "70 85" thresholds,
// fail_below_min) — reproduced here. The same model also reads the other formats test containers emit:
//   cobertura  coverage.py / pytest-cov, istanbul `cobertura`, coverlet, gcovr, `gocover-cobertura`
//   jacoco     JaCoCo XML (Java/Kotlin; DOCTYPE + nested <group>s ok)
//   lcov       LCOV tracefiles (istanbul/nyc/c8/jest `lcov`, gcov/lcov, `cargo llvm-cov --lcov`)
//   go         Go coverprofiles (`go test -coverprofile`, any mode; merged runs de-duplicated)
// Groups are the format's packages (Cobertura/JaCoCo) or source directories (LCOV/Go).
import { childrenNamed, descendants, localName, numAttr, parseXml } from "../lib/xml.ts";
import type { XmlElement } from "../lib/xml.ts";
import { cell, details, percent } from "../lib/markdown.ts";

export type CoverageFormat = "cobertura" | "jacoco" | "lcov" | "go";

export interface CoverageGroup {
  name: string;
  linesCovered: number;
  linesValid: number;
  branchesCovered: number;
  branchesValid: number;
  lineRate: number | null;    // 0..1
  branchRate: number | null;  // 0..1, null = the format/report has no branch data
  complexity: number | null;
}
export interface CoverageReport { report: string; format: CoverageFormat; groups: CoverageGroup[]; totals: CoverageGroup }

export interface Thresholds { low: number; high: number } // percentages
export type Health = "healthy" | "warning" | "unhealthy" | "unknown";

const rate = (covered: number, valid: number): number | null => (valid > 0 ? covered / valid : null);
const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);

function group(name: string, lc: number, lv: number, bc: number, bv: number, complexity: number | null = null, fallbackLine = NaN, fallbackBranch = NaN): CoverageGroup {
  return {
    name, linesCovered: lc, linesValid: lv, branchesCovered: bc, branchesValid: bv,
    lineRate: rate(lc, lv) ?? fin(fallbackLine),
    // lines counted but no branch conditions = the report has no branch data (coverage.py without --branch
    // still writes branch-rate="0") → null, never a misleading 0%
    branchRate: rate(bc, bv) ?? (lv > 0 ? null : fin(fallbackBranch)),
    complexity,
  };
}

function sumGroups(name: string, groups: CoverageGroup[]): CoverageGroup {
  const s = groups.reduce((a, g) => ({ lc: a.lc + g.linesCovered, lv: a.lv + g.linesValid, bc: a.bc + g.branchesCovered, bv: a.bv + g.branchesValid }), { lc: 0, lv: 0, bc: 0, bv: 0 });
  const cx = groups.some((g) => g.complexity !== null) ? groups.reduce((a, g) => a + (g.complexity || 0), 0) : null;
  const t = group(name, s.lc, s.lv, s.bc, s.bv, cx);
  if (t.lineRate === null && groups.length === 1) return { ...groups[0], name };
  return t;
}

export function detectCoverageFormat(text: string, path = ""): CoverageFormat {
  const head = text.replace(/^﻿/, "").trimStart();
  if (head.startsWith("mode:")) return "go";
  if (head.startsWith("<")) {
    if (/<report[\s>]/.test(head) || /jacoco|report\.dtd/i.test(head.slice(0, 400))) return "jacoco";
    return "cobertura";
  }
  if (/^(TN|SF):/m.test(head) || /\.(info|lcov)$/i.test(path)) return "lcov";
  if (/\.(out|cov|coverprofile)$/i.test(path)) return "go";
  throw new Error("unknown coverage format (expected Cobertura/JaCoCo XML, LCOV or a Go coverprofile)");
}

/** "50% (1/2)" → [1, 2] */
function conditions(s: string | undefined): [number, number] | null {
  const m = /\((\d+)\s*\/\s*(\d+)\)/.exec(s || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function parseCobertura(xml: string, report: string): CoverageReport {
  const root = parseXml(xml);
  if (localName(root) !== "coverage") throw new Error(`not a Cobertura report (root element <${root.name}>)`);
  const groups: CoverageGroup[] = [];
  for (const pkg of descendants(root, "package")) {
    let lc = 0, lv = 0, bc = 0, bv = 0;
    for (const cls of descendants(pkg, "class")) {
      // only the class's own <lines> — <methods><method><lines> repeat the same lines
      for (const lines of childrenNamed(cls, "lines")) {
        for (const line of childrenNamed(lines, "line")) {
          lv++;
          if (numAttr(line, "hits") > 0) lc++;
          if (line.attrs.branch === "true") {
            const c = conditions(line.attrs["condition-coverage"]);
            if (c) { bc += c[0]; bv += c[1]; }
          }
        }
      }
    }
    const name = pkg.attrs.name && pkg.attrs.name !== "." ? pkg.attrs.name : "(root)";
    const g = group(name, lc, lv, bc, bv, fin(numAttr(pkg, "complexity")), numAttr(pkg, "line-rate"), numAttr(pkg, "branch-rate"));
    groups.push(g);
  }
  // totals: the root's counts when it has them (they are authoritative), else the packages' sum
  const rlv = numAttr(root, "lines-valid"), rlc = numAttr(root, "lines-covered");
  const rbv = numAttr(root, "branches-valid"), rbc = numAttr(root, "branches-covered");
  const summed = sumGroups("Summary", groups);
  let totals: CoverageGroup;
  if (Number.isFinite(rlv) && rlv > 0 && Number.isFinite(rlc)) {
    totals = group("Summary", rlc, rlv, Number.isFinite(rbc) ? rbc : summed.branchesCovered, Number.isFinite(rbv) ? rbv : summed.branchesValid, fin(numAttr(root, "complexity")) ?? summed.complexity, NaN, numAttr(root, "branch-rate"));
  } else if (summed.lineRate !== null) {
    totals = { ...summed, complexity: fin(numAttr(root, "complexity")) ?? summed.complexity };
  } else {
    totals = group("Summary", 0, 0, 0, 0, fin(numAttr(root, "complexity")), numAttr(root, "line-rate"), numAttr(root, "branch-rate"));
  }
  return { report, format: "cobertura", groups, totals };
}

function jacocoCounters(el: XmlElement): Record<string, { missed: number; covered: number }> {
  const out: Record<string, { missed: number; covered: number }> = {};
  for (const c of childrenNamed(el, "counter")) out[c.attrs.type] = { missed: numAttr(c, "missed") || 0, covered: numAttr(c, "covered") || 0 };
  return out;
}

function jacocoGroup(name: string, el: XmlElement): CoverageGroup {
  const c = jacocoCounters(el);
  const L = c.LINE || { missed: 0, covered: 0 };
  const B = c.BRANCH || { missed: 0, covered: 0 };
  const cx = c.COMPLEXITY ? c.COMPLEXITY.missed + c.COMPLEXITY.covered : null;
  return group(name, L.covered, L.covered + L.missed, B.covered, B.covered + B.missed, cx);
}

export function parseJaCoCo(xml: string, report: string): CoverageReport {
  const root = parseXml(xml);
  if (localName(root) !== "report") throw new Error(`not a JaCoCo report (root element <${root.name}>)`);
  const groups = descendants(root, "package").map((p) => jacocoGroup((p.attrs.name || "(default)").replace(/\//g, "."), p));
  const own = jacocoCounters(root);
  const totals = own.LINE ? jacocoGroup("Summary", root) : sumGroups("Summary", groups);
  return { report, format: "jacoco", groups, totals };
}

/** Group key of a source path: its directory, shortened by the prefix common to all of them. */
function byDirectory<T>(entries: Array<[string, T]>): Map<string, T[]> {
  const dirs = entries.map(([p]) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "."));
  let common = dirs.length > 1 ? dirs[0].split("/") : [];
  for (const d of dirs.slice(1)) {
    const parts = d.split("/");
    let k = 0;
    while (k < common.length && k < parts.length && common[k] === parts[k]) k++;
    common = common.slice(0, k);
  }
  const prefix = common.join("/");
  const out = new Map<string, T[]>();
  entries.forEach(([, v], i) => {
    let key = dirs[i];
    if (prefix && dirs.length > 1 && key.startsWith(prefix)) key = key.slice(prefix.length).replace(/^\//, "") || prefix.split("/").pop() || ".";
    if (!out.has(key)) out.set(key, []);
    (out.get(key) as T[]).push(v);
  });
  return out;
}

export function parseLcov(text: string, report: string): CoverageReport {
  interface Rec { lf: number; lh: number; brf: number; brh: number; da: Map<number, number>; brda: Array<[string, number]> }
  const recs: Array<[string, Rec]> = [];
  let cur: Rec | null = null;
  let sf = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) { sf = line.slice(3); cur = { lf: NaN, lh: NaN, brf: NaN, brh: NaN, da: new Map(), brda: [] }; continue; }
    if (!cur) continue;
    if (line === "end_of_record") { recs.push([sf, cur]); cur = null; continue; }
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    if (k === "LF") cur.lf = Number(v);
    else if (k === "LH") cur.lh = Number(v);
    else if (k === "BRF") cur.brf = Number(v);
    else if (k === "BRH") cur.brh = Number(v);
    else if (k === "DA") { const [ln, hits] = v.split(","); cur.da.set(Number(ln), Math.max(cur.da.get(Number(ln)) || 0, Number(hits) || 0)); }
    else if (k === "BRDA") { const p = v.split(","); cur.brda.push([p.slice(0, 3).join(","), p[3] === "-" ? 0 : Number(p[3]) || 0]); }
  }
  if (cur) recs.push([sf, cur]);
  if (!recs.length) throw new Error("not an LCOV tracefile (no SF: records)");
  const counted = recs.map(([p, r]): [string, CoverageGroup] => {
    const lv = Number.isFinite(r.lf) ? r.lf : r.da.size;
    const lc = Number.isFinite(r.lh) ? r.lh : [...r.da.values()].filter((h) => h > 0).length;
    const bv = Number.isFinite(r.brf) ? r.brf : r.brda.length;
    const bc = Number.isFinite(r.brh) ? r.brh : r.brda.filter(([, t]) => t > 0).length;
    return [p, group(p, lc, lv, bc, bv)];
  });
  const groups = [...byDirectory(counted)].map(([name, gs]) => sumGroups(name, gs));
  return { report, format: "lcov", groups, totals: sumGroups("Summary", groups) };
}

export function parseGoCover(text: string, report: string): CoverageReport {
  const lines = text.split(/\r?\n/);
  if (!/^mode:\s*\w+/.test(lines[0] || "")) throw new Error("not a Go coverprofile (first line must be `mode: …`)");
  const blocks = new Map<string, { file: string; stmts: number; count: number }>();
  for (const raw of lines.slice(1)) {
    const m = /^(.+):(\d+\.\d+,\d+\.\d+)\s+(\d+)\s+(\d+)$/.exec(raw.trim());
    if (!m) continue;
    const key = `${m[1]}:${m[2]}`;
    const prev = blocks.get(key);
    const count = Number(m[4]);
    if (prev) prev.count = Math.max(prev.count, count);
    else blocks.set(key, { file: m[1], stmts: Number(m[3]), count });
  }
  const perFile = new Map<string, { c: number; v: number }>();
  for (const b of blocks.values()) {
    const f = perFile.get(b.file) || { c: 0, v: 0 };
    f.v += b.stmts;
    if (b.count > 0) f.c += b.stmts;
    perFile.set(b.file, f);
  }
  const entries: Array<[string, CoverageGroup]> = [...perFile].map(([f, s]) => [f, group(f, s.c, s.v, 0, 0)]);
  const groups = [...byDirectory(entries)].map(([name, gs]) => sumGroups(name, gs));
  return { report, format: "go", groups, totals: sumGroups("Summary", groups) };
}

export function parseCoverage(text: string, report: string, format: "auto" | CoverageFormat = "auto"): CoverageReport {
  const f = format === "auto" ? detectCoverageFormat(text, report) : format;
  if (f === "jacoco") return parseJaCoCo(text, report);
  if (f === "lcov") return parseLcov(text, report);
  if (f === "go") return parseGoCover(text, report);
  return parseCobertura(text, report);
}

/** irongut/CodeCoverageSummary `thresholds: "70 85"` — "<low> <high>" percentages (one number = low = high). */
export function parseThresholds(s: string | undefined): Thresholds {
  const n = String(s || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const low = Number.isFinite(n[0]) ? n[0] : 50;
  const high = Number.isFinite(n[1]) ? n[1] : Number.isFinite(n[0]) ? n[0] : 75;
  if (low < 0 || high > 100 || low > high) throw new Error(`thresholds must be "<low> <high>" with 0 ≤ low ≤ high ≤ 100 (got "${s}")`);
  return { low, high };
}

export function health(r: number | null, t: Thresholds): Health {
  if (r === null) return "unknown";
  const p = r * 100;
  return p >= t.high ? "healthy" : p >= t.low ? "warning" : "unhealthy";
}

export const HEALTH_ICON: Record<Health, string> = { healthy: "✅", warning: "➖", unhealthy: "❌", unknown: "❔" };

/** Combined totals across several report files (lines summed when every report has counts). */
export function overall(reports: CoverageReport[]): CoverageGroup {
  if (reports.length === 1) return reports[0].totals;
  return sumGroups("Overall", reports.map((r) => r.totals));
}

/** The shields.io badge irongut rendered (`badge: true`): red below low, yellow between, green at/above high. */
export function badgeUrl(r: number | null, t: Thresholds): string {
  const h = health(r, t);
  const color = h === "healthy" ? "success" : h === "warning" ? "yellow" : h === "unhealthy" ? "critical" : "lightgrey";
  const label = r === null ? "n%2Fa" : `${Math.round(r * 100)}%25`;
  return `https://img.shields.io/badge/Code%20Coverage-${label}-${color}?style=flat`;
}

const counts = (c: number, v: number): string => (v > 0 ? ` (${c}/${v})` : "");

function table(groups: CoverageGroup[], totals: CoverageGroup, t: Thresholds, showComplexity: boolean, showBranch: boolean): string {
  const head = ["Package", "Line rate", ...(showBranch ? ["Branch rate"] : []), ...(showComplexity ? ["Complexity"] : []), "Health"];
  const align = ["---", "---:", ...(showBranch ? ["---:"] : []), ...(showComplexity ? ["---:"] : []), ":---:"];
  const row = (g: CoverageGroup, bold: boolean) => {
    const b = (s: string) => (bold ? `**${s}**` : s);
    return `| ${[b(cell(g.name)), b(percent(g.lineRate) + counts(g.linesCovered, g.linesValid)), ...(showBranch ? [b(percent(g.branchRate) + counts(g.branchesCovered, g.branchesValid))] : []), ...(showComplexity ? [b(g.complexity === null ? "—" : String(g.complexity))] : []), HEALTH_ICON[health(g.lineRate, t)]].join(" | ")} |`;
  };
  return [`| ${head.join(" | ")} |`, `|${align.join("|")}|`, ...groups.map((g) => row(g, false)), row(totals, true)].join("\n");
}

export interface CoverageRenderOptions { title: string; thresholds: Thresholds; badge?: boolean; collapse?: boolean; command?: string; runUrl?: string; maxGroups?: number }

export function renderCoverageMarkdown(reports: CoverageReport[], problems: string[], o: CoverageRenderOptions): string {
  const all = overall(reports.length ? reports : [{ report: "", format: "cobertura", groups: [], totals: group("Overall", 0, 0, 0, 0) }]);
  const h = health(all.lineRate, o.thresholds);
  const md: string[] = [`## ${o.title} — ${reports.length ? `${percent(all.lineRate)} ${HEALTH_ICON[h]}` : "⚪ no coverage report"}`, ""];
  if (o.badge !== false && reports.length) md.push(`![Code Coverage](${badgeUrl(all.lineRate, o.thresholds)})`, "");
  if (o.command) md.push("Coverage was collected with:", "", "```shell", o.command, "```", "");
  if (o.runUrl) md.push("> [!TIP]", `> Full report: the job summary of ${o.runUrl}`, "");
  if (problems.length) md.push(`### ⚠️ Unreadable reports (${problems.length})`, "", ...problems.map((p) => `- ${cell(p)}`), "");
  const max = o.maxGroups ?? 300;
  for (const r of reports) {
    const showBranch = r.groups.some((g) => g.branchRate !== null) || r.totals.branchRate !== null;
    const showComplexity = r.groups.some((g) => g.complexity !== null) || r.totals.complexity !== null;
    const groups = r.groups.length > max ? r.groups.slice(0, max) : r.groups;
    let tbl = table(groups, r.totals, o.thresholds, showComplexity, showBranch);
    if (r.groups.length > max) tbl += `\n\n… ${r.groups.length - max} more packages (see the report artifact).`;
    const head = `\`${cell(r.report)}\` (${r.format}) — ${percent(r.totals.lineRate)} ${HEALTH_ICON[health(r.totals.lineRate, o.thresholds)]}`;
    md.push(o.collapse ? details(head, tbl) : `### ${head}\n\n${tbl}`, "");
  }
  if (reports.length > 1) {
    md.push(`**Overall:** ${percent(all.lineRate)}${counts(all.linesCovered, all.linesValid)} lines${all.branchRate !== null ? ` · ${percent(all.branchRate)}${counts(all.branchesCovered, all.branchesValid)} branches` : ""}`, "");
  }
  md.push(`<sub>Health: ❌ below ${o.thresholds.low}% · ➖ ${o.thresholds.low}–${o.thresholds.high}% · ✅ ${o.thresholds.high}% and above</sub>`, "");
  return md.join("\n");
}
