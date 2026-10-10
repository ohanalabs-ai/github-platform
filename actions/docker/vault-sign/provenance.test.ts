// Self-test for the SLSA provenance builder + the signing decisions —
// `node --test actions/docker/vault-sign/*.test.ts` (Node 24+, native type stripping; node:test only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILD_TYPE, buildProvenance, builderId, claimsFrom, decodeJwtClaims, isExpectedBuilder, workflowPath } from "./provenance.ts";
import { admissionCue, cosignMajor, decide, refMatches, parseRefs, signFlags, verifyFlags } from "./policy.ts";
import { consumerCommand, reportMarkdown } from "./verify.ts";

const REUSABLE = "ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml";
const raw = {
  repository: "ohanalabs-ai/kubernetes-mcp-server",
  ref: "refs/heads/main",
  sha: "0123456789abcdef0123456789abcdef01234567",
  // github.workflow_ref inside a reusable = the CALLER's workflow
  workflow_ref: "ohanalabs-ai/kubernetes-mcp-server/.github/workflows/docker-multiarch-cicd.yaml@refs/heads/main",
  // the OIDC job_workflow_ref claim = the reusable itself
  job_workflow_ref: `${REUSABLE}@refs/heads/main`,
  event_name: "push",
  run_id: "42",
  run_attempt: "2",
  repository_id: "1",
  repository_owner_id: "2",
  runner_environment: "github-hosted",
  aud: "https://github.com/ohanalabs-ai",
};
const jwt = (o: object) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(o)).toString("base64url")}.sig`;

test("decodeJwtClaims reads the payload; rejects non-JWTs", () => {
  assert.equal(decodeJwtClaims(jwt(raw)).job_workflow_ref, raw.job_workflow_ref);
  assert.throws(() => decodeJwtClaims("nope"), /not a JWT/);
});

test("claimsFrom names every missing claim", () => {
  assert.throws(() => claimsFrom({ repository: "o/r" }), /ref, sha, workflow_ref, job_workflow_ref, event_name, run_id, run_attempt/);
  assert.equal(claimsFrom(raw).runner_environment, "github-hosted");
});

test("builder.id is the REUSABLE workflow (job_workflow_ref), never the caller (the E-S5 bug)", () => {
  const p = buildProvenance(claimsFrom(raw), { serverUrl: "https://github.com/" }) as any;
  assert.equal(p.runDetails.builder.id, `https://github.com/${REUSABLE}@refs/heads/main`);
  assert.ok(!p.runDetails.builder.id.includes("kubernetes-mcp-server"), "caller must not be the builder");
});

test("externalParameters.workflow is the object the admission CUE asserts", () => {
  const p = buildProvenance(claimsFrom(raw), { serverUrl: "https://github.com", startedOn: "2026-10-09T00:00:00Z" }) as any;
  assert.equal(p.buildDefinition.buildType, BUILD_TYPE);
  assert.deepEqual(p.buildDefinition.externalParameters.workflow, {
    ref: "refs/heads/main",
    repository: "https://github.com/ohanalabs-ai/kubernetes-mcp-server",
    path: ".github/workflows/docker-multiarch-cicd.yaml",
  });
  assert.deepEqual(p.buildDefinition.resolvedDependencies, [
    { uri: "git+https://github.com/ohanalabs-ai/kubernetes-mcp-server@refs/heads/main", digest: { gitCommit: raw.sha } },
  ]);
  assert.equal(p.runDetails.metadata.invocationId, "https://github.com/ohanalabs-ai/kubernetes-mcp-server/actions/runs/42/attempts/2");
  assert.equal(p.buildDefinition.internalParameters.github.runner_environment, "github-hosted");
  // the CUE's regexes, applied to what we emit
  const w = p.buildDefinition.externalParameters.workflow;
  assert.match(w.repository, /^https:\/\/github.com\/ohanalabs-ai\/[A-Za-z0-9._-]+$/);
  assert.match(w.ref, /^refs\/heads\/(main|develop)$/);
  assert.match(w.path, /^\.github\/workflows\/.+\.ya?ml$/);
  assert.match(p.runDetails.builder.id, /^https:\/\/github.com\/ohanalabs-ai\/github-platform\/\.github\/workflows\/docker-multiarch-cicd\.yaml@/);
});

