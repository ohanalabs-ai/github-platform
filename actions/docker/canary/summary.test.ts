import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, summaryMarkdown } from "./summary.ts";

const ok = (outputs: Record<string, string> = {}) => ({ result: "success", outputs });
const green = {
  build: ok({ image_ref: "ghcr.io/planeodev/planeo-infra/vionix-signing-canary@sha256:" + "a".repeat(64), builder_id: "https://github.com/ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@refs/heads/main" }),
  scan: ok({ status: "pass", "critical-count": "0", "high-count": "1" }),
  attest: ok({ signed: "true", "key-ref": "hashivault://planeodev-ci-images" }),
  verify: ok(),
};

test("image mode passes only when build, scan, attest (signed) and verify all succeed", () => {
  assert.deepEqual(verdict("image", green), { ok: true, reason: "the signing chain is proven end to end" });
  assert.equal(verdict("image", { ...green, verify: { result: "skipped" } }).ok, false);
  assert.match(verdict("image", { ...green, attest: ok({ signed: "false" }) }).reason, /attest \(not signed\)/);
  assert.match(verdict("image", {}).reason, /build, scan, attest, verify/);
});

test("digest mode depends only on the sign-digest job", () => {
  assert.equal(verdict("digest", { "sign-digest": ok({ verified: "true" }) }).ok, true);
  assert.equal(verdict("digest", { "sign-digest": { result: "failure" } }).ok, false);
});

test("the summary always renders, with facts and a FAIL banner on failure", () => {
  const md = summaryMarkdown("image", green, "planeodev", "refs/heads/develop", "https://x/run");
  assert.match(md, /✅ PASS/);
  assert.match(md, /hashivault:\/\/planeodev-ci-images/);
  assert.match(md, /docker-multiarch-cicd\.yaml@refs\/heads\/main/);
  const f = summaryMarkdown("image", { build: { result: "failure" } }, "planeodev", "refs/heads/develop", "https://x/run");
  assert.match(f, /❌ FAIL/);
  assert.match(f, /🧱 build .*❌ failure/);
  const d = summaryMarkdown("digest", { "sign-digest": ok({ "key-version": "1", verified: "true" }) }, "ohanalabs-ai", "refs/heads/main", "u");
  assert.match(d, /key v1, verified with the public key: true/);
});
