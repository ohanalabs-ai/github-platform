// One sticky PR comment per image: delete this image's previous comment (found by a hidden marker),
// then post the fresh report — the same "recreate" behaviour the marocchino action provided.
import { readFileSync } from "node:fs";
import type { Ctx } from "./types.ts";

export default async function run({ core, github, context }: Ctx): Promise<void> {
  const pr = context.payload?.pull_request?.number as number | undefined;
  if (!pr) return core.info("not a pull_request run — no comment");
  const marker = `<!-- image-security:${process.env.REPO || ""} -->`;
  const body = `${marker}\n${readFileSync(process.env.OUT_MD || "image-security-report.md", "utf8")}`;
  const { owner, repo } = context.repo as { owner: string; repo: string };
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr, per_page: 100 });
  for (const c of comments as Array<{ id: number; body?: string }>) {
    if ((c.body || "").startsWith(marker)) await github.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
  }
  await github.rest.issues.createComment({ owner, repo, issue_number: pr, body });
}
