// 🧭 devsecops-openapi · report — the last job: combine the lint / drift / breaking results into ONE sticky PR
// comment (hidden marker; delete-and-recreate so it is always the newest), the step summary, and the workflow
// outputs. Never the reason a job fails: a fork PR's read-only token degrades the comment to a warning.
// env: LINT_RESULT, DRIFT_RESULT, BREAKING_RESULT (the jobs' JSON outputs), COMMENT_KEY, TITLE.
// Outputs: breaking, drift, failed (the combined verdict — what the jobs' own gates enforce).
import { COMMENT_MARKER, commentKey, gate, renderComment, safeJson, type BreakingResult, type DriftResult, type LintResult } from "./lib.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function run({ core, github, context }: { core: any; exec?: any; github: any; context: any }): Promise<void> {
  const lint = safeJson<LintResult>(process.env.LINT_RESULT);
  const drift = safeJson<DriftResult>(process.env.DRIFT_RESULT);
  const breaking = safeJson<BreakingResult>(process.env.BREAKING_RESULT);
  const v = gate(lint, drift, breaking);
  // A job that produced no result (crashed before its output, or cancelled) is a failure, not a pass.
  const missing = [!lint && "lint", !drift && "drift", !breaking && "breaking"].filter(Boolean) as string[];
  const failed = v.failed || missing.length > 0;
  const body = renderComment(process.env.TITLE || "OpenAPI checks", lint, drift, breaking, { ...v, failed });
  core.setOutput("breaking", String(!!breaking?.breaking));
  core.setOutput("drift", String(!!drift?.drift));
  core.setOutput("failed", String(failed));
  let posted = "";
  try {
    const pr = context?.payload?.pull_request?.number;
    if (!pr) posted = "not a pull request — no comment";
    else {
      const marker = COMMENT_MARKER(commentKey(process.env.COMMENT_KEY));
      const { owner, repo } = context.repo;
      const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr, per_page: 100 });
      for (const c of comments as Array<{ id: number; body?: string }>) {
        if ((c.body || "").startsWith(marker)) await github.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
      }
      const r = await github.rest.issues.createComment({ owner, repo, issue_number: pr, body: `${marker}\n${body}` });
      posted = r?.data?.html_url || `PR #${pr}`;
    }
  } catch (e: any) {
    posted = `comment not posted: HTTP ${e?.status ?? "?"} — needs \`pull-requests: write\` (${String(e?.message || e).slice(0, 120)})`;
    core.warning(posted);
  }
  const note = missing.length ? `\n❌ no result from: ${missing.join(", ")}\n` : "";
  await core.summary.addRaw(`${body}${note}\n_PR comment: ${posted}_\n`, true).write();
}
