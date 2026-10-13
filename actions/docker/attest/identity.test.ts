// `node --test actions/docker/attest/*.test.ts` (Node 24+, native type stripping; node:test only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsFrom } from "./provenance.ts";
import { bindProblems, decodeIdentity, encodeIdentity } from "./identity.ts";

const BUILDER = "ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml";
const ATTEST = "ohanalabs-ai/github-platform/.github/workflows/docker-image-attest.yaml";
const base = {
  repository: "planeodev/planeo-auth-broker",
  ref: "refs/heads/main",
  sha: "0123456789abcdef0123456789abcdef01234567",
  workflow_ref: "planeodev/planeo-auth-broker/.github/workflows/ci.yaml@refs/heads/main",
  event_name: "push",
  run_id: "100",
  run_attempt: "1",
  repository_owner_id: "135816901",
};
const build = claimsFrom({ ...base, job_workflow_ref: `${BUILDER}@refs/heads/main` });
// the attest job's own token: same run, but ITS job_workflow_ref is the attest reusable
const self = claimsFrom({ ...base, job_workflow_ref: `${ATTEST}@refs/heads/main` });

test("encode/decode round trip carries the claims, never a token", () => {
  const b64 = encodeIdentity(build);
  assert.deepEqual(decodeIdentity(b64), build);
  assert.doesNotMatch(Buffer.from(b64, "base64").toString(), /eyJ/); // no JWT inside
});

test("decodeIdentity explains an empty or malformed identity", () => {
  assert.throws(() => decodeIdentity(""), /id-token: write/);
  assert.throws(() => decodeIdentity("not-base64-json!!"), /base64 JSON/);
  assert.throws(() => decodeIdentity(Buffer.from(JSON.stringify({ repository: "x" })).toString("base64")), /missing claim/);
});

test("a build of the same run by the expected builder is bound", () => {
  assert.deepEqual(bindProblems(build, self, BUILDER), []);
});

test("a different repository, commit, run or ref is refused", () => {
  const other = (o: object) => claimsFrom({ ...base, job_workflow_ref: `${BUILDER}@refs/heads/main`, ...o });
  assert.match(bindProblems(other({ repository: "planeodev/other" }), self, BUILDER).join(), /repository/);
  assert.match(bindProblems(other({ sha: "f".repeat(40) }), self, BUILDER).join(), /commit/);
  assert.match(bindProblems(other({ run_id: "99" }), self, BUILDER).join(), /run 99/);
  assert.match(bindProblems(other({ ref: "refs/heads/feature" }), self, BUILDER).join(), /ref/);
});

test("a build by another workflow is refused (the admission CUE would reject it)", () => {
  const rogue = claimsFrom({ ...base, job_workflow_ref: "planeodev/planeo-auth-broker/.github/workflows/rogue.yaml@refs/heads/main" });
  assert.match(bindProblems(rogue, self, BUILDER).join(), /not .*docker-multiarch-cicd/);
});
