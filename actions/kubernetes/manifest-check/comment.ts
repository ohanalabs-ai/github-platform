// One sticky PR comment per check title: delete the previous one (found by a hidden marker), post
// the fresh report — or just delete when CLEAR=true (nothing to check any more).
import { readFileSync } from "node:fs";
import type { Ctx } from "./types.ts";

export default async function run({ core, github, context }: Ctx): Promise<void> {
  const pr = context.payload?.pull_request?.number as number | undefined;
  if (!pr) return core.info("not a pull_request run — no comment");
  const marker = `<!-- kustomize-check:${process.env.COMMENT_KEY || "default"} -->`;
  const { owner, repo } = context.repo as { owner: string; repo: string };
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr, per_page: 100 });
  for (const c of comments as Array<{ id: number; body?: string }>) {
    if ((c.body || "").startsWith(marker)) await github.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
  }
  if (process.env.CLEAR === "true") return;
  let md = readFileSync(process.env.REPORT_MD || "report.md", "utf8");
  if (md.length > 60000) md = `${md.slice(0, 60000)}\n\n… truncated — the full report is in the job summary.\n`;
  await github.rest.issues.createComment({ owner, repo, issue_number: pr, body: `${marker}\n${md}` });
}
