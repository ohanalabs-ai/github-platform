// 🔏 Sign + attest an image digest with the org's Vault Transit key (cosign `hashivault://<key>`),
// no transparency log, then prove the round trip with the exported PUBLIC key — the same check the
// clusters' policy-controller makes (signature + SLSA provenance + the approved-build CUE).
//
// env: SUBJECT (<image>@sha256:…), TRANSIT_KEY, TRANSIT_PATH (default transit), VAULT_ADDR,
//      VAULT_TOKEN (from hashicorp/vault-action outputToken — never exported to the job env),
//      VAULT_CACERT (optional PEM path), SBOM_FILE (optional SPDX JSON), SIGNER_WORKFLOW,
//      OIDC_AUDIENCE, ORG (the caller's GitHub org — whose admission CUE to evaluate)
// outputs: signed, key-ref, public-key-b64, builder-id, provenance-file
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { buildProvenance, claimsFrom, decodeJwtClaims, isExpectedBuilder } from "./provenance.ts";
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
  const subject = e.SUBJECT || "";
  const key = e.TRANSIT_KEY || "";
  const token = e.VAULT_TOKEN || "";
  if (token) core.setSecret(token);
  try {
    if (e.GITHUB_EVENT_NAME === "pull_request" || e.GITHUB_EVENT_NAME === "pull_request_target") {
      throw new Error("refusing to sign on a pull_request event"); // defence in depth: plan.ts already skips
    }
    if (!/@sha256:[0-9a-f]{64}$/.test(subject)) throw new Error(`SUBJECT must be <image>@sha256:<digest>, got '${subject}'`);
    if (!key || !token || !e.VAULT_ADDR) throw new Error("TRANSIT_KEY, VAULT_ADDR and VAULT_TOKEN are required");

    // The predicate's identity fields = the OIDC claims Vault just validated (not GITHUB_* env).
    const claims = claimsFrom(decodeJwtClaims(await core.getIDToken(e.OIDC_AUDIENCE || undefined)));
    if (claims.repository !== e.GITHUB_REPOSITORY || claims.ref !== e.GITHUB_REF) {
      throw new Error(`OIDC claims (${claims.repository} ${claims.ref}) disagree with the run (${e.GITHUB_REPOSITORY} ${e.GITHUB_REF})`);
    }
    const signer = e.SIGNER_WORKFLOW || "";
    if (signer && !isExpectedBuilder(claims.job_workflow_ref, signer)) {
      core.warning(`builder ${claims.job_workflow_ref} is not ${signer}@… — the admission CUE will reject this provenance`);
    }
    const predicate = buildProvenance(claims, { serverUrl: e.GITHUB_SERVER_URL || "https://github.com", startedOn: new Date().toISOString() });
    const tmp = e.RUNNER_TEMP || "/tmp";
    const predicateFile = join(tmp, "slsa-provenance.json");
    writeFileSync(predicateFile, JSON.stringify(predicate, null, 2));

    const major = cosignMajor((await exec.getExecOutput("cosign", ["version", "--json"], { silent: true, ignoreReturnCode: true })).stdout);
    const keyRef = `hashivault://${key}`;
    const env: Record<string, string> = { ...(e as Record<string, string>), TRANSIT_SECRET_ENGINE_PATH: e.TRANSIT_PATH || "transit" };
    if (e.VAULT_CACERT) env.VAULT_CACERT = e.VAULT_CACERT;
    const sf = signFlags(major);

    core.info(`🔏 cosign v${major || "?"}: sign + attest ${subject} with ${keyRef} (no tlog)`);
    await exec.exec("cosign", ["sign", ...sf, "--recursive", "--key", keyRef, subject], { env });
    await exec.exec("cosign", ["attest", ...sf, "--key", keyRef, "--type", "slsaprovenance1", "--predicate", predicateFile, subject], { env });
    const sbom = e.SBOM_FILE || "";
    if (sbom && existsSync(sbom)) {
      await exec.exec("cosign", ["attest", ...sf, "--key", keyRef, "--type", "spdxjson", "--predicate", sbom, subject], { env });
    } else core.notice("no SBOM file — SBOM attestation skipped");

    // Round trip with the PUBLIC half only, exactly like admission: signature, then provenance + CUE.
    const pub = (await exec.getExecOutput("cosign", ["public-key", "--key", keyRef], { env, silent: true })).stdout.trim();
    if (!pub.includes("BEGIN PUBLIC KEY")) throw new Error(`cosign public-key returned no PEM for ${keyRef}`);
    const pubFile = join(tmp, "cosign.pub");
    writeFileSync(pubFile, pub + "\n");
    const cueFile = join(tmp, "approved-build.cue");
    writeFileSync(cueFile, admissionCue({ org: e.ORG || claims.repository.split("/")[0], signerWorkflow: signer || claims.job_workflow_ref.split("@")[0] }));
    const vf = verifyFlags(major);
    await exec.exec("cosign", ["verify", "--key", pubFile, ...vf, subject], { silent: true });
    await exec.exec("cosign", ["verify-attestation", "--key", pubFile, ...vf, "--type", "slsaprovenance1", "--policy", cueFile, subject], { silent: true });

    const builder = (predicate.runDetails as { builder: { id: string } }).builder.id;
    core.setOutput("signed", "true");
    core.setOutput("key-ref", keyRef);
    core.setOutput("public-key-b64", Buffer.from(pub + "\n").toString("base64"));
    core.setOutput("builder-id", builder);
    core.setOutput("provenance-file", predicateFile);
    await core.summary.addRaw([
      "### 🔏 Vault Transit signature + SLSA provenance",
      "",
      "| | |", "|---|---|",
      `| Subject | \`${subject}\` |`,
      `| Key | \`${keyRef}\` (Vault Transit — private half never leaves Vault) |`,
      `| Attestations | \`slsaprovenance1\`${sbom && existsSync(sbom) ? ", `spdxjson`" : ""} — no transparency log (Rekor) |`,
      `| Builder | \`${builder}\` |`,
      `| Round trip | ✅ \`cosign verify\` + \`verify-attestation --policy approved-build.cue\` with the exported public key |`,
      "", "<details><summary>public key</summary>", "", "```", pub, "```", "</details>", "",
    ].join("\n")).write();
  } catch (err) {
    core.setOutput("signed", "false");
    core.setFailed(`vault signing failed: ${(err as Error).message}`);
  } finally {
    if (token && e.VAULT_ADDR) {
      const code = await revokeSelf(e.VAULT_ADDR, token, e.VAULT_CACERT || "");
      if (code !== 204) core.warning(`could not revoke the Vault token (HTTP ${code}); it expires with the role TTL`);
    }
  }
}
