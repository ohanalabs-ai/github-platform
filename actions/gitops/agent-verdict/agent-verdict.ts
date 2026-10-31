// 🤖 agent-verdict — the MACHINE-READABLE decision of a 🚦 gitops gate (contract planeo.dev/gitops-gate/v1).
// Reads every group's group.json (actions/gitops/group-report, downloaded as the gitops-group-* artifacts) and
// the caller's `toJson(needs)`, maps each unit's render + live status to ONE decision and the gate to ONE verdict,
// and writes gate.json + a "🤖 Agent decision" summary section. Agents (the Principal Engineer, the DevSecOps
// specialist) read gate.json instead of parsing comments and logs: a `not_verified` entry means the live
// `argocd app diff` was NOT run for that unit — an agent must never claim it was.
//
// It only reshapes what group.json already holds (names, paths, statuses, counts) — never a secret.
//
// env: GROUPS_DIR, RESULTS (toJson(needs)), TITLE, MODE, OUT (gate.json path), AGENT_MD (markdown for the sticky comment)
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA = "planeo.dev/gitops-gate/v1";

export type Decision =
  | "merge-ok" // the live diff ran and the change is what the PR says (or a verdict that explains an empty diff)
  | "live-ok" // mode=refresh: the merge landed — Synced, Healthy, at the merged SHA
  | "merge-ok-render-only" // passes, but the live half did not run (listed in not_verified)
  | "review-new-app" // a new Application: the rendered diff is the whole change — a human reviews it
  | "fix-render" // the unit does not build
  | "fix-live-error" // ArgoCD returned an error (or the post-merge validation failed)
  | "blocked-noop" // the PR changes nothing live and nothing explains it — explain it or close the PR
  | "needs-human"; // a status this contract does not know — never guess

export type Verdict = "pass" | "no-change" | "blocked" | "failed";

export interface GroupUnit {
  app: string; tier?: string; path?: string; render?: string; render_mode?: string; kinds?: number; new?: boolean;
  added?: number; changed?: number; removed?: number; diff_bytes?: number; act_status?: string; changed_files?: string[];
}
export interface GroupJson { cluster: string; group: string; mode?: string; units: GroupUnit[] }

export interface GateUnit {
  cluster: string; group: string; app: string; path: string; render: string; act_status: string; new: boolean;
  added: number; changed: number; removed: number; decision: Decision; reason: string;
}
export interface Gate {
  schema: string; title: string; mode: string; repository: string; pr: number | null; sha: string; run_url: string;
  verdict: Verdict; groups: { name: string; result: string }[]; units: GateUnit[]; not_verified: string[]; next_actions: string[];
}

const BLOCKING: Decision[] = ["fix-render", "fix-live-error", "blocked-noop", "needs-human"];
const PASS_LIVE = new Set(["diff", "noop-live-equal", "noop-expected", "noop-prune-nothing", "noop-allowed", "meta"]);
const NOT_LIVE = new Set(["skipped-no-argocd", "skipped-no-tailnet", "render-only", "build-only", "external", "—", "", "?"]);
const LIVE_ERROR = new Set(["error", "refresh-failed", "validate-failed"]);

/** One unit's render + live status → its decision and a one-line reason. */
export function decide(u: GroupUnit): { decision: Decision; reason: string } {
  const render = u.render ?? "?";
  const act = u.act_status ?? "—";
  if (render === "failed") return { decision: "fix-render", reason: `the unit does not build (${u.path ?? u.app})` };
  if (LIVE_ERROR.has(act)) return { decision: "fix-live-error", reason: `live step ${act}` };
  if (act === "noop") return { decision: "blocked-noop", reason: "the render changes nothing ArgoCD would apply and nothing explains it — explain the intent or close the PR" };
  if (act === "new") return { decision: "review-new-app", reason: `not in ArgoCD yet — the rendered ${u.kinds ?? 0} object(s) are the whole change` };
  if (act === "validated" || act === "refreshed") return { decision: "live-ok", reason: `post-merge ${act}` };
  if (PASS_LIVE.has(act)) {
    const why: Record<string, string> = {
      diff: `live diff +${u.added ?? 0} ~${u.changed ?? 0} −${u.removed ?? 0}`,
      "noop-live-equal": "the cluster already carries the rendered change (git catches up)",
      "noop-expected": "no rendered change for this Application (another Application renders the files)",
      "noop-prune-nothing": "only removals, none of them live",
      "noop-allowed": "live no-op ALLOWED by block-noop=false — say why in the PR",
      meta: "docs/meta files only",
    };
    return { decision: "merge-ok", reason: why[act] };
  }
  if (NOT_LIVE.has(act) || act.startsWith("skipped")) {
    if (render === "external") return { decision: "merge-ok-render-only", reason: "source in another repository — not diffed here" };
    return { decision: "merge-ok-render-only", reason: `rendered only — live diff not run (${act === "—" || act === "" ? "no live step" : act})` };
  }
  return { decision: "needs-human", reason: `unknown live status '${act}' (render ${render})` };
}

