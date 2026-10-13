// 🔏 Attest an image digest with the org's Vault Transit key (cosign `hashivault://<key>`), no
// transparency log, then prove the round trip with the exported PUBLIC key — the same check the
// clusters' policy-controller makes. Run by .github/workflows/docker-image-attest.yaml.
//
// MODE=provenance  `cosign sign --recursive` + `cosign attest --type slsaprovenance1` (+ `spdxjson`).
//                  The predicate is built from the BUILD job's identity (BUILD_IDENTITY, the
//                  `build_identity` output of docker-multiarch-cicd.yaml: its OIDC claims, whose
//                  `job_workflow_ref` is the builder reusable). This job's own token must name the
//                  same repository, commit, ref and run (bindProblems) — the attest workflow is a
//                  different reusable, so its own job_workflow_ref is never the builder.id.
//                  Round trip: verify + verify-attestation --policy <the org's approved-build CUE>.
// MODE=vuln        `cosign attest --type vuln --predicate $VULN_PREDICATE` (a scan result — the
//                  security gate's stamp on an image we may not have built, INTEGRATE-31). Round
//                  trip: verify-attestation --type vuln with the public key.
//
// env: MODE, SUBJECT (<image>@sha256:…), BUILD_IDENTITY (provenance), VULN_PREDICATE (vuln),
//      TRANSIT_KEY, TRANSIT_PATH, VAULT_ADDR, VAULT_TOKEN (vault-action outputToken — never exported),
//      VAULT_CACERT (optional PEM path), SBOM_FILE (optional SPDX JSON), SIGNER_WORKFLOW,
//      OIDC_AUDIENCE, ORG, COSIGN_REPOSITORY (optional: store signatures/attestations elsewhere)
// outputs: signed, key-ref, public-key-b64, builder-id, provenance-file
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { buildProvenance, claimsFrom, decodeJwtClaims } from "./provenance.ts";
import { bindProblems, decodeIdentity } from "./identity.ts";
import { admissionCue, cosignMajor, signFlags, verifyFlags } from "./policy.ts";
import type { Ctx } from "./types.ts";