test("workflowPath / builderId validate their input", () => {
  assert.equal(workflowPath("O/R/.github/workflows/a.yml@refs/heads/x", "o/r"), ".github/workflows/a.yml");
  assert.throws(() => workflowPath("other/repo/.github/workflows/a.yml@refs/heads/x", "o/r"), /not a workflow of o\/r/);
  assert.throws(() => builderId("https://github.com", "o/r@refs/heads/main"), /is not <owner>\/<repo>/);
  assert.ok(isExpectedBuilder(`${REUSABLE}@refs/heads/feature/x`, REUSABLE));
  assert.ok(!isExpectedBuilder("o/r/.github/workflows/docker-multiarch-cicd.yaml@refs/heads/main", REUSABLE));
});

test("decide: never on pull_request; only listed refs; missing inputs fail", () => {
  const base = { ref: "refs/heads/main", signingRefs: "refs/heads/main,refs/heads/develop", vaultUrl: "https://v", vaultRole: "r", transitKey: "k" };
  assert.equal(decide({ ...base, eventName: "push" }).sign, true);
  assert.equal(decide({ ...base, eventName: "workflow_dispatch", ref: "refs/heads/develop" }).sign, true);
  assert.equal(decide({ ...base, eventName: "pull_request" }).sign, false);
  assert.equal(decide({ ...base, eventName: "pull_request_target" }).sign, false);
  assert.equal(decide({ ...base, eventName: "push", ref: "refs/heads/feature/x" }).sign, false);
  assert.equal(decide({ ...base, eventName: "push", ref: "refs/tags/v1.2.3" }).sign, false);
  assert.equal(decide({ ...base, eventName: "push", ref: "refs/tags/v1.2.3", signingRefs: "refs/heads/main\nrefs/tags/v*" }).sign, true);
  assert.throws(() => decide({ ...base, eventName: "push", vaultRole: " ", transitKey: "" }), /vault-role, transit-key/);
});

test("refMatches / parseRefs", () => {
  assert.deepEqual(parseRefs(" a, b\n\nc "), ["a", "b", "c"]);
  assert.ok(refMatches("refs/tags/v1", ["refs/tags/v*"]));
  assert.ok(!refMatches("refs/heads/mainline", ["refs/heads/main"]));
});

test("cosign flags: v3 must opt out of the signing config (public Rekor) and the new bundle format", () => {
  assert.equal(cosignMajor('{"gitVersion":"v3.1.3"}'), 3);
  assert.equal(cosignMajor('{"gitVersion":"v2.5.0"}'), 2);
  assert.equal(cosignMajor("garbage"), 0);
  assert.deepEqual(signFlags(3), ["--yes", "--use-signing-config=false", "--tlog-upload=false", "--new-bundle-format=false"]);
  assert.deepEqual(signFlags(2), ["--yes", "--tlog-upload=false"]);
  assert.ok(verifyFlags(3).includes("--insecure-ignore-tlog=true"));
  for (const f of [...signFlags(3), ...signFlags(2)]) assert.ok(!/tlog-upload=true|rekor-url/.test(f));
});

test("admissionCue mirrors the ClusterImagePolicy approved-build CUE", () => {
  const cue = admissionCue({ org: "planeodev", signerWorkflow: REUSABLE });
  assert.match(cue, /^predicateType: "https:\/\/slsa.dev\/provenance\/v1"$/m);
  assert.ok(cue.includes('repository: =~"^https://github\\\\.com/planeodev/[A-Za-z0-9._-]+$"'));
  assert.ok(cue.includes('ref:        =~"^refs/heads/(main|develop)$"'));
  assert.ok(cue.includes('path:       =~"^\\\\.github/workflows/.+\\\\.ya?ml$"'));
  assert.ok(cue.includes('id: =~"^https://github\\\\.com/ohanalabs-ai/github-platform/\\\\.github/workflows/docker-multiarch-cicd\\\\.yaml@"'));
});

test("verify report: not-attested is informational, verified shows the consumer command", () => {
  const md = reportMarkdown({ title: "T", status: "not-attested", subject: "i@sha256:a", keyRef: "hashivault://k", reason: "pull_request", level: "2" });
  assert.match(md, /❕ not attested/);
  assert.ok(!md.includes("cosign verify"));
  const ok = reportMarkdown({ title: "T", status: "verified", subject: "i@sha256:a", keyRef: "hashivault://k", reason: "", level: "2" });
  assert.match(ok, /✅ verified \(vault\)/);
  assert.ok(ok.includes(consumerCommand("i@sha256:a", "hashivault://k")));
});
