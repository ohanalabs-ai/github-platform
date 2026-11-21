// 📸 web-pr-rundown · resolve: wait for the PR's image, then find the BASELINE image — the newest commit of the PR's base branch
// (≤ 15 back) that has a `<base-image-repo>:<prefix>-<sha7>` build (e.g. ghcr.io/planeodev/website:develop-7f58f02).
// Env: HEAD_IMAGE, BASE_IMAGE (explicit override), BASE_IMAGE_REPO, BASE_TAG_PREFIX (default: the PR's base branch), WAIT_MINUTES, GH_TOKEN.
// Outputs: head_image, head_label, base_image ('' = no baseline), base_label.
import type { Ctx } from "../preview-review/types.ts";
import { imageExists } from "../preview-review/prepare.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function run({ core, github, context }: Ctx): Promise<void> {
  const pr = context.payload?.pull_request;
  if (!pr) return core.setFailed("web-pr-rundown runs on pull_request events only");
  const token = process.env.GH_TOKEN || "";
  const head = process.env.HEAD_IMAGE || "";
  const waitMin = Number(process.env.WAIT_MINUTES || "25");
  const deadline = Date.now() + waitMin * 60_000;
  for (let i = 1; !(await imageExists(head, token)); i++) {
    if (Date.now() > deadline) return core.setFailed(`the PR image ${head} does not exist after ${waitMin} min`);
    core.info(`waiting for ${head} (attempt ${i}) …`);
    await sleep(20_000);
  }
  core.setOutput("head_image", head);
  core.setOutput("head_label", `PR #${pr.number} @ ${String(pr.head.sha).slice(0, 7)}`);

  let base = "", label = "";
  const override = process.env.BASE_IMAGE || "";
  const repo = process.env.BASE_IMAGE_REPO || "";
  if (override) {
    if (await imageExists(override, token)) { base = override; label = override.split(":").pop() || override; }
    else core.warning(`base-image ${override} not found — no baseline`);
  } else if (repo) {
    const prefix = process.env.BASE_TAG_PREFIX || pr.base.ref;
    const { owner, repo: name } = context.repo as { owner: string; repo: string };
    const commits = (await github.rest.repos.listCommits({ owner, repo: name, sha: pr.base.ref, per_page: 15 })).data as Array<{ sha: string }>;
    for (const c of commits) {
      const tag = `${prefix}-${c.sha.slice(0, 7)}`;
      if (await imageExists(`${repo}:${tag}`, token)) { base = `${repo}:${tag}`; label = tag; break; }
    }
    if (!base) core.warning(`no ${repo}:${prefix}-<sha7> image among the last ${commits.length} commits of ${pr.base.ref} — head-only rundown`);
  }
  core.setOutput("base_image", base);
  core.setOutput("base_label", label);
  core.info(`head ${head} · base ${base || "(none)"}`);
}
