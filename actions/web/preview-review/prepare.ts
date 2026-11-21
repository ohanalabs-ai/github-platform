// 🔎 preview ready — the job BEFORE the visual-review gate:
//   1. wait until the PR's preview image exists in GHCR (the tag the GitOps preview deploys, e.g. pr/<N>:head-<head sha>);
//   2. optionally probe the preview URL (only from a runner that can reach it — e.g. on the tailnet; off by default);
//   3. build the "what to verify visually" checklist from the PR's changed files + the caller's rules file;
//   4. write it to the run summary (the same page as GitHub's "Review deployments" button), the job output, and ONE sticky
//      PR comment (hidden marker, edited in place).
// Env: URL, IMAGE, ENVIRONMENT, RULES_FILE, WAIT_MINUTES, PROBE_URL ("true"|"false"), GH_TOKEN.
import { existsSync, readFileSync } from "node:fs";
import type { Ctx } from "./types.ts";
import { parseRules, render, sections, type Rules } from "./checklist.ts";

const MARKER = "<!-- web-preview-review -->";
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function splitImage(image: string): { registry: string; name: string; tag: string } {
  const m = /^([^/@]+)\/([^@]+):([^:/@]+)$/.exec(image);
  if (!m) throw new Error(`image must be <registry>/<name>:<tag>, got ${JSON.stringify(image)}`);
  return { registry: m[1], name: m[2], tag: m[3] };
}

export async function imageExists(image: string, token: string): Promise<boolean> {
  const { registry, name, tag } = splitImage(image);
  const auth = await fetch(`https://${registry}/token?service=${registry}&scope=repository:${name}:pull`, {
    headers: { Authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` },
  });
  if (!auth.ok) throw new Error(`${registry} token endpoint answered ${auth.status} (the job needs packages: read)`);
  const { token: bearer } = (await auth.json()) as { token: string };
  const res = await fetch(`https://${registry}/v2/${name}/manifests/${tag}`, { method: "HEAD", headers: { Authorization: `Bearer ${bearer}`, Accept: ACCEPT } });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`HEAD manifest ${image} answered ${res.status}`);
}

export default async function run({ core, github, context }: Ctx): Promise<void> {
  const url = process.env.URL || "";
  const image = process.env.IMAGE || "";
  const environment = process.env.ENVIRONMENT || "";
  const waitMin = Number(process.env.WAIT_MINUTES || "25");
  const token = process.env.GH_TOKEN || "";
  const pr = context.payload?.pull_request;
  if (!pr) return core.setFailed("web-preview-review runs on pull_request events only");
  const headSha: string = pr.head.sha;

  // 1. the image
  const deadline = Date.now() + waitMin * 60_000;
  let found = false;
  for (let attempt = 1; ; attempt++) {
    found = await imageExists(image, token);
    if (found || Date.now() > deadline) break;
    core.info(`waiting for ${image} (attempt ${attempt}) …`);
    await sleep(20_000);
  }
  if (!found) return core.setFailed(`the preview image ${image} does not exist after ${waitMin} min — did the PR build push its head tag?`);
  let ready = "✅ image pushed — the preview rolls out within ~2 min of it (the GitOps generator polls)";

  // 2. optional reachability probe (a 302 to the SSO login counts as up)
  if (process.env.PROBE_URL === "true") {
    let status = 0;
    while (Date.now() < deadline) {
      try { status = (await fetch(url, { redirect: "manual" })).status; } catch { status = 0; }
      if (status > 0 && status < 500) break;
      core.info(`waiting for ${url} (last status ${status || "unreachable"}) …`);
      await sleep(20_000);
    }
    if (!(status > 0 && status < 500)) return core.setFailed(`${url} did not answer (< 500) within ${waitMin} min`);
    ready = `✅ image pushed and ${url} answers (${status})`;
  }

  // 3. checklist
  const { owner, repo } = context.repo as { owner: string; repo: string };
  const files = (await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 })) as Array<{ filename: string }>;
  const changed = files.map((f) => f.filename);
  const rulesFile = process.env.RULES_FILE || "";
  let rules: Rules = { rules: [], generic: [] };
  if (rulesFile && existsSync(rulesFile)) rules = parseRules(readFileSync(rulesFile, "utf8"));
  else if (rulesFile) core.warning(`rules file ${rulesFile} not found — generic checklist only`);
  const md = render(rules, sections(rules, changed), { url, image, headSha, environment, ready, changedCount: changed.length });

  // 4. outputs: run summary, job output, sticky PR comment
  await core.summary.addRaw(md, true).write();
  core.setOutput("checklist", md);
  const body = `${MARKER}\n${md}`;
  const comments = (await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 })) as Array<{ id: number; body?: string }>;
  const mine = comments.find((c) => (c.body || "").startsWith(MARKER));
  if (mine) await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  else await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
}
