import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA, canonical, generateKey, decodeKey, seal, open, parse, enrich, flatten, fromEnv, hostFromServerUrl,
} from "./context.ts";

const KEY = generateKey();
const PLAIN = { org: "planeodev", githubHost: "github.com", registry: { host: "ghcr.io" } };
const SECRETS = { setup: { DOCKERHUB_TOKEN: "s3cret", NPM_TOKEN: "n" } };

test("canonical JSON is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: "z" } }), canonical({ a: { c: "z", d: [2, { x: 2, y: 1 }] }, b: 1 }));
});

test("key must be 32 bytes base64", () => {
  assert.equal(decodeKey(KEY).length, 32);
  assert.throws(() => decodeKey(Buffer.alloc(16).toString("base64")), /32 bytes/);
});

test("seal → open round-trips and the sealed part hides the values", () => {
  const e = seal(PLAIN, SECRETS, KEY, [{ stage: "setup", job: "resolve", added: ["registry", "setup"] }]);
  assert.equal(e.schema, SCHEMA);
  assert.equal(e.version, 1);
  assert.ok(!JSON.stringify(e).includes("s3cret"));
  const { plain, secrets } = open(parse(JSON.stringify(e)), KEY);
  assert.deepEqual(plain, PLAIN);
  assert.deepEqual(secrets, SECRETS);
});

test("tampering with the readable part, the trail or the sealed part fails to open", () => {
  const e = seal(PLAIN, SECRETS, KEY);
  assert.throws(() => open({ ...e, plain: { ...e.plain, org: "evil" } }, KEY), /authentication/);
  assert.throws(() => open({ ...e, trail: [{ stage: "x", job: "y", added: [] }] }, KEY), /authentication/);
  assert.throws(() => open({ ...e, version: 2 }, KEY), /authentication/);
  const raw = Buffer.from(e.sealed, "base64"); raw[raw.length - 1] ^= 1;
  assert.throws(() => open({ ...e, sealed: raw.toString("base64") }, KEY), /authentication/);
});

test("a wrong key fails to open", () => {
  assert.throws(() => open(seal(PLAIN, SECRETS, KEY), generateKey()), /authentication/);
});

test("unknown schema and malformed envelopes are rejected", () => {
  assert.throws(() => parse(JSON.stringify({ ...seal(PLAIN, {}, KEY), schema: "vionix.dev/cicd-context/v9" })), /unsupported/);
  assert.throws(() => parse("{nope"), /valid JSON/);
  assert.throws(() => parse(JSON.stringify({ schema: SCHEMA, version: 0, plain: {}, sealed: "", trail: [] })), /malformed/);
});

test("seal requires org + githubHost and string secret values", () => {
  assert.throws(() => seal({ org: "", githubHost: "github.com" }, {}, KEY), /required/);
  // @ts-expect-error — deliberate wrong type
  assert.throws(() => seal(PLAIN, { setup: { N: 1 } }, KEY), /must be a string/);
});

test("enrich appends a section, bumps the version and records the trail", () => {
  const e1 = seal(PLAIN, SECRETS, KEY, [{ stage: "setup", job: "resolve", added: ["registry", "setup"] }]);
  const e2 = enrich(e1, "image", { ref: "ghcr.io/planeodev/x@sha256:abc", digest: "sha256:abc" }, undefined, { stage: "build", job: "ref-build", runAttempt: 1 }, KEY);
  assert.equal(e2.version, 2);
  assert.deepEqual(e2.trail.at(-1), { stage: "build", job: "ref-build", runAttempt: 1, added: ["image"] });
  const { plain, secrets } = open(e2, KEY);
  assert.equal((plain.image as Record<string, string>).digest, "sha256:abc");
  assert.deepEqual(secrets, SECRETS);
  const e3 = enrich(e2, "signing", undefined, { VAULT_SIGN_HINT: "x" }, { stage: "attest", job: "attest" }, KEY);
  assert.equal(open(e3, KEY).secrets.signing.VAULT_SIGN_HINT, "x");
});

test("enrich is append-only and validates the section name", () => {
  const e = seal(PLAIN, SECRETS, KEY);
  assert.throws(() => enrich(e, "registry", { host: "docker.io" }, undefined, { stage: "s", job: "j" }, KEY), /append-only/);
  assert.throws(() => enrich(e, "setup", undefined, { X: "y" }, { stage: "s", job: "j" }, KEY), /append-only/);
  assert.throws(() => enrich(e, "org", { a: 1 }, undefined, { stage: "s", job: "j" }, KEY), /reserved/);
  assert.throws(() => enrich(e, "Bad_Name", { a: 1 }, undefined, { stage: "s", job: "j" }, KEY), /kebab/);
  assert.throws(() => enrich(e, "empty", {}, {}, { stage: "s", job: "j" }, KEY), /adds nothing/);
});

test("the size budget is enforced", () => {
  assert.throws(() => seal({ ...PLAIN, blob: { x: "a".repeat(950 * 1024) } }, {}, KEY), /budget/);
});

test("flatten exports names once; fromEnv requires every named var", () => {
  assert.deepEqual(flatten({ a: { X: "1" }, b: { Y: "2" } }), { X: "1", Y: "2" });
  assert.throws(() => flatten({ a: { X: "1" }, b: { X: "2" } }), /more than one section/);
  assert.throws(() => flatten({ a: { "bad-name": "1" } }), /env var name/);
  assert.deepEqual(fromEnv("A, B", { A: "1", B: "2" }), { A: "1", B: "2" });
  assert.deepEqual(fromEnv("", {}), {});
  assert.throws(() => fromEnv("MISSING", {}), /not set/);
});

test("github host comes from GITHUB_SERVER_URL (github.com or GHES)", () => {
  assert.equal(hostFromServerUrl("https://github.com"), "github.com");
  assert.equal(hostFromServerUrl("https://git.example.com/"), "git.example.com");
  assert.equal(hostFromServerUrl(""), "github.com");
});
