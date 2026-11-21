// ⏳ preview deployed — between 🔎 preview ready and 👀 visual review: wait until the CLUSTER says the preview runs THIS commit and
// passed its in-cluster smoke test, i.e. the commit status `CONTEXT` (default preview/deployed) is `success` on the PR head sha.
// The runner never reaches the cluster (the preview is internal + SSO): the signal comes back as a commit status, set by the
// GitOps side (Argo CD Notifications). Pure logic + tests: deploy-status.ts / deploy-status.test.ts.
// Env: CONTEXT, WAIT_MINUTES, ARGOCD_APP (optional, for the failure message).
import type { Ctx } from "./types.ts";
import { verdict, timeoutMessage, type CommitStatus, type Verdict } from "./deploy-status.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function run({ core, github, context }: Ctx): Promise<void> {
  const ctxName = process.env.CONTEXT || "preview/deployed";
  const waitMin = Number(process.env.WAIT_MINUTES || "20");
  const app = process.env.ARGOCD_APP || "";
  const pr = context.payload?.pull_request;
  if (!pr) return core.setFailed("⏳ preview deployed runs on pull_request events only");
  const sha: string = pr.head.sha;
  const { owner, repo } = context.repo as { owner: string; repo: string };

  const deadline = Date.now() + waitMin * 60_000;
  let last: Verdict = { kind: "waiting", state: "absent", description: "", url: "" };
  let lastLine = "";
  for (;;) {
    const res = await github.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 });
    last = verdict((res.data.statuses || []) as CommitStatus[], ctxName);
    if (last.kind === "deployed") break;
    const line = `${ctxName}: ${last.state}${last.description ? ` — ${last.description}` : ""}`;
    if (line !== lastLine) core.info(`${new Date().toISOString()} ${line}`);
    lastLine = line;
    if (Date.now() > deadline) return core.setFailed(timeoutMessage(ctxName, waitMin, last, app));
    await sleep(20_000);
  }
  core.setOutput("url", last.url);
  await core.summary
    .addRaw(`### ⏳ preview deployed\n\n✅ \`${ctxName}\` = success on \`${sha.slice(0, 7)}\`${last.description ? `: ${last.description}` : ""}` +
      `${last.url ? `\n\n**Live:** ${last.url}` : ""}\n`, true)
    .write();
  core.notice(`preview deployed + verified on ${sha.slice(0, 7)}${last.url ? `: ${last.url}` : ""}`);
}
