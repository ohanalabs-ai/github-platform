// Surface a `terraform apply|destroy` result where people look: one ERROR ANNOTATION per Terraform
// `Error:` block (title = the error + the resource address), and a job summary with the outcome and
// the resource counts. Without it a failed apply shows only "Process completed with exit code 1" and
// the cause sits deep in the raw log (planeodev/planeo-infra run 38155154144: two
// `tailscale_federated_identity` 404s, invisible from the run page).
//
// env: TF_OPERATION (apply|destroy), TF_OUTCOME (the step's outcome), TF_LOG_FILE (the tee'd output),
//      TF_WORKING_DIRECTORY (for the annotation's file path)
import { readFileSync, existsSync } from "node:fs";
import type { Ctx } from "./types.ts";

export interface TfError {
  summary: string; // the text after `Error: `
  address: string; // `with <address>,` — empty when the error is not tied to a resource
  file: string; // `on <file> line <n>` — relative to the root
  line: number;
  detail: string; // the indented body (provider message), trimmed
}

export interface TfCounts { added: number; changed: number; destroyed: number }

const ERROR_RE = /^(?:│\s*)?Error: (.+)$/;
const WITH_RE = /^(?:│\s*)?\s*with ([^,]+),\s*$/;
const ON_RE = /^(?:│\s*)?\s*on (\S+) line (\d+)/;

// Terraform prints each diagnostic as an `Error: <summary>` line followed by an indented body
// (framed by `│` when colour is on). A block ends at the next `Error:` / `Warning:` or at the
// apply/destroy footer.
export function parseErrors(text: string): TfError[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: TfError[] = [];
  let cur: TfError | null = null;
  let body: string[] = [];
  const flush = () => {
    if (!cur) return;
    cur.detail = body
      .map((l) => l.replace(/^│\s?/, ""))
      .filter((l) => !WITH_RE.test(l) && !ON_RE.test(l) && !/^\s*\d+:\s/.test(l))
      .join("\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
    out.push(cur);
    cur = null;
    body = [];
  };
  for (const raw of lines) {
    const m = raw.match(ERROR_RE);
    if (m) { flush(); cur = { summary: m[1].trim(), address: "", file: "", line: 0, detail: "" }; continue; }
    if (!cur) continue;
    if (/^(?:│\s*)?Warning: /.test(raw) || /^(Apply complete|Destroy complete|Plan:)/.test(raw)) { flush(); continue; }
    const w = raw.match(WITH_RE);
    if (w && !cur.address) cur.address = w[1].trim();
    const o = raw.match(ON_RE);
    if (o && !cur.file) { cur.file = o[1]; cur.line = Number(o[2]); }
    body.push(raw);
  }
  flush();
  return out;
}

export function parseCounts(text: string): TfCounts | null {
  const full = text.match(/Resources: (\d+) added, (\d+) changed, (\d+) destroyed/);
  if (full) return { added: +full[1], changed: +full[2], destroyed: +full[3] };
  const destroyOnly = text.match(/Resources: (\d+) destroyed/);
  return destroyOnly ? { added: 0, changed: 0, destroyed: +destroyOnly[1] } : null;
}

export function summaryMarkdown(op: string, outcome: string, errors: TfError[], counts: TfCounts | null): string {
  const ok = outcome === "success";
  const icon = op === "destroy" ? "🧨" : "🚀";
  const md: string[] = [`## ${icon} terraform ${op}: ${ok ? "✅ succeeded" : "❌ " + (outcome || "failed")}`, ""];
  if (counts) md.push(`Resources: **${counts.added}** added, **${counts.changed}** changed, **${counts.destroyed}** destroyed.`, "");
  if (errors.length) {
    md.push(`### ${errors.length} error${errors.length > 1 ? "s" : ""}`, "", "| Resource | Error | Detail |", "|---|---|---|");
    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    for (const e of errors) md.push(`| \`${e.address || "—"}\` | ${cell(e.summary)} | ${cell(e.detail) || "—"} |`);
    md.push("");
  } else if (!ok) {
    md.push("No Terraform `Error:` block found in the output — the step failed before or outside Terraform; read the step log.", "");
  }
  return md.join("\n");
}

export default async function run({ core }: Ctx): Promise<void> {
  const op = process.env.TF_OPERATION || "apply";
  const outcome = process.env.TF_OUTCOME || "";
  const file = process.env.TF_LOG_FILE || "";
  const wd = (process.env.TF_WORKING_DIRECTORY || ".").replace(/\/+$/, "");
  const text = file && existsSync(file) ? readFileSync(file, "utf8") : "";
  const errors = parseErrors(text);
  const counts = parseCounts(text);
  for (const e of errors) {
    const title = `terraform ${op}: ${e.summary}${e.address ? ` — ${e.address}` : ""}`;
    const props = e.file ? { title, file: `${wd}/${e.file}`.replace(/^\.\//, ""), startLine: e.line } : { title };
    core.error(e.detail || e.summary, props);
  }
  core.setOutput("error-count", errors.length);
  await core.summary.addRaw(summaryMarkdown(op, outcome, errors, counts), true).write();
  core.info(`terraform ${op}: outcome=${outcome} errors=${errors.length}${counts ? ` added=${counts.added} changed=${counts.changed} destroyed=${counts.destroyed}` : ""}`);
}
