import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, digestOf, expectation, summaryMarkdown } from "./summary.ts";

const ok = (outputs: Record<string, string> = {}) => ({ result: "success", outputs });
const D = "sha256:" + "b".repeat(64);
const IMG = `ghcr.io/planeodev/gcp-microservices-demo/frontend@${D}`;
const signed = { scan: ok({ status: "pass", "critical-count": "0", "high-count": "2" }), attest: ok({ signed: "true", "key-ref": "hashivault://planeodev-ci-images" }) };
const REFS = "refs/heads/main,refs/heads/develop";

test("digestOf prefers an explicit digest, else the image's @sha256, else empty", () => {
  assert.equal(digestOf(IMG), D);
  assert.equal(digestOf("ghcr.io/x/y:main", D), D);
  assert.equal(digestOf("ghcr.io/x/y:main"), "");
});

test("the stamp is expected only on push/dispatch to a signing ref — never on pull requests", () => {
  assert.equal(expectation("push", "refs/heads/main", REFS).expect, true);
  assert.equal(expectation("workflow_dispatch", "refs/heads/develop", REFS).expect, true);
  assert.equal(expectation("pull_request", "refs/pull/7/merge", REFS).expect, false);
  assert.equal(expectation("pull_request_target", "refs/heads/main", REFS).expect, false);
  assert.match(expectation("push", "refs/heads/feature/x", REFS).reason, /not a signing ref/);
});

test("classify: stamped on main is ok; missing on main fails; skipped on a PR is ok", () => {
  const main = classify({ needs: signed, eventName: "push", ref: "refs/heads/main", signingRefs: REFS, publicProvenance: "present" });
  assert.equal(main.ok, true);
  assert.equal(main.stamp, "signed");
  const missing = classify({ needs: { ...signed, attest: { result: "failure", outputs: { signed: "false" } } }, eventName: "push", ref: "refs/heads/main", signingRefs: REFS, publicProvenance: "absent" });
  assert.equal(missing.ok, false);
  assert.match(missing.verdict, /EXPECTED/);
  const pr = classify({ needs: { scan: ok(), attest: { result: "skipped" } }, eventName: "pull_request", ref: "refs/pull/7/merge", signingRefs: REFS, publicProvenance: "present" });
  assert.equal(pr.ok, true);
  assert.equal(pr.stamp, "skipped");
});

test("the summary shows BOTH classified proofs and never a secret", () => {
  const c = classify({ needs: signed, eventName: "push", ref: "refs/heads/main", signingRefs: REFS, publicProvenance: "present" });
  const md = summaryMarkdown(c, signed, { image: IMG, digest: D, builderId: "b", threshold: "NONE", visibility: "public", repo: "planeodev/gcp-microservices-demo" });
  assert.match(md, /✅ STAMPED/);
  assert.match(md, /🌐 public provenance .* ✅ present/);
  assert.match(md, /🔏 Planeo deploy stamp .* ✅ signed/);
  const priv = classify({ needs: signed, eventName: "push", ref: "refs/heads/main", signingRefs: REFS, publicProvenance: "not-applicable" });
  assert.match(summaryMarkdown(priv, signed, { image: IMG, digest: D, builderId: "", threshold: "", visibility: "private", repo: "a/b" }), /n\/a — private repository/);
  assert.doesNotMatch(md, /hvs\.|VAULT_TOKEN/);
});

test("no image built (e.g. a closed PR) → no stamp expected, ok", () => {
  const c = classify({ needs: {}, eventName: "push", ref: "refs/heads/main", signingRefs: REFS, publicProvenance: "unknown", image: "" });
  assert.equal(c.ok, true);
  assert.match(c.expectReason, /nothing was built/);
});
