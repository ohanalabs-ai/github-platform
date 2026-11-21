// 🧹 web-pr-rundown · prune: when the PR closes, delete its screenshots branch and say so in the sticky comment.
// Env: ASSETS_PREFIX.
import type { Ctx } from "../preview-review/types.ts";
import { MARKER, assetsBranch } from "./rundown.ts";

export default async function run({ core, github, context }: Ctx): Promise<void> {
  const pr = context.payload?.pull_request;
  if (!pr) return core.setFailed("web-pr-rundown prune runs on pull_request events only");
  const { owner, repo } = context.repo as { owner: string; repo: string };
  const branch = assetsBranch(process.env.ASSETS_PREFIX || "pr-rundown-", pr.number);
  try {
    await github.rest.git.deleteRef({ owner, repo, ref: `heads/${branch}` });
    core.info(`deleted ${branch}`);
  } catch (err) {
    const st = (err as { status?: number }).status;
    if (st !== 404 && st !== 422) throw err;
    core.info(`${branch} does not exist — nothing to prune`);
  }
  const comments = (await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 })) as Array<{ id: number; body?: string }>;
  const mine = comments.find((x) => (x.body || "").startsWith(MARKER));
  const note = `> [!NOTE]\n> The PR is closed: its screenshots branch \`${branch}\` was deleted, so the images below no longer load. The run artifact keeps them for its retention period.\n`;
  if (mine && !(mine.body || "").includes("its screenshots branch")) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body: (mine.body || "").replace(MARKER, `${MARKER}\n${note}`) });
  }
  await core.summary.addRaw(`## 🧹 PR rundown pruned\n\nBranch \`${branch}\` removed.`, true).write();
}
