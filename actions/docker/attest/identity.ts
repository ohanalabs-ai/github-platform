// 🪪 The BUILD job's identity, captured where it is true: inside the build job of
// docker-multiarch-cicd.yaml. Its GitHub OIDC token carries `job_workflow_ref` = THIS reusable
// (the builder.id the admission CUE asserts) plus the caller's repository / ref / sha / workflow.
// A later job (docker-image-attest.yaml) runs as a DIFFERENT reusable, so it cannot read the
// builder's identity from its own token — it receives this output and binds it to its own token
// (same repository, same commit, same run) before writing it into the SLSA provenance.
//
// The output is base64(JSON) of the claims only — never the token. A missing `id-token: write`
// permission is a warning, not a build failure: the image still builds, it just cannot be attested.
//
// outputs: build-identity (base64 JSON of OidcClaims, or ""), builder-id
import { claimsFrom, decodeJwtClaims, builderId } from "./provenance.ts";
import type { OidcClaims } from "./provenance.ts";
import type { Ctx } from "./types.ts";

export function encodeIdentity(c: OidcClaims): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64");
}

export function decodeIdentity(b64: string): OidcClaims {
  if (!b64) throw new Error("build-identity is empty — the build job could not mint an OIDC token (id-token: write?)");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("build-identity is not base64 JSON");
  }
  return claimsFrom(raw);
}

/**
 * The attest job may only vouch for a build of the SAME run: its own OIDC token (`self`) must name
 * the same repository, commit and workflow run as the build's identity, and the build must be the
 * expected builder reusable. Otherwise a caller could feed any identity into the provenance.
 * Returns the problems (empty = bound).
 */
export function bindProblems(build: OidcClaims, self: OidcClaims, signerWorkflow: string): string[] {
  const p: string[] = [];
  if (build.repository !== self.repository) p.push(`repository ${build.repository} ≠ ${self.repository}`);
  if (build.sha !== self.sha) p.push(`commit ${build.sha.slice(0, 7)} ≠ ${self.sha.slice(0, 7)}`);
  if (build.run_id !== self.run_id) p.push(`run ${build.run_id} ≠ ${self.run_id} (attest must run in the build's workflow run)`);
  if (build.ref !== self.ref) p.push(`ref ${build.ref} ≠ ${self.ref}`);
  if (signerWorkflow && !build.job_workflow_ref.toLowerCase().startsWith(`${signerWorkflow.toLowerCase()}@`)) {
    p.push(`builder ${build.job_workflow_ref} is not ${signerWorkflow}@… (the admission CUE would reject it)`);
  }
  return p;
}

export default async function run({ core }: Ctx): Promise<void> {
  try {
    const claims = claimsFrom(decodeJwtClaims(await core.getIDToken()));
    core.setOutput("build-identity", encodeIdentity(claims));
    core.setOutput("builder-id", builderId(process.env.GITHUB_SERVER_URL || "https://github.com", claims.job_workflow_ref));
    core.info(`🪪 builder ${claims.job_workflow_ref} · ${claims.repository}@${claims.sha.slice(0, 7)} (${claims.ref}) run ${claims.run_id}`);
  } catch (err) {
    core.setOutput("build-identity", "");
    core.setOutput("builder-id", "");
    core.warning(`build identity unavailable (${(err as Error).message}) — this image cannot be attested by docker-image-attest.yaml`);
  }
}
