// 🧾 workflow-summary-lint — owner rule 2026-10-13: EVERY workflow publishes a run summary of what it did.
// A workflow passes when it
//   1. writes one itself (GITHUB_STEP_SUMMARY, core.summary, or the actions/github/run-summary helper), or
//   2. uses a local action / loads a TypeScript helper under actions/ that writes one, or
//   3. is a pure CALLER (every job `uses:` a reusable workflow — the callee summarizes; the callee is
//      linted where it lives).
// Anything else fails, unless listed in ALLOWLIST with a reason (a tracked TODO — never silent).
// YAML is parsed with `yq -o=json` (preinstalled on GitHub runners; no npm).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export const SUMMARY_RE = /GITHUB_STEP_SUMMARY|core\.summary|actions\/github\/run-summary/;

// Workflows that do not summarize yet — each entry is a TODO with its reason (BACKLOG: summaries everywhere).
export const ALLOWLIST: Record<string, string> = {};

export interface Verdict { file: string; ok: boolean; how: string }

// The actions/<…> directories a workflow references: `uses: ./<anything>/actions/<a>/<b>` and helper
// imports like `…/actions/<a>/<b>/x.ts` (github-script).
export function referencedActionDirs(text: string): string[] {
  const dirs = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s/'"`])actions\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)/gm)) {
    dirs.add(`actions/${m[1].replace(/\/[^/]+\.(ts|ya?ml)$/, "")}`);
  }
  return [...dirs];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isPureCaller(wf: any): boolean {
  const jobs = wf?.jobs && typeof wf.jobs === "object" ? Object.values(wf.jobs) : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jobs.length > 0 && jobs.every((j: any) => typeof j?.uses === "string" && /\.ya?ml(@|$)/.test(j.uses));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classify(file: string, text: string, wf: any, dirSummarizes: (dir: string) => boolean, allow = ALLOWLIST): Verdict {
  if (SUMMARY_RE.test(text)) return { file, ok: true, how: "writes a summary" };
  const via = referencedActionDirs(text).find(dirSummarizes);
  if (via) return { file, ok: true, how: `via ${via}` };
  if (isPureCaller(wf)) return { file, ok: true, how: "pure caller of reusable workflows" };
  if (allow[file]) return { file, ok: true, how: `ALLOWLISTED (TODO): ${allow[file]}` };
  return { file, ok: false, how: "no run summary: write one (core.summary / GITHUB_STEP_SUMMARY / actions/github/run-summary in a final `if: always()` step)" };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : out.push(p); } };
  walk(dir);
  return out;
}

export function makeDirSummarizes(root: string): (dir: string) => boolean {
  const cache = new Map<string, boolean>();
  return (dir) => {
    if (!cache.has(dir)) cache.set(dir, filesUnder(join(root, dir)).some((f) => /\.(ts|ya?ml|sh)$/.test(f) && SUMMARY_RE.test(readFileSync(f, "utf8"))));
    return cache.get(dir) as boolean;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function run({ core, exec }: { core: any; exec: any }): Promise<void> {
  const root = process.env.REPO_ROOT || ".";
  const wfDir = join(root, ".github/workflows");
  const dirSummarizes = makeDirSummarizes(root);
  const verdicts: Verdict[] = [];
  for (const n of readdirSync(wfDir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const file = `.github/workflows/${n}`;
    const text = readFileSync(join(root, file), "utf8");
    const r = await exec.getExecOutput("yq", ["-o=json", ".", join(root, file)], { silent: true, ignoreReturnCode: true });
    const wf = r.exitCode === 0 ? JSON.parse(r.stdout || "{}") : {};
    verdicts.push(classify(file, text, wf, dirSummarizes));
  }
  const bad = verdicts.filter((v) => !v.ok);
  const md = ["## 🧾 workflow-summary-lint", "", `${verdicts.length} workflow(s), ${bad.length} without a run summary.`, "", "| Workflow | | How |", "|---|---|---|",
    ...verdicts.map((v) => `| \`${v.file}\` | ${v.ok ? (v.how.startsWith("ALLOWLISTED") ? "⚠️" : "✅") : "❌"} | ${v.how} |`), ""];
  await core.summary.addRaw(md.join("\n"), true).write();
  if (bad.length) core.setFailed(`${bad.length} workflow(s) publish no run summary (owner rule: every workflow summarizes what it did): ${bad.map((b) => b.file).join(", ")}`);
  else core.info(`all ${verdicts.length} workflows publish a run summary`);
}
