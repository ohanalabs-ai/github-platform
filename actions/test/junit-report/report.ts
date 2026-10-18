// ✅ test/junit-report — run by actions/github-script (Node 24, native type stripping; no npm deps).
// Finds the caller's test reports, parses them (junit.ts), and publishes:
//   • the job summary (always — on every outcome, incl. no/unreadable reports: owner rule 2026-10-13)
//   • a sticky PR comment (pull_request events, `comment: true`) sized to GitHub's 65 536-char limit
//   • a check run with failure annotations (`check-run: true`)
//   • step outputs (counts, duration, conclusion, the matched files for the artifact upload)
// It fails the step only when asked (`fail-on-failure`, `fail-on-empty`). Never reads or prints secrets.
//
// env: PATHS, FORMAT, TITLE, COMMAND, COMMENT, COMMENT_KEY, COLLAPSE, CHECK_RUN, CHECK_NAME,
//      FAIL_ON_FAILURE, FAIL_ON_EMPTY, MAX_FAILURES
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { aggregate, parseTestReport, renderTestMarkdown, renderWithin, verdict } from "./junit.ts";
import type { ParsedReport, TestFormat, TestReport } from "./junit.ts";
import { boolInput, COMMENT_LIMIT, listInput, slug, SUMMARY_LIMIT } from "../lib/markdown.ts";
import { checkRun, displayPath, findReportFiles, runUrl, stickyComment } from "../lib/github.ts";
import type { Annotation, Ctx, PublishResult } from "../lib/github.ts";

export function annotationsFor(r: TestReport): Annotation[] {
  return r.cases
    .filter((c) => c.status === "failed" || c.status === "error")
    .map((c) => ({
      path: c.file || c.report,
      start_line: c.line || 1,
      end_line: c.line || 1,
      annotation_level: "failure" as const,
      title: `${c.status === "error" ? "💥" : "❌"} ${[c.suite, c.name].filter(Boolean).join(" › ")}`.slice(0, 255),
      message: ([c.message, c.details].filter(Boolean).join("\n\n") || "failed").slice(0, 60000),
    }));
}

export function outputsFor(r: TestReport, files: string[]): Record<string, string> {
  return {
    total: String(r.totals.total),
    passed: String(r.totals.passed),
    failed: String(r.totals.failed),
    errors: String(r.totals.errors),
    skipped: String(r.totals.skipped),
    duration: r.duration.toFixed(3),
    conclusion: r.conclusion,
    files: String(files.length),
    "file-list": files.join("\n"),
  };
}

export default async function run(ctx: Ctx): Promise<void> {
  const { core, glob, context } = ctx;
  const env = process.env;
  const title = env.TITLE || "✅ Test results";
  const format = (env.FORMAT || "auto").toLowerCase() as "auto" | TestFormat;
  const published: string[] = [];
  let report: TestReport = aggregate([]);
  let files: string[] = [];
  let fatal = "";
  try {
    if (!["auto", "junit", "tap"].includes(format)) throw new Error(`format must be auto | junit | tap (got "${env.FORMAT}")`);
    const entries = listInput(env.PATHS);
    if (!entries.length) throw new Error("`paths` is empty — pass the report file(s), glob(s) or directory");
    files = await findReportFiles(glob, entries, format === "tap" ? ["tap"] : format === "junit" ? ["xml"] : ["xml", "tap"]);
    const parsed: ParsedReport[] = [];
    const problems: string[] = [];
    for (const f of files) {
      const shown = displayPath(f);
      try {
        parsed.push(parseTestReport(readFileSync(f, "utf8"), shown, format));
      } catch (e) {
        problems.push(`${shown}: ${(e as Error).message}`);
      }
    }
    report = aggregate(parsed, problems);
    for (const [k, v] of Object.entries(outputsFor(report, files))) core.setOutput(k, v);

    const md = renderTestMarkdown(report, { title, command: env.COMMAND, collapse: true, includePassing: true });
    const dir = join(env.RUNNER_TEMP || "/tmp", "github-platform-test", slug(title));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), md);
    core.setOutput("markdown-file", join(dir, "report.md"));

    if (files.length && boolInput(env.COMMENT, true)) {
      const body = renderWithin(report, { title, command: env.COMMAND, runUrl: runUrl(context), collapse: boolInput(env.COLLAPSE, true), includePassing: true }, COMMENT_LIMIT);
      const res: PublishResult = await stickyComment(ctx, env.COMMENT_KEY || slug(title), body);
      published.push(`PR comment: ${res.detail}`);
      if (!res.ok && context.payload?.pull_request) core.warning(res.detail);
    }
    if (files.length && boolInput(env.CHECK_RUN, false)) {
      const summary = renderWithin(report, { title, command: env.COMMAND, runUrl: runUrl(context), collapse: true, includePassing: false }, COMMENT_LIMIT);
      const res = await checkRun(ctx, env.CHECK_NAME || title, report.conclusion, verdict(report), summary, annotationsFor(report));
      published.push(`Check run: ${res.detail}`);
      if (!res.ok) core.warning(res.detail);
    }

    if (!files.length) {
      const msg = `no test reports matched: ${entries.join(", ")}`;
      if (boolInput(env.FAIL_ON_EMPTY, false)) core.setFailed(msg); else core.warning(msg);
    } else if (report.conclusion === "failure" && boolInput(env.FAIL_ON_FAILURE, false)) {
      core.setFailed(`${title}: ${verdict(report)}`);
    }
  } catch (e) {
    fatal = (e as Error).message;
    core.setFailed(`test/junit-report: ${fatal}`);
  } finally {
    // Every outcome publishes what it did (owner rule 2026-10-13).
    let md = renderWithin(report, { title, command: env.COMMAND, collapse: true, includePassing: true }, SUMMARY_LIMIT - 4000);
    if (!files.length && !fatal) md += `\n> [!WARNING]\n> No test report matched \`${listInput(env.PATHS).join("`, `")}\` (format: ${format}).\n`;
    if (fatal) md += `\n> [!CAUTION]\n> ${fatal}\n`;
    if (published.length) md += `\n${published.map((p) => `- ${p}`).join("\n")}\n`;
    await core.summary.addRaw(md, true).write();
  }
}
