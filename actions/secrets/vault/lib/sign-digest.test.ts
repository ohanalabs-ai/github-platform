import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { canonical, statement, parseVaultSignature, verifyStatement, transitUrl, validateSubject, summaryMarkdown, STATEMENT_TYPE } from "./sign-digest.ts";

const signer = { repository: "planeodev/planeo-infra", ref: "refs/heads/develop", sha: "a".repeat(40), run_id: "1", workflow: "w" };
const D = "sha256:" + "ab".repeat(32);

test("canonical JSON sorts keys recursively and is stable", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: "s" } }), '{"a":{"c":"s","d":[2,{"x":2,"y":1}]},"b":1}');
});

test("statement carries the subject, signer and key, typed", () => {
  const s = JSON.parse(statement(D, "ghcr.io/planeodev/x", signer, "planeodev-ci-images", "2026-10-13T00:00:00Z"));
  assert.equal(s._type, STATEMENT_TYPE);
  assert.deepEqual(s.subject, { name: "ghcr.io/planeodev/x", digest: D });
  assert.equal(s.key, "planeodev-ci-images");
  assert.equal(s.signer.ref, "refs/heads/develop");
});

test("subject validation rejects bad digests and names", () => {
  assert.throws(() => validateSubject("sha256:XYZ", "n"), /subject-digest/);
  assert.throws(() => validateSubject("md5:" + "a".repeat(32), "n"), /subject-digest/);
  assert.throws(() => validateSubject(D, "bad name; rm -rf"), /subject-name/);
  assert.doesNotThrow(() => validateSubject(D, "release/v1.2.3.tar.gz"));
});

test("a Vault-format ECDSA P-256 signature verifies with the public key; tampering fails", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const stmt = statement(D, "x", signer, "k", "2026-10-13T00:00:00Z");
  const der = cryptoSign("sha256", Buffer.from(stmt), privateKey); // ASN.1 DER, like Transit's default marshaling
  const sig = `vault:v2:${der.toString("base64")}`;
  assert.equal(parseVaultSignature(sig).version, 2);
  assert.equal(verifyStatement(stmt, sig, pem), true);
  assert.equal(verifyStatement(stmt.replace('"x"', '"y"'), sig, pem), false);
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyStatement(stmt, sig, other), false);
});

test("signature parsing rejects foreign formats", () => {
  assert.throws(() => parseVaultSignature("MEUCIQ..."), /vault:v<N>/);
});

test("transit URLs: sign gets the hash path, keys does not; bad input rejected", () => {
  assert.equal(transitUrl("https://v.x/", "transit", "sign", "planeodev-ci-images"), "https://v.x/v1/transit/sign/planeodev-ci-images/sha2-256");
  assert.equal(transitUrl("https://v.x", "/transit/", "keys", "k"), "https://v.x/v1/transit/keys/k");
  assert.throws(() => transitUrl("", "transit", "sign", "k"), /VAULT_ADDR/);
  assert.throws(() => transitUrl("https://v.x", "transit", "sign", "../x"), /transit key/);
});

test("summary covers success, verify failure and errors — never a token", () => {
  assert.match(summaryMarkdown({ name: "x", digest: D, key: "k", version: 1, verified: true, signer }), /signed \+ verified/);
  assert.match(summaryMarkdown({ name: "x", digest: D, key: "k", version: 1, verified: false, signer }), /did not verify/);
  const e = summaryMarkdown({ name: "x", digest: D, key: "k", signer, error: "Transit sign failed: HTTP 403" });
  assert.match(e, /❌ failed/);
  assert.doesNotMatch(e, /hvs\.|X-Vault-Token/);
});
