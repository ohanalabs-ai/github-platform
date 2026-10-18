// 🐙 The GitHub-facing side shared by test/junit-report and test/coverage-report: report-file discovery
// (github-script's injected `glob`), the sticky PR comment and the check run. Every API call degrades to a
// warning (a fork PR's read-only token, a caller without `pull-requests: write` / `checks: write`) —
// publishing a report must never be the reason a job fails.
import { statSync } from "node:fs";
import { relative, resolve } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Ctx { core: any; github: any; context: any; glob: any; exec?: any }

/** A directory entry becomes `<dir>/**\/*.<ext>` for each default extension; globs/files pass through. */
export function expandPatterns(entries: string[], isDir: (p: string) => boolean, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const neg = e.startsWith("!");
    const p = neg ? e.slice(1) : e;
    if (!neg && !/[*?[\]{}]/.test(p) && isDir(p)) {
      for (const x of exts) out.push(`${p.replace(/\/+$/, "")}/**/*.${x}`);
    } else out.push(e);
  }
  return out;
}

const isDirectory = (p: string): boolean => { try { return statSync(resolve(process.env.GITHUB_WORKSPACE || ".", p)).isDirectory(); } catch { return false; } };

/** Absolute, de-duplicated, sorted report files matching the caller's paths (relative to the workspace). */
export async function findReportFiles(glob: any, entries: string[], exts: string[]): Promise<string[]> {
  const patterns = expandPatterns(entries, isDirectory, exts);
  if (!patterns.length) return [];
  const globber = await glob.create(patterns.join("\n"), { matchDirectories: false, followSymbolicLinks: true });
  const files: string[] = await globber.glob();
  return [...new Set(files)].sort();
}

/** A path as shown to humans / used in check annotations: relative to the workspace when inside it. */
export function displayPath(p: string, workspace = process.env.GITHUB_WORKSPACE || process.cwd()): string {
  const r = relative(workspace, p);
  return r && !r.startsWith("..") ? r : p;
}

export const commentMarker = (key: string): string => `<!-- github-platform/actions/test:${key} -->`;

export interface PublishResult { ok: boolean; detail: string }

const why = (e: any): string => {
  const s = e?.status;
  if (s === 403 || s === 404) return `HTTP ${s} — the token cannot write here (fork PR, or the job lacks the permission)`;
  return String(e?.message || e).slice(0, 200);
};

/** Sticky PR comment, recreated on every run (the old workflow's marocchino/sticky-pull-request-comment `recreate: true`). */
export async function stickyComment({ github, context }: Ctx, key: string, body: string): Promise<PublishResult> {
  const pr = context.payload?.pull_request?.number ?? (context.eventName === "issue_comment" ? context.payload?.issue?.number : undefined);
  if (!pr) return { ok: false, detail: "not a pull_request event — no comment" };
  const marker = commentMarker(key);
  const { owner, repo } = context.repo;
  try {
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr, per_page: 100 });
    for (const c of comments as Array<{ id: number; body?: string }>) {
      if ((c.body || "").startsWith(marker)) await github.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
    }
    const r = await github.rest.issues.createComment({ owner, repo, issue_number: pr, body: `${marker}\n${body}` });
    return { ok: true, detail: r?.data?.html_url || `PR #${pr}` };
  } catch (e) {
    return { ok: false, detail: `comment not posted: ${why(e)} — needs \`pull-requests: write\`` };
  }
}

export interface Annotation { path: string; start_line: number; end_line: number; annotation_level: "failure" | "warning" | "notice"; title: string; message: string }

/** One completed check run on the PR head (or pushed) commit, with up to 50 annotations (the API's per-request cap). */
export async function checkRun(
  { github, context }: Ctx,
  name: string,
  conclusion: "success" | "failure" | "neutral",
  title: string,
  summary: string,
  annotations: Annotation[],
): Promise<PublishResult> {
  const { owner, repo } = context.repo;
  const head_sha = context.payload?.pull_request?.head?.sha || context.sha;
  try {
    const r = await github.rest.checks.create({
      owner, repo, name, head_sha, status: "completed", conclusion,
      output: { title, summary, annotations: annotations.slice(0, 50) },
    });
    return { ok: true, detail: r?.data?.html_url || name };
  } catch (e) {
    return { ok: false, detail: `check run not created: ${why(e)} — needs \`checks: write\`` };
  }
}

export function runUrl(context: any): string {
  const server = context?.serverUrl || process.env.GITHUB_SERVER_URL || "https://github.com";
  const { owner, repo } = context?.repo || {};
  return owner && context?.runId ? `${server}/${owner}/${repo}/actions/runs/${context.runId}` : "";
}
