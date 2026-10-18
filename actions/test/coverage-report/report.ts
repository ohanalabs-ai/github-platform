// ☂️ test/coverage-report — run by actions/github-script (Node 24, native type stripping; no npm deps).
// Finds the caller's coverage reports, parses them (coverage.ts) and publishes:
//   • the job summary (always — on every outcome, incl. no/unreadable reports: owner rule 2026-10-13)
//   • a sticky PR comment (pull_request events, `comment: true`) — the old workflow's "☂️ Code Coverage Results"
//   • a check run (`check-run: true`), failure when below the low threshold
//   • step outputs (line/branch rate, counts, health, below-min, the matched files for the artifact upload)
// Fails the step only when asked (`fail-below-min`, `fail-on-empty`). Never reads or prints secrets.
//
// env: PATHS, FORMAT, TITLE, COMMAND, THRESHOLDS, FAIL_BELOW_MIN, FAIL_ON_EMPTY, BADGE, COMMENT,
//      COMMENT_KEY, COLLAPSE, CHECK_RUN, CHECK_NAME
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { health, overall, parseCoverage, parseThresholds, renderCoverageMarkdown } from "./coverage.ts";
import type { CoverageFormat, CoverageGroup, CoverageReport, Thresholds } from "./coverage.ts";
import { boolInput, COMMENT_LIMIT, clip, listInput, percent, slug, SUMMARY_LIMIT } from "../lib/markdown.ts";
import { checkRun, displayPath, findReportFiles, runUrl, stickyComment } from "../lib/github.ts";
import type { Ctx } from "../lib/github.ts";

const FORMATS = ["auto", "cobertura", "jacoco", "lcov", "go"];
const EXTS: Record<string, string[]> = { auto: ["xml", "info", "lcov", "out"], cobertura: ["xml"], jacoco: ["xml"], lcov: ["info", "lcov"], go: ["out"] };

export function coverageOutputs(all: CoverageGroup, t: Thresholds, files: string[], hasReports: boolean): Record<string, string> {
  const pct = (r: number | null) => (r === null ? "" : (r * 100).toFixed(2));
  return {
    "line-rate": hasReports ? pct(all.lineRate) : "",
    "branch-rate": hasReports ? pct(all.branchRate) : "",
    "lines-covered": String(all.linesCovered),
    "lines-valid": String(all.linesValid),
    "branches-covered": String(all.branchesCovered),
    "branches-valid": String(all.branchesValid),
    health: hasReports ? health(all.lineRate, t) : "unknown",
    "below-min": String(hasReports && all.lineRate !== null && all.lineRate * 100 < t.low),
    files: String(files.length),
    "file-list": files.join("\n"),
  };
}

export default async function run(ctx: Ctx): Promise<void> {
  const { core, glob, context } = ctx;
  const env = process.env;
  const title = env.TITLE || "☂️ Code coverage";
  const format = (env.FORMAT || "auto").toLowerCase() as "auto" | CoverageFormat;
  const published: string[] = [];
  const reports: CoverageReport[] = [];
  const problems: string[] = [];
  let files: string[] = [];
  let thresholds: Thresholds = { low: 70, high: 85 };
  let fatal = "";
  const render = (extra: Record<string, unknown> = {}) =>
    renderCoverageMarkdown(reports, problems, { title, thresholds, badge: boolInput(env.BADGE, true), command: env.COMMAND, collapse: false, ...extra });
  try {
    if (!FORMATS.includes(format)) throw new Error(`format must be ${FORMATS.join(" | ")} (got "${env.FORMAT}")`);
    thresholds = parseThresholds(env.THRESHOLDS || "70 85");
    const entries = listInput(env.PATHS);
    if (!entries.length) throw new Error("`paths` is empty — pass the coverage file(s), glob(s) or directory");
    files = await findReportFiles(glob, entries, EXTS[format]);
    for (const f of files) {
      const shown = displayPath(f);
      try { reports.push(parseCoverage(readFileSync(f, "utf8"), shown, format)); }
      catch (e) { problems.push(`${shown}: ${(e as Error).message}`); }
    }
    const all = overall(reports.length ? reports : [{ report: "", format: "cobertura", groups: [], totals: { name: "", linesCovered: 0, linesValid: 0, branchesCovered: 0, branchesValid: 0, lineRate: null, branchRate: null, complexity: null } }]);
    const outs = coverageOutputs(all, thresholds, files, reports.length > 0);
    for (const [k, v] of Object.entries(outs)) core.setOutput(k, v);

    const dir = join(env.RUNNER_TEMP || "/tmp", "github-platform-test", slug(title));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "coverage.md"), render());
    core.setOutput("markdown-file", join(dir, "coverage.md"));

    if (reports.length && boolInput(env.COMMENT, true)) {
      const body = clip(render({ collapse: boolInput(env.COLLAPSE, true), runUrl: runUrl(context) }), COMMENT_LIMIT);
      const res = await stickyComment(ctx, env.COMMENT_KEY || slug(title), body);
      published.push(`PR comment: ${res.detail}`);
      if (!res.ok && context.payload?.pull_request) core.warning(res.detail);
    }
    const below = outs["below-min"] === "true";
    if (reports.length && boolInput(env.CHECK_RUN, false)) {
      const res = await checkRun(ctx, env.CHECK_NAME || title, below || problems.length ? "failure" : "success",
        `${percent(all.lineRate)} line coverage (${outs.health})`, clip(render({ collapse: true, runUrl: runUrl(context) }), COMMENT_LIMIT), []);
      published.push(`Check run: ${res.detail}`);
      if (!res.ok) core.warning(res.detail);
    }

    if (!files.length) {
      const msg = `no coverage reports matched: ${entries.join(", ")}`;
      if (boolInput(env.FAIL_ON_EMPTY, false)) core.setFailed(msg); else core.warning(msg);
    } else if (below && boolInput(env.FAIL_BELOW_MIN, false)) {
      core.setFailed(`${title}: ${percent(all.lineRate)} is below the minimum ${thresholds.low}%`);
    }
  } catch (e) {
    fatal = (e as Error).message;
    core.setFailed(`test/coverage-report: ${fatal}`);
  } finally {
    // Every outcome publishes what it did (owner rule 2026-10-13).
    let md = clip(render(), SUMMARY_LIMIT - 4000);
    if (!files.length && !fatal) md += `\n> [!WARNING]\n> No coverage report matched \`${listInput(env.PATHS).join("`, `")}\` (format: ${format}).\n`;
    if (fatal) md += `\n> [!CAUTION]\n> ${fatal}\n`;
    if (published.length) md += `\n${published.map((p) => `- ${p}`).join("\n")}\n`;
    await core.summary.addRaw(md, true).write();
  }
}