/** Group results + units → the gate. Pure; `meta` carries the run identity. */
export function buildGate(
  groups: GroupJson[],
  results: Record<string, { result?: string }>,
  meta: { title: string; mode: string; repository: string; pr: number | null; sha: string; run_url: string },
): Gate {
  const units: GateUnit[] = [];
  for (const g of groups) {
    for (const u of g.units ?? []) {
      const { decision, reason } = decide(u);
      units.push({
        cluster: g.cluster, group: g.group, app: u.app, path: u.path ?? "", render: u.render ?? "?", act_status: u.act_status ?? "—",
        new: Boolean(u.new), added: u.added ?? 0, changed: u.changed ?? 0, removed: u.removed ?? 0, decision, reason,
      });
    }
  }
  const groupRows = Object.entries(results ?? {}).map(([name, v]) => ({ name, result: v?.result ?? "unknown" }));
  const failedGroups = groupRows.filter((g) => g.result === "failure" || g.result === "cancelled");
  const blocking = units.filter((u) => BLOCKING.includes(u.decision));

  let verdict: Verdict;
  if (failedGroups.length) verdict = "failed";
  else if (blocking.length) verdict = "blocked";
  else if (units.length === 0) verdict = "no-change";
  else verdict = "pass";

  const not_verified = units
    .filter((u) => u.decision === "merge-ok-render-only")
    .map((u) => `live argocd ${meta.mode} not run for ${u.app} (${u.cluster}/${u.group}): ${u.act_status === "—" ? "no live step" : u.act_status}`);

  const next_actions: string[] = [];
  for (const g of failedGroups) {
    next_actions.push(`group ${g.name} ${g.result}: open its 🧪 kustomize check / 📋 result jobs — ${meta.run_url}`);
  }
  for (const u of blocking) {
    if (u.decision === "fix-render") next_actions.push(`fix the render of ${u.path || u.app} (open the 🧩 render ${u.app} job: ${meta.run_url})`);
    else if (u.decision === "fix-live-error") next_actions.push(`open the 🔍 diff ${u.app} job log and fix the ArgoCD error: ${meta.run_url}`);
    else if (u.decision === "blocked-noop") next_actions.push(`${u.app}: the PR changes nothing live — state why in the PR (a value at the wrong key? already applied?) or close it`);
    else next_actions.push(`${u.app}: unknown status '${u.act_status}' — ask a human; do not guess`);
  }
  for (const u of units.filter((x) => x.decision === "review-new-app")) {
    next_actions.push(`${u.app}: new Application — review the rendered objects (the whole change) before merge`);
  }
  if (verdict === "pass" || verdict === "no-change") {
    next_actions.push(
      `ready for human review/merge — agents never merge${not_verified.length ? `; ${not_verified.length} unit(s) NOT live-verified (see not_verified)` : ""}`,
    );
  }
  return { schema: SCHEMA, ...meta, verdict, groups: groupRows, units, not_verified, next_actions };
}

const ICON: Record<Verdict, string> = { pass: "✅", "no-change": "⚪", blocked: "⛔", failed: "❌" };

/** The "🤖 Agent decision" markdown (job summary + the gate's sticky comment). */
export function renderAgentMarkdown(gate: Gate, collapsed = false): string {
  const md: string[] = [];
  const body: string[] = [];
  body.push(`**Verdict: ${ICON[gate.verdict]} \`${gate.verdict}\`** — ${gate.units.length} unit(s), ${gate.groups.length} group(s), mode \`${gate.mode}\``, "");
  if (gate.units.length) {
    body.push("| unit | cluster / group | decision | reason |", "|---|---|---|---|");
    for (const u of gate.units) body.push(`| \`${u.app}\` | ${u.cluster} / ${u.group} | \`${u.decision}\` | ${u.reason.replace(/\|/g, "\\|")} |`);
    body.push("");
  }
  if (gate.not_verified.length) body.push("**Not verified** (never claim these):", ...gate.not_verified.map((s) => `- ${s}`), "");
  if (gate.next_actions.length) body.push("**Next actions:**", ...gate.next_actions.map((s) => `- ${s}`), "");
  body.push("<details><summary><code>gate.json</code></summary>", "", "```json", JSON.stringify(gate, null, 2), "```", "", "</details>", "");
  if (collapsed) {
    md.push(`<details><summary>🤖 Agent decision — gitops-gate/v1: ${ICON[gate.verdict]} ${gate.verdict}</summary>`, "", ...body, "</details>", "");
  } else {
    md.push("## 🤖 Agent decision — gitops-gate/v1", "", ...body);
  }
  return md.join("\n");
}

export function readGroups(dir: string): GroupJson[] {
  const out: GroupJson[] = [];
  const walk = (d: string): void => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^group.*\.json$/.test(n)) {
        try { out.push(JSON.parse(readFileSync(p, "utf8")) as GroupJson); } catch { /* a broken fragment is reported by the gate summary */ }
      }
    }
  };
  walk(dir);
  return out;
}

interface Core { setOutput(k: string, v: string): void; info(m: string): void; summary: { addRaw(s: string, eol?: boolean): { write(): Promise<unknown> } } }
interface Ctx { repo: { owner: string; repo: string }; sha: string; serverUrl?: string; runId: number; payload: { pull_request?: { number: number; head?: { sha?: string } } } }

export default async function run({ core, context }: { core: Core; context: Ctx }): Promise<void> {
  const env = process.env;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const pr = context.payload.pull_request?.number ?? null;
  const gate = buildGate(readGroups(env.GROUPS_DIR || "groups"), JSON.parse(env.RESULTS || "{}"), {
    title: env.TITLE || "GitOps",
    mode: env.MODE || "diff",
    repository,
    pr,
    sha: context.payload.pull_request?.head?.sha || context.sha,
    run_url: `${context.serverUrl || "https://github.com"}/${repository}/actions/runs/${context.runId}`,
  });
  const out = env.OUT || "gate.json";
  writeFileSync(out, JSON.stringify(gate, null, 2) + "\n");
  if (env.AGENT_MD) writeFileSync(env.AGENT_MD, renderAgentMarkdown(gate, true));
  await core.summary.addRaw(renderAgentMarkdown(gate), true).write();
  core.setOutput("verdict", gate.verdict);
  core.setOutput("gate-json", out);
  core.info(`gitops-gate/v1 verdict: ${gate.verdict} (${gate.units.length} units, ${gate.not_verified.length} not live-verified) → ${out}`);
}
