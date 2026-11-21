// 📸 web-pr-rundown · publish: put the screenshots where a PR comment can show them inline, then write ONE sticky comment.
// GitHub's API cannot attach images to a comment, so the shots go to a per-PR orphan branch (`<prefix><N>`), rewritten as ONE
// parentless commit on every run (no history growth; only this PR's runs write it) and deleted when the PR closes (prune.ts).
// Images are linked as github.com/<repo>/blob/<branch>/<path>?raw=true, which renders for anyone who can read the repo.
// Env: OUT, ASSETS_PREFIX, FAIL_ON, ARTIFACT, RUN_URL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../preview-review/types.ts";
import { MARKER, assetUrl, assetsBranch, failures, parseFailOn, referencedShots, renderComment, validateRundown } from "./rundown.ts";

export default async function run({ core, github, context }: Ctx): Promise<void> {
  const pr = context.payload?.pull_request;
  if (!pr) return core.setFailed("web-pr-rundown runs on pull_request events only");
  const { owner, repo } = context.repo as { owner: string; repo: string };
  const out = process.env.OUT || "out";
  const r = validateRundown(JSON.parse(readFileSync(join(out, "rundown.json"), "utf8")));
  const branch = assetsBranch(process.env.ASSETS_PREFIX || "pr-rundown-", pr.number);
  const shots = referencedShots(r);

  // 1. the assets branch: blobs → tree → parentless commit → (create | force-update) the ref
  const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  const readme = `# PR #${pr.number} rundown screenshots\n\nWritten by web-pr-rundown for ${pr.html_url} (head ${pr.head.sha}). Rewritten on every push, deleted when the PR closes. Do not commit here.\n`;
  const files: Array<[string, string]> = [["README.md", Buffer.from(readme).toString("base64")], ["rundown.json", readFileSync(join(out, "rundown.json")).toString("base64")]];
  for (const p of shots) files.push([p, readFileSync(join(out, p)).toString("base64")]);
  for (const [path, content] of files) {
    const { data } = await github.rest.git.createBlob({ owner, repo, content, encoding: "base64" });
    tree.push({ path, mode: "100644", type: "blob", sha: data.sha });
  }
  const { data: t } = await github.rest.git.createTree({ owner, repo, tree });
  const { data: c } = await github.rest.git.createCommit({ owner, repo, message: `📸 PR #${pr.number} rundown @ ${String(pr.head.sha).slice(0, 7)}`, tree: t.sha, parents: [] });
  try {
    await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: c.sha, force: true });
  } catch (err) {
    if ((err as { status?: number }).status !== 422 && (err as { status?: number }).status !== 404) throw err;
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: c.sha });
  }
  core.info(`${shots.length} screenshot(s) → ${branch} @ ${c.sha.slice(0, 7)}`);

  // 2. the comment (sticky: hidden marker, edited in place) + the run summary
  const failed = failures(r, parseFailOn(process.env.FAIL_ON || ""));
  const body = renderComment(r, {
    url: (p) => assetUrl(owner, repo, branch, p),
    runUrl: process.env.RUN_URL || "", headSha: pr.head.sha, artifact: process.env.ARTIFACT || "pr-rundown", failed,
  });
  const comments = (await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 })) as Array<{ id: number; body?: string; html_url: string }>;
  const mine = comments.find((x) => (x.body || "").startsWith(MARKER));
  const res = mine
    ? await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body })
    : await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
  const s = r.summary;
  await core.summary.addRaw([
    `## 📸 PR rundown`, "",
    `| Pages | Views | Changed | Videos | Console | Requests | Broken links | Deny-list |`, `|---|---|---|---|---|---|---|---|`,
    `| ${s.pages} | ${s.views} | ${r.base ? s.changedViews : "n/a"} | ${s.videosOk}/${s.videosTotal} | ${s.consoleErrors} | ${s.failedRequests} | ${s.brokenLinks} | ${s.denylistHits} |`, "",
    `Head \`${r.head.image}\` · base ${r.base ? `\`${r.base.image}\`` : "none"} · [the PR comment with the screenshots](${res.data.html_url})`,
  ].join("\n"), true).write();
  core.setOutput("comment_url", res.data.html_url);
  if (failed.length) core.setFailed(failed.join("; "));
}
