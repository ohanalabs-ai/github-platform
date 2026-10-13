// The vionix signing canary's run summary — ALWAYS written (owner rule 2026-10-13: every workflow
// publishes what it did on every outcome path, never secrets). Renders the outcome of each stage of
// the canary (build → scan → attest → verify, or the digest-sign request) from the `needs` context.
//
// env: MODE (image|digest), NEEDS (toJSON(needs)), ORG, RUN_URL, REF
import type { Ctx } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Needs = Record<string, { result?: string; outputs?: Record<string, string> }>;

const icon = (r?: string) => ({ success: "✅", failure: "❌", cancelled: "⏹️", skipped: "⏭️" } as Record<string, string>)[r || ""] || "❔";

export function verdict(mode: string, needs: Needs): { ok: boolean; reason: string } {
  const stages = mode === "digest" ? ["sign-digest"] : ["build", "scan", "attest", "verify"];
  const bad = stages.filter((s) => needs[s]?.result !== "success");
  if (mode !== "digest" && needs.attest?.outputs?.signed !== "true") bad.push("attest (not signed)");
  return bad.length ? { ok: false, reason: `not proven: ${[...new Set(bad)].join(", ")}` } : { ok: true, reason: "the signing chain is proven end to end" };
}

export function summaryMarkdown(mode: string, needs: Needs, org: string, ref: string, runUrl: string): string {
  const v = verdict(mode, needs);
  const out: string[] = [`## 🐤 vionix signing canary (${org}, ${mode}) — ${v.ok ? "✅ PASS" : "❌ FAIL"}`, "", v.reason, ""];
  out.push("| stage | result | facts |", "|---|---|---|");
  if (mode === "digest") {
    const s = needs["sign-digest"];
    out.push(`| 🔏 sign digest (Vault Transit) | ${icon(s?.result)} ${s?.result || "—"} | key v${s?.outputs?.["key-version"] || "?"}, verified with the public key: ${s?.outputs?.verified || "—"} |`);
  } else {
    const b = needs.build, sc = needs.scan, a = needs.attest, ve = needs.verify;
    out.push(`| 🧱 build (docker-multiarch-cicd) | ${icon(b?.result)} ${b?.result || "—"} | \`${b?.outputs?.image_ref || "—"}\` · builder \`${b?.outputs?.builder_id || "—"}\` |`);
    out.push(`| 🛡️ scan (docker-image-security) | ${icon(sc?.result)} ${sc?.result || "—"} | status ${sc?.outputs?.status || "—"}, critical ${sc?.outputs?.["critical-count"] ?? "—"}, high ${sc?.outputs?.["high-count"] ?? "—"} (report-only) |`);
    out.push(`| 🔏 attest (docker-image-attest, provenance + SBOM) | ${icon(a?.result)} ${a?.result || "—"} | signed ${a?.outputs?.signed || "—"} · key \`${a?.outputs?.["key-ref"] || "—"}\` (no transparency log) |`);
    out.push(`| ✔️ verify (public key only + approved-build CUE) | ${icon(ve?.result)} ${ve?.result || "—"} | independent of Vault and the cluster |`);
  }
  out.push("", `Ref \`${ref}\` · [run](${runUrl}). Signing runs only on push / workflow_dispatch of main or develop (the org's Vault signer role).`);
  return out.join("\n") + "\n";
}

export default async function run({ core }: Ctx): Promise<void> {
  let needs: Needs = {};
  try { needs = JSON.parse(process.env.NEEDS || "{}"); } catch { /* render with what we have */ }
  const mode = process.env.MODE === "digest" ? "digest" : "image";
  await core.summary.addRaw(summaryMarkdown(mode, needs, process.env.ORG || "", process.env.REF || "", process.env.RUN_URL || ""), true).write();
  const v = verdict(mode, needs);
  if (!v.ok) core.setFailed(v.reason);
}