function revokeSelf(addr: string, token: string, caFile: string): Promise<number> {
  return new Promise((resolve) => {
    const url = new URL("/v1/auth/token/revoke-self", addr);
    const opts = { method: "POST", headers: { "X-Vault-Token": token }, ...(caFile ? { ca: readFileSync(caFile) } : {}) };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, opts, (res) => { res.resume(); resolve(res.statusCode || 0); });
    req.on("error", () => resolve(0));
    req.end();
  });
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const e = process.env;
  const mode = (e.MODE || "provenance").toLowerCase();
  const subject = e.SUBJECT || "";
  const key = e.TRANSIT_KEY || "";
  const token = e.VAULT_TOKEN || "";
  if (token) core.setSecret(token);
  try {
    if (e.GITHUB_EVENT_NAME === "pull_request" || e.GITHUB_EVENT_NAME === "pull_request_target") {
      throw new Error("refusing to sign on a pull_request event"); // defence in depth: plan.ts already skips
    }
    if (mode !== "provenance" && mode !== "vuln") throw new Error(`MODE must be provenance | vuln, got '${mode}'`);
    if (!/@sha256:[0-9a-f]{64}$/.test(subject)) throw new Error(`SUBJECT must be <image>@sha256:<digest>, got '${subject}'`);
    if (!key || !token || !e.VAULT_ADDR) throw new Error("TRANSIT_KEY, VAULT_ADDR and VAULT_TOKEN are required");

    const self = claimsFrom(decodeJwtClaims(await core.getIDToken(e.OIDC_AUDIENCE || undefined)));
    if (self.repository !== e.GITHUB_REPOSITORY || self.ref !== e.GITHUB_REF) {
      throw new Error(`OIDC claims (${self.repository} ${self.ref}) disagree with the run (${e.GITHUB_REPOSITORY} ${e.GITHUB_REF})`);
    }
    const signer = e.SIGNER_WORKFLOW || "";
    const tmp = e.RUNNER_TEMP || "/tmp";
    let predicateFile = "";
    let builder = "";
    if (mode === "provenance") {
      const build = decodeIdentity(e.BUILD_IDENTITY || "");
      const problems = bindProblems(build, self, signer);
      if (problems.length) throw new Error(`build identity not bound to this run: ${problems.join("; ")}`);
      const predicate = buildProvenance(build, { serverUrl: e.GITHUB_SERVER_URL || "https://github.com", finishedOn: new Date().toISOString() });
      predicateFile = join(tmp, "slsa-provenance.json");
      writeFileSync(predicateFile, JSON.stringify(predicate, null, 2));
      builder = (predicate.runDetails as { builder: { id: string } }).builder.id;
    } else {
      predicateFile = e.VULN_PREDICATE || "";
      if (!predicateFile || !existsSync(predicateFile)) throw new Error(`mode vuln needs VULN_PREDICATE (a scan result file), got '${predicateFile}'`);
    }

    const major = cosignMajor((await exec.getExecOutput("cosign", ["version", "--json"], { silent: true, ignoreReturnCode: true })).stdout);
    const keyRef = `hashivault://${key}`;
    const env: Record<string, string> = { ...(e as Record<string, string>), TRANSIT_SECRET_ENGINE_PATH: e.TRANSIT_PATH || "transit" };
    if (e.VAULT_CACERT) env.VAULT_CACERT = e.VAULT_CACERT;
    const sf = signFlags(major);
    const sbom = e.SBOM_FILE || "";

    core.info(`🔏 cosign v${major || "?"}: ${mode} attestation for ${subject} with ${keyRef} (no tlog)`);
    if (mode === "provenance") {
      await exec.exec("cosign", ["sign", ...sf, "--recursive", "--key", keyRef, subject], { env });
      await exec.exec("cosign", ["attest", ...sf, "--key", keyRef, "--type", "slsaprovenance1", "--predicate", predicateFile, subject], { env });
      if (sbom && existsSync(sbom)) {
        await exec.exec("cosign", ["attest", ...sf, "--key", keyRef, "--type", "spdxjson", "--predicate", sbom, subject], { env });
      } else core.notice("no SBOM file — SBOM attestation skipped");
    } else {
      await exec.exec("cosign", ["attest", ...sf, "--key", keyRef, "--type", "vuln", "--predicate", predicateFile, subject], { env });
    }

    // Round trip with the PUBLIC half only, exactly like admission.
    const pub = (await exec.getExecOutput("cosign", ["public-key", "--key", keyRef], { env, silent: true })).stdout.trim();
    if (!pub.includes("BEGIN PUBLIC KEY")) throw new Error(`cosign public-key returned no PEM for ${keyRef}`);
    const pubFile = join(tmp, "cosign.pub");
    writeFileSync(pubFile, pub + "\n");
    const vf = verifyFlags(major);
    if (mode === "provenance") {
      const cueFile = join(tmp, "approved-build.cue");
      writeFileSync(cueFile, admissionCue({ org: e.ORG || self.repository.split("/")[0], signerWorkflow: signer || builder.replace(/^https?:\/\/[^/]+\//, "").split("@")[0] }));
      await exec.exec("cosign", ["verify", "--key", pubFile, ...vf, subject], { silent: true });
      await exec.exec("cosign", ["verify-attestation", "--key", pubFile, ...vf, "--type", "slsaprovenance1", "--policy", cueFile, subject], { silent: true });
    } else {
      await exec.exec("cosign", ["verify-attestation", "--key", pubFile, ...vf, "--type", "vuln", subject], { silent: true });
    }

    core.setOutput("signed", "true");
    core.setOutput("key-ref", keyRef);
    core.setOutput("public-key-b64", Buffer.from(pub + "\n").toString("base64"));
    core.setOutput("builder-id", builder);
    core.setOutput("provenance-file", mode === "provenance" ? predicateFile : "");
    await core.summary.addRaw([
      `### 🔏 Vault Transit ${mode === "provenance" ? "signature + SLSA provenance" : "vulnerability attestation"}`,
      "",
      "| | |", "|---|---|",
      `| Subject | \`${subject}\` |`,
      `| Key | \`${keyRef}\` (Vault Transit — private half never leaves Vault) |`,
      `| Attestations | ${mode === "provenance" ? `\`slsaprovenance1\`${sbom && existsSync(sbom) ? ", `spdxjson`" : ""}` : "`vuln`"} — no transparency log (Rekor) |`,
      ...(builder ? [`| Builder | \`${builder}\` (the build job's identity, bound to this run) |`] : []),
      `| Round trip | ✅ verified with the exported public key${mode === "provenance" ? " + the approved-build CUE" : ""} |`,
      "", "<details><summary>public key</summary>", "", "```", pub, "```", "</details>", "",
    ].join("\n")).write();
  } catch (err) {
    core.setOutput("signed", "false");
    core.setFailed(`attestation failed: ${(err as Error).message}`);
  } finally {
    if (token && e.VAULT_ADDR) {
      const code = await revokeSelf(e.VAULT_ADDR, token, e.VAULT_CACERT || "");
      if (code !== 204) core.warning(`could not revoke the Vault token (HTTP ${code}); it expires with the role TTL`);
    }
  }
}
