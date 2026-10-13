// 📋 The Planeo deploy stamp's run summary — ALWAYS written (owner rule 2026-10-13: every workflow
// publishes what it did on every outcome path, never secrets). It CLASSIFIES the two kinds of proof an
// image can carry (owner decision 2026-10-13, products/vionix-cicd/DESIGN-supply-chain-evidence.md):
//
//   🌐 public provenance  — GitHub artifact attestation (public Sigstore / Rekor). Made by the BUILD
//                           (docker-multiarch-cicd `attestation-mode: auto`) for PUBLIC repositories only.
//                           Anyone can verify it; Planeo admission does NOT trust it.
//   🔏 Planeo deploy stamp — scan (docker-image-security) + attest with the org's Vault Transit key
//                           (docker-image-attest). What Planeo admission trusts. Push / dispatch on a
//                           signing ref only; pull requests never sign.
//
// env: NEEDS (toJSON(needs) of scan + attest), IMAGE, IMAGE_DIGEST (optional), BUILDER_ID, EVENT_NAME,
//      REF, SIGNING_REFS, VISIBILITY (public|private|internal), THRESHOLD, REPO (owner/name)
import { parseRefs, refMatches } from "../attest/policy.ts";
import type { Ctx } from "./types.ts";

type Needs = Record<string, { result?: string; outputs?: Record<string, string> }>;
export type PublicProvenance = "present" | "absent" | "not-applicable" | "unknown";

export interface Classification {
  expectStamp: boolean;      // this run SHOULD produce the deploy stamp (push/dispatch on a signing ref)
  expectReason: string;
  stamp: "signed" | "not-signed" | "skipped";
  publicProvenance: PublicProvenance;
  ok: boolean;               // false only when a stamp was expected and not produced
  verdict: string;
}

const icon = (r?: string) =>
  ({ success: "✅", failure: "❌", cancelled: "⏹️", skipped: "⏭️" } as Record<string, string>)[r || ""] || "❔";

export function digestOf(image: string, explicit = ""): string {
  if (/^sha256:[0-9a-f]{64}$/.test(explicit)) return explicit;
  const m = image.match(/@(sha256:[0-9a-f]{64})$/);
  return m ? m[1] : "";
}

export function expectation(eventName: string, ref: string, signingRefs: string, image = "x"): { expect: boolean; reason: string } {
  if (!image) return { expect: false, reason: "nothing was built in this run (no image)" };
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return { expect: false, reason: `${eventName}: pull requests never get the deploy stamp (untrusted code) — the push build of the merge does` };
  }
  const refs = parseRefs(signingRefs);
  if (!refMatches(ref, refs)) return { expect: false, reason: `${ref} is not a signing ref (${refs.join(", ") || "none"})` };
  return { expect: true, reason: `${eventName} on ${ref}` };
}

export function classify(i: {
  needs: Needs; eventName: string; ref: string; signingRefs: string; publicProvenance: PublicProvenance; image?: string;
}): Classification {
  const e = expectation(i.eventName, i.ref, i.signingRefs, i.image ?? "x");
  const a = i.needs.attest;
  const stamp: Classification["stamp"] = a?.outputs?.signed === "true" ? "signed" : a?.result === "skipped" || !a ? "skipped" : "not-signed";
  const ok = !e.expect || stamp === "signed";
  const verdict = ok
    ? stamp === "signed"
      ? "✅ Planeo deploy stamp produced — Planeo admission will accept this digest"
      : `⏭️ no deploy stamp expected — ${e.reason}`
    : `❌ deploy stamp EXPECTED (${e.reason}) but not produced — see the scan / attest jobs`;
  return { expectStamp: e.expect, expectReason: e.reason, stamp, publicProvenance: i.publicProvenance, ok, verdict };
}

export function summaryMarkdown(c: Classification, needs: Needs, f: {
  image: string; digest: string; builderId: string; threshold: string; visibility: string; repo: string;
}): string {
  const sc = needs.scan, a = needs.attest;
  const pp = {
    present: "✅ present — public Sigstore (verify: `gh attestation verify oci://<image> -R " + f.repo + "`)",
    absent: "➖ none for this digest",
    "not-applicable": `➖ n/a — ${f.visibility} repository (GitHub attestations exist only for public repos here)`,
    unknown: "❔ could not be checked (attestations API unavailable)",
  }[c.publicProvenance];
  const st = {
    signed: `✅ signed — \`${a?.outputs?.["key-ref"] || "hashivault://<org>-ci-images"}\` (no public log)`,
    "not-signed": `❌ not signed (attest ${a?.result || "—"})`,
    skipped: `⏭️ skipped — ${c.expectReason}`,
  }[c.stamp];
  const out: string[] = [
    `## 🔏 Planeo deploy stamp — ${c.ok ? (c.stamp === "signed" ? "✅ STAMPED" : "⏭️ NOT EXPECTED") : "❌ MISSING"}`, "",
    c.verdict, "",
    "| Proof | Status | Trusted by |", "|---|---|---|",
    `| 🌐 public provenance (GitHub / Sigstore Rekor) | ${pp} | anyone (public) — not Planeo admission |`,
    `| 🔏 Planeo deploy stamp (scan + Vault attest) | ${st} | Planeo admission (\`<org>-approved-build\`) |`, "",
    "| Stage | Result | Facts |", "|---|---|---|",
    `| 🛡️ scan (docker-image-security) | ${icon(sc?.result)} ${sc?.result || "—"} | status ${sc?.outputs?.status || "—"}, critical ${sc?.outputs?.["critical-count"] ?? "—"}, high ${sc?.outputs?.["high-count"] ?? "—"}, threshold ${f.threshold || "NONE"} |`,
    `| 🔏 attest (docker-image-attest) | ${icon(a?.result)} ${a?.result || "—"} | signed ${a?.outputs?.signed || "—"}, builder \`${a?.outputs?.["builder-id"] || f.builderId || "—"}\` |`, "",
    `Image: \`${f.image || "—"}\`${f.digest ? ` · digest \`${f.digest}\`` : ""}`,
  ];
  return out.join("\n");
}

export default async function run({ core, github }: Ctx): Promise<void> {
  const e = process.env;
  let needs: Needs = {};
  try { needs = JSON.parse(e.NEEDS || "{}"); } catch { /* render with what we have */ }
  const image = e.IMAGE || "";
  const digest = digestOf(image, e.IMAGE_DIGEST || "");
  const visibility = (e.VISIBILITY || "").toLowerCase();
  const [owner, repo] = (e.REPO || "/").split("/");
  let publicProvenance: PublicProvenance = visibility === "public" ? "unknown" : "not-applicable";
  if (visibility === "public" && digest && owner && repo) {
    try {
      const r = await github.request("GET /repos/{owner}/{repo}/attestations/{subject_digest}", { owner, repo, subject_digest: digest });
      publicProvenance = (r?.data?.attestations || []).length ? "present" : "absent";
    } catch (err) {
      publicProvenance = (err as { status?: number }).status === 404 ? "absent" : "unknown";
    }
  }
  const c = classify({ needs, eventName: e.EVENT_NAME || "", ref: e.REF || "", signingRefs: e.SIGNING_REFS || "", publicProvenance, image });
  await core.summary.addRaw(summaryMarkdown(c, needs, {
    image, digest, builderId: e.BUILDER_ID || "", threshold: e.THRESHOLD || "", visibility: visibility || "unknown", repo: e.REPO || "",
  }), true).write();
  core.info(c.verdict);
  if (!c.ok) core.setFailed(c.verdict);
}
