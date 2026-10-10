// SLSA v1 build provenance for an image built by this org's reusable docker workflow — the
// predicate `cosign attest --type slsaprovenance1` signs with the org's Vault Transit key.
//
// Every field comes from the job's GitHub OIDC token (the SAME claims Vault's github-jwt role
// validated before it let the job sign), never from free-form inputs:
//
//   externalParameters.workflow = the TOP-LEVEL (caller) workflow: {repository, ref, path}
//       ← claims `repository`, `ref`, `workflow_ref` (= github.workflow_ref, the caller's file)
//   runDetails.builder.id       = THIS reusable workflow at the ref the caller pinned
//       ← claim `job_workflow_ref` (= ohanalabs-ai/github-platform/.github/workflows/
//         docker-multiarch-cicd.yaml@refs/heads/main)
//
// The bug this replaces (planeo-infra docs/trust/slsa-self-assessment.md, E-S5): the jq-built
// keyless predicate set builder.id from GITHUB_WORKFLOW_REF. Inside a reusable workflow that is
// the CALLER's workflow (github.workflow_ref is the top-level run's), so the predicate named the
// caller as the builder and put `workflow` as a string — both rejected by the admission CUE
// (planeo-infra clusters/base/hooks/policy/clusterimagepolicy-<org>.yaml), which expects
// builder.id = the reusable and workflow = {repository, ref, path}. The OIDC `job_workflow_ref`
// claim is the reusable's own identity (it is what Fulcio puts in a keyless certificate's SAN).
//
// The shape is GitHub's own buildType (https://actions.github.io/buildtypes/workflow/v1), the one
// actions/attest-build-provenance emits, so `gh attestation`-style tooling and our CUE agree.

export const BUILD_TYPE = "https://actions.github.io/buildtypes/workflow/v1";
export const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

export interface OidcClaims {
  repository: string; // owner/repo (the caller)
  ref: string; // refs/heads/main
  sha: string; // commit the run is for
  workflow_ref: string; // owner/repo/.github/workflows/<caller>.yaml@refs/heads/main
  job_workflow_ref: string; // ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@refs/heads/main
  event_name: string;
  run_id: string;
  run_attempt: string;
  repository_id?: string;
  repository_owner_id?: string;
  runner_environment?: string; // github-hosted | self-hosted
}

const REQUIRED: Array<keyof OidcClaims> = ["repository", "ref", "sha", "workflow_ref", "job_workflow_ref", "event_name", "run_id", "run_attempt"];

/** Decode (NOT verify) a JWT's claims — the token comes straight from the runner's OIDC endpoint. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT (expected header.payload.signature)");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Pick + validate the claims the provenance needs. Throws naming every missing claim. */
export function claimsFrom(raw: Record<string, unknown>): OidcClaims {
  const missing = REQUIRED.filter((k) => typeof raw[k] !== "string" || raw[k] === "");
  if (missing.length) throw new Error(`OIDC token is missing claim(s): ${missing.join(", ")}`);
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  return {
    repository: s("repository")!, ref: s("ref")!, sha: s("sha")!, workflow_ref: s("workflow_ref")!,
    job_workflow_ref: s("job_workflow_ref")!, event_name: s("event_name")!, run_id: s("run_id")!,
    run_attempt: s("run_attempt")!, repository_id: s("repository_id"), repository_owner_id: s("repository_owner_id"),
    runner_environment: s("runner_environment"),
  };
}

/** `owner/repo/.github/workflows/x.yaml@refs/heads/main` → `.github/workflows/x.yaml` (must belong to `repository`). */
export function workflowPath(workflowRef: string, repository: string): string {
  const at = workflowRef.indexOf("@");
  const full = at >= 0 ? workflowRef.slice(0, at) : workflowRef;
  const prefix = `${repository}/`;
  if (!full.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error(`workflow_ref '${workflowRef}' is not a workflow of ${repository}`);
  }
  return full.slice(prefix.length);
}

/** The builder identity: `https://github.com/<job_workflow_ref>` — the reusable workflow, never the caller. */
export function builderId(serverUrl: string, jobWorkflowRef: string): string {
  if (!/^[^/]+\/[^/]+\/\.github\/workflows\/[^@]+\.ya?ml@.+$/.test(jobWorkflowRef)) {
    throw new Error(`job_workflow_ref '${jobWorkflowRef}' is not <owner>/<repo>/.github/workflows/<file>@<ref>`);
  }
  return `${serverUrl.replace(/\/+$/, "")}/${jobWorkflowRef}`;
}

/** True when the builder is the expected reusable (`<owner>/<repo>/.github/workflows/<file>`, any ref). */
export function isExpectedBuilder(jobWorkflowRef: string, signerWorkflow: string): boolean {
  return jobWorkflowRef.toLowerCase().startsWith(`${signerWorkflow.toLowerCase()}@`);
}

export interface ProvenanceOptions { serverUrl: string; startedOn?: string; finishedOn?: string }

/** The SLSA v1 predicate (the `predicate` of the in-toto statement cosign wraps around the digest). */
export function buildProvenance(c: OidcClaims, o: ProvenanceOptions): Record<string, unknown> {
  const server = o.serverUrl.replace(/\/+$/, "");
  const repoUrl = `${server}/${c.repository}`;
  const github: Record<string, string> = { event_name: c.event_name };
  if (c.repository_id) github.repository_id = c.repository_id;
  if (c.repository_owner_id) github.repository_owner_id = c.repository_owner_id;
  if (c.runner_environment) github.runner_environment = c.runner_environment;
  const metadata: Record<string, string> = { invocationId: `${repoUrl}/actions/runs/${c.run_id}/attempts/${c.run_attempt}` };
  if (o.startedOn) metadata.startedOn = o.startedOn;
  if (o.finishedOn) metadata.finishedOn = o.finishedOn;
  return {
    buildDefinition: {
      buildType: BUILD_TYPE,
      externalParameters: {
        workflow: { ref: c.ref, repository: repoUrl, path: workflowPath(c.workflow_ref, c.repository) },
      },
      internalParameters: { github },
      resolvedDependencies: [{ uri: `git+${repoUrl}@${c.ref}`, digest: { gitCommit: c.sha } }],
    },
    runDetails: {
      builder: { id: builderId(server, c.job_workflow_ref) },
      metadata,
    },
  };
}
