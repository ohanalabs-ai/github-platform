// 🩺 tracking-issue — ONE issue per scheduled check, never a pile of them: a failing run opens the issue (or adds a
// comment to the open one), a green run comments "green again" and closes it, a cancelled/skipped run does nothing.
// The identity is a hidden marker `<!-- github-platform/tracking-issue:<key> -->` in the issue body, so the title can
// change freely. First caller: planeodev/planeo-infra's nightly kagent fork-feature verifier (2026-10-27).
//
// env: KEY, TITLE, LABEL, OUTCOME (success|failure|cancelled|skipped — a job result), BODY (markdown, never a
// secret), CLOSE_ON_SUCCESS ("true"/"false"), RUN_URL. Every run writes a job summary of what it did (owner rule
// 2026-10-13) — including "nothing to do" and an API error.
import type { Ctx } from "../release-watch/types.ts";

export interface Issue { number: number; state: string; title: string; body?: string | null; html_url: string; pull_request?: unknown }

export type Action =
  | { action: "create" }
  | { action: "comment"; number: number }
  | { action: "close"; number: number }
  | { action: "none"; reason: string; number?: number };

export const marker = (key: string): string => `<!-- github-platform/tracking-issue:${key} -->`;

export function normalizeOutcome(raw: string): "success" | "failure" | "other" {
  const o = raw.trim().toLowerCase();
  if (o === "success") return "success";
  if (o === "failure") return "failure";
  return "other";
}

// Pure decision. `existing` = issues carrying the label (any state); only OPEN issues with our marker count —
// a closed one is history: the next failure opens a fresh issue (a regression is a new incident).
export function decide(existing: Issue[], key: string, outcome: string, closeOnSuccess: boolean): Action {
  const open = existing.find((i) => i.state === "open" && !i.pull_request && (i.body ?? "").includes(marker(key)));
  const o = normalizeOutcome(outcome);
  if (o === "failure") return open ? { action: "comment", number: open.number } : { action: "create" };
  if (o === "success") {
    if (!open) return { action: "none", reason: "green, no open tracking issue" };
    return closeOnSuccess ? { action: "close", number: open.number } : { action: "comment", number: open.number };
  }
  return { action: "none", reason: `outcome '${outcome || "unknown"}' — neither red nor green, left alone`, number: open?.number };
}

export function issueBody(key: string, body: string, runUrl: string): string {
  return [marker(key), "", body.trim(), "", `First failing run: ${runUrl}`, "",
    "_Opened by `ohanalabs-ai/github-platform` `actions/github/tracking-issue`: failing runs comment here, the next green run closes it._"].join("\n");
}

export function commentBody(outcome: string, body: string, runUrl: string): string {
  return normalizeOutcome(outcome) === "success"
    ? `✅ Green again: ${runUrl}`
    : [`❌ Still failing: ${runUrl}`, "", body.trim()].join("\n");
}

export function renderSummary(title: string, outcome: string, a: Action, url: string): string {
  const what = a.action === "create" ? `opened ${url}`
    : a.action === "comment" ? `commented on ${url}`
    : a.action === "close" ? `closed ${url} (green again)`
    : `nothing to do — ${a.reason}${url ? ` (${url})` : ""}`;
  return [`## 🩺 tracking issue — ${title}`, "", `| outcome | action |`, `|---|---|`, `| ${outcome || "unknown"} | ${what} |`, ""].join("\n");
}

export default async function run({ core, github, context }: Ctx): Promise<Action> {
  const env = process.env;
  const key = (env.KEY || "").trim();
  const title = (env.TITLE || "").trim();
  const label = (env.LABEL || "tracking").trim();
  const outcome = (env.OUTCOME || "").trim();
  const body = env.BODY || "";
  const closeOnSuccess = (env.CLOSE_ON_SUCCESS || "true") === "true";
  const runUrl = env.RUN_URL || "";
  const { owner, repo } = context.repo;
  let a: Action = { action: "none", reason: "not evaluated" };
  let url = "";
  try {
    if (!key || !title) throw new Error("inputs `key` and `title` are required");
    try {
      await github.rest.issues.getLabel({ owner, repo, name: label });
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((err as any)?.status !== 404) throw err;
      await github.rest.issues.createLabel({ owner, repo, name: label, color: "d93f0b", description: "A scheduled check is failing (tracking-issue)" });
    }
    const { data } = await github.rest.issues.listForRepo({ owner, repo, state: "open", labels: label, per_page: 100 });
    a = decide(data as Issue[], key, outcome, closeOnSuccess);
    if (a.action === "create") {
      const r = await github.rest.issues.create({ owner, repo, title, body: issueBody(key, body, runUrl), labels: [label] });
      url = r.data.html_url;
    } else if (a.action === "comment" || a.action === "close") {
      await github.rest.issues.createComment({ owner, repo, issue_number: a.number, body: commentBody(outcome, body, runUrl) });
      if (a.action === "close") await github.rest.issues.update({ owner, repo, issue_number: a.number, state: "closed", state_reason: "completed" });
      url = `https://github.com/${owner}/${repo}/issues/${a.number}`;
    } else if (a.number) {
      url = `https://github.com/${owner}/${repo}/issues/${a.number}`;
    }
    core.setOutput("action", a.action);
    core.setOutput("issue-url", url);
  } catch (err) {
    core.warning(`tracking issue not updated: ${(err as Error).message}`);
    a = { action: "none", reason: `error: ${(err as Error).message}` };
  } finally {
    await core.summary.addRaw(renderSummary(title || key, outcome, a, url)).write();
  }
  return a;
}
