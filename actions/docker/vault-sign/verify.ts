// 🛡️ Independent verification of a Vault-Transit-signed image — runs in the 🛡️ slsa job, which has
// NO Vault access: only the exported PUBLIC key (build-job output) and the registry. Same checks as
// admission: `cosign verify --key` + `cosign verify-attestation --type slsaprovenance1 --policy <the
// org's approved-build CUE>`. Emits the outputs the ohanalabs-ai/actions docker/slsa-report action
// emits, so the workflow's summary / PR comment / release steps stay mechanism-agnostic.
//
// env: SUBJECT, SIGNED (true|false from the build), SIGN_REASON, PUBLIC_KEY_B64, KEY_REF, ORG,
//      SIGNER_WORKFLOW, SLSA_BUILD_LEVEL, TITLE, FAIL_ON_UNVERIFIED (default true)
// outputs: verified, attested_by, status, summary_markdown, verification_command, declared_slsa_build_level
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { admissionCue, cosignMajor, verifyFlags } from "./policy.ts";
import type { Ctx } from "./types.ts";

export function consumerCommand(subject: string, keyRef: string): string {
  return [
    `cosign public-key --key ${keyRef} > cosign.pub   # or the org's pinned public key`,
    `cosign verify --key cosign.pub --insecure-ignore-tlog=true ${subject}`,
    `cosign verify-attestation --key cosign.pub --insecure-ignore-tlog=true --type slsaprovenance1 ${subject}`,
  ].join("\n");
}

export function reportMarkdown(r: { title: string; status: string; subject: string; keyRef: string; reason: string; level: string }): string {
  const icon = r.status === "verified" ? "✅ verified (vault)" : r.status === "not-attested" ? "❕ not attested (informational)" : "❌ verification failed";
  const lines = [
    `### ${r.title}`, "",
    "| | |", "|---|---|",
    `| Status | ${icon} |`,
    `| Subject | \`${r.subject}\` |`,
    `| Trust root | \`${r.keyRef || "—"}\` (org Vault Transit key, no transparency log) |`,
    `| Declared SLSA Build level | \`${r.level}\` |`,
  ];
  if (r.reason) lines.push(`| Note | ${r.reason} |`);
  if (r.status !== "not-attested") lines.push("", "```bash", consumerCommand(r.subject, r.keyRef), "```");
  return lines.join("\n");
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const e = process.env;
  const subject = e.SUBJECT || "";
  const keyRef = e.KEY_REF || "";
  const level = e.SLSA_BUILD_LEVEL || "2";
  const title = e.TITLE || "SLSA verification";
  const out = (status: string, verified: boolean, reason: string) => {
    core.setOutput("verified", String(verified));
    core.setOutput("attested_by", verified ? "vault" : "none");
    core.setOutput("status", status);
    core.setOutput("declared_slsa_build_level", level);
    core.setOutput("verification_command", consumerCommand(subject, keyRef));
    core.setOutput("summary_markdown", reportMarkdown({ title, status, subject, keyRef, reason, level }));
  };
  if (e.SIGNED !== "true") {
    const reason = e.SIGN_REASON || (e.GITHUB_EVENT_NAME === "pull_request"
      ? "pull_request runs never sign (merged-PR build) — the push build of the merge commit signs"
      : "the build did not sign this digest");
    out("not-attested", false, reason);
    core.notice(`❕ ${subject} not attested: ${reason}`);
    return;
  }
  const pub = Buffer.from(e.PUBLIC_KEY_B64 || "", "base64").toString("utf8");
  const tmp = e.RUNNER_TEMP || "/tmp";
  const pubFile = join(tmp, "cosign-verify.pub");
  const cueFile = join(tmp, "approved-build-verify.cue");
  writeFileSync(pubFile, pub);
  writeFileSync(cueFile, admissionCue({ org: e.ORG || "", signerWorkflow: e.SIGNER_WORKFLOW || "" }));
  const major = cosignMajor((await exec.getExecOutput("cosign", ["version", "--json"], { silent: true, ignoreReturnCode: true })).stdout);
  const vf = verifyFlags(major);
  const sig = await exec.getExecOutput("cosign", ["verify", "--key", pubFile, ...vf, subject], { silent: true, ignoreReturnCode: true });
  const att = sig.exitCode === 0
    ? await exec.getExecOutput("cosign", ["verify-attestation", "--key", pubFile, ...vf, "--type", "slsaprovenance1", "--policy", cueFile, subject], { silent: true, ignoreReturnCode: true })
    : sig;
  if (!pub.includes("BEGIN PUBLIC KEY") || sig.exitCode !== 0 || att.exitCode !== 0) {
    const why = !pub.includes("BEGIN PUBLIC KEY") ? "no public key from the build job" : (att.stderr || sig.stderr).split("\n").filter((l) => l.trim() && !/^WARNING|deprecated/.test(l)).slice(-3).join(" ");
    out("failed", false, why);
    if ((e.FAIL_ON_UNVERIFIED || "true") === "true") core.setFailed(`❌ ${subject}: ${why}`);
    else core.warning(`❌ ${subject}: ${why}`);
    return;
  }
  out("verified", true, "signature + SLSA provenance + approved-build CUE verified with the exported public key");
  core.info(`✅ ${subject} verified against ${keyRef}`);
}
