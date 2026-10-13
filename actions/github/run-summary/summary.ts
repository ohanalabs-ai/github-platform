// 📋 run summary — the final `if: always()` step every reusable workflow ends its jobs with (owner rule
// 2026-10-13: every workflow publishes what it did, on every outcome). Renders the job's steps (the
// `steps` context, toJSON) with their outcomes, plus selected non-secret facts. Steps need an `id` to
// appear. Callers pass outcomes explicitly — NOT toJSON(steps), which would hand every step's outputs
// (a Vault login's secrets included) to this step's environment. Facts are named, non-secret values.
//
// env: TITLE, STEP_OUTCOMES (lines "<label>=<outcome>"), FACTS (lines "<label>=<value>"), JOB_STATUS
export interface StepState { outcome?: string; conclusion?: string; outputs?: Record<string, string> }

const ICON: Record<string, string> = { success: "✅", failure: "❌", skipped: "⏭️", cancelled: "🚫" };

export function renderRunSummary(
  title: string,
  steps: Record<string, StepState>,
  labels: Record<string, string> = {},
  factOutputs: string[] = [],
  facts: Record<string, string> = {},
  jobStatus = "",
): string {
  const md: string[] = [`## 📋 ${title}${jobStatus ? ` — ${ICON[jobStatus] || ""} ${jobStatus}` : ""}`, ""];
  const ids = Object.keys(steps);
  if (ids.length) {
    md.push("| Step | Outcome |", "|---|---|");
    for (const id of ids) {
      const o = steps[id]?.outcome || "—";
      md.push(`| ${labels[id] || id} | ${ICON[o] || ""} ${o} |`);
    }
    md.push("");
  }
  const rows: [string, string][] = [];
  for (const ref of factOutputs) {
    const [id, out] = ref.split(".");
    const v = steps[id]?.outputs?.[out];
    if (v !== undefined && v !== "") rows.push([`${labels[id] || id} · ${out}`, v]);
  }
  for (const [k, v] of Object.entries(facts)) if (v !== undefined && v !== "") rows.push([k, v]);
  if (rows.length) {
    md.push("| Fact | Value |", "|---|---|");
    for (const [k, v] of rows) md.push(`| ${k} | \`${String(v).replace(/\|/g, "\\|").replace(/`/g, "'")}\` |`);
    md.push("");
  }
  return md.join("\n");
}

export function parseLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text || "").split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function parseOutcomes(text: string): Record<string, StepState> {
  const out: Record<string, StepState> = {};
  for (const line of (text || "").split("\n")) {
    const i = line.lastIndexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = { outcome: line.slice(i + 1).trim() || "skipped" };
  }
  return out;
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function run({ core }: { core: any }): Promise<void> {
  const env = process.env;
  const md = renderRunSummary(env.TITLE || "run summary", parseOutcomes(env.STEP_OUTCOMES || ""), {}, [], parseLines(env.FACTS || ""), env.JOB_STATUS || "");
  await core.summary.addRaw(md, true).write();
}
