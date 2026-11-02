// node --test actions/vault/vault.test.ts — no network, no Vault (a fake fetch records every call).
import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceFor, digestToB64, normalizeUrl, safePath, Vault, VaultError, type Fetch } from "./client.ts";
import { decodeCa } from "./ca.ts";
import { COSIGN_PINS, cosignUrl } from "./install.ts";
import signRun, { cosignSignArgs, cosignVerifyArgs, imageDigest, meterEvent } from "./sign.ts";
import rotateRun, { generate, nextRecord } from "./rotate.ts";

const D = "a".repeat(64);
type Call = { url: string; method: string; headers: Record<string, string>; body: any };

function fakeVault(routes: Record<string, (c: Call) => [number, unknown]>): { f: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f: Fetch = async (url, init) => {
    const c: Call = { url, method: init?.method || "GET", headers: init?.headers || {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const key = `${c.method} ${new URL(url).pathname}`;
    const h = routes[key];
    const [status, body] = h ? h(c) : [404, { errors: [] }];
    return { ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
  };
  return { f, calls };
}

const LOGIN = { auth: { client_token: "hvs.TEST", lease_duration: 900, policies: ["default", "customers-acme-prd-signer"], accessor: "acc" } };
const KEY = { data: { latest_version: 2, exportable: false, allow_plaintext_backup: false, type: "ecdsa-p256", keys: { "1": { public_key: "PEM1" }, "2": { public_key: "-----BEGIN PUBLIC KEY-----\nX\n-----END PUBLIC KEY-----\n" } } } };

function fakeCore() {
  const out: Record<string, string> = {};
  const secrets: string[] = [];
  const logs: string[] = [];
  let failed = "";
  const core = {
    getInput: () => "",
    setOutput: (k: string, v: string | number) => { out[k] = String(v); },
    setSecret: (s: string) => { secrets.push(s); },
    getIDToken: async (aud?: string) => `jwt-for:${aud}`,
    exportVariable: () => {},
    setFailed: (m: string) => { failed = m; },
    addPath: () => {},
    info: (m: string) => { logs.push(m); },
    notice: () => {},
    warning: (m: string) => { logs.push(m); },
    error: () => {},
    summary: { addRaw: () => ({ write: async () => undefined }) },
  };
  return { core, out, secrets, logs, failed: () => failed };
}

function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
}

test("normalizeUrl: https only, trailing slash dropped, no query", () => {
  assert.equal(normalizeUrl("https://vault.example.com/"), "https://vault.example.com");
  assert.throws(() => normalizeUrl("http://vault.example.com"), /https/);
  assert.equal(normalizeUrl("http://127.0.0.1:8200", true), "http://127.0.0.1:8200");
  assert.throws(() => normalizeUrl("https://v.example.com/?x=1"), /query/);
});

test("safePath refuses traversal, empties and odd characters", () => {
  assert.equal(safePath("/customers/acme-prd/ci/token/", "p"), "customers/acme-prd/ci/token");
  assert.throws(() => safePath("customers/../platform", "p"), /'\.\.'/);
  assert.throws(() => safePath("a//b", "p"), /empty/);
  assert.throws(() => safePath("a b", "p"), /characters/);
  assert.throws(() => safePath("", "p"), /empty/);
});

test("digestToB64 accepts sha256:<hex> and bare hex, rejects anything else", () => {
  assert.equal(Buffer.from(digestToB64(`sha256:${D}`), "base64").length, 32);
  assert.equal(digestToB64(D), digestToB64(`sha256:${D}`));
  assert.throws(() => digestToB64("abc"), /SHA-256/);
});

test("audience defaults to GitHub's default (the owner URL), input overrides", () => {
  assert.equal(audienceFor("", "https://github.com", "acme"), "https://github.com/acme");
  assert.equal(audienceFor("https://vault.planeo.dev/acme", "https://github.com", "acme"), "https://vault.planeo.dev/acme");
});

test("login posts role+jwt unauthenticated to auth/<mount>/login; later calls carry the token", async () => {
  const { f, calls } = fakeVault({
    "POST /v1/auth/github/acme/login": () => [200, LOGIN],
    "GET /v1/transit/keys/customers-acme-prd-images": () => [200, KEY],
  });
  const v = new Vault("https://vault.example.com", f);
  const r = await v.login("github/acme", "acme-prd-app-main", "JWT");
  assert.equal(r.ttl, 900);
  assert.deepEqual(calls[0].body, { role: "acme-prd-app-main", jwt: "JWT" });
  assert.equal(calls[0].headers["x-vault-token"], undefined);
  const pk = await v.publicKey("transit", "customers-acme-prd-images");
  assert.equal(pk.version, 2);
  assert.match(pk.pem, /BEGIN PUBLIC KEY/);
  assert.equal(calls[1].headers["x-vault-token"], "hvs.TEST");
  await assert.rejects(v.login("github/acme", "a/b", "JWT"), /single name/);
});

test("errors surface Vault's message + a hint, never the request body", async () => {
  const { f } = fakeVault({ "POST /v1/auth/github-jwt/login": () => [400, { errors: ["error validating claims: claim \"repository\" does not match any associated bound claim values"] }] });
  const v = new Vault("https://vault.example.com", f);
  await assert.rejects(v.login("github-jwt", "r", "SECRET-JWT"), (e: Error) => e instanceof VaultError && /claims do not match/.test(e.message) && !e.message.includes("SECRET-JWT"));
});

test("signDigest: prehashed sha2-256, asn1, parses the key version", async () => {
  const { f, calls } = fakeVault({ "POST /v1/transit/sign/k/sha2-256": () => [200, { data: { signature: "vault:v3:MEUCIQ==" } }] });
  const v = new Vault("https://vault.example.com", f);
  v.token = "t";
  const s = await v.signDigest("transit", "k", D);
  assert.deepEqual(s, { signature: "vault:v3:MEUCIQ==", keyVersion: 3 });
  assert.deepEqual(calls[0].body, { input: digestToB64(D), prehashed: true, marshaling_algorithm: "asn1" });
});

test("kvRead returns null on 404; kvWrite sends cas", async () => {
  const { f, calls } = fakeVault({ "POST /v1/kv/data/customers/acme-prd/ci/token": () => [200, { data: { version: 1 } }] });
  const v = new Vault("https://vault.example.com", f);
  v.token = "t";
  assert.equal(await v.kvRead("kv", "customers/acme-prd/ci/token"), null);
  assert.equal(await v.kvWrite("kv", "customers/acme-prd/ci/token", { token: "x" }, 0), 1);
  assert.deepEqual(calls[1].body, { options: { cas: 0 }, data: { token: "x" } });
});

test("generate: length bounds and encodings", () => {
  assert.equal(Buffer.from(generate(32, "base64"), "base64").length, 32);
  assert.equal(generate(16, "hex").length, 32);
  assert.match(generate(24, "base64url"), /^[A-Za-z0-9_-]+$/);
  assert.throws(() => generate(8, "hex"), /\[16, 1024\]/);
  assert.throws(() => generate(32, "utf8"), /encoding/);
});

test("nextRecord keeps the other fields unless told not to; validates the field name", () => {
  assert.deepEqual(nextRecord({ token: "old", user: "svc" }, "token", "new", true), { token: "new", user: "svc" });
  assert.deepEqual(nextRecord({ token: "old", user: "svc" }, "token", "new", false), { token: "new" });
  assert.throws(() => nextRecord({}, "a b", "v", true), /field/);
});

test("cosign args: hashivault key, no signing-config, no tlog; image must be digest-pinned", () => {
  assert.deepEqual(cosignSignArgs("k", `ghcr.io/o/i@sha256:${D}`), ["sign", "--yes", "--key", "hashivault://k", "--use-signing-config=false", "--tlog-upload=false", `ghcr.io/o/i@sha256:${D}`]);
  assert.ok(cosignVerifyArgs("k", "x").includes("--insecure-ignore-tlog=true"));
  assert.equal(imageDigest(`ghcr.io/o/i@sha256:${D}`), `sha256:${D}`);
  assert.throws(() => imageDigest("ghcr.io/o/i:1.0"), /pinned by digest/);
});

test("pins: one sha256 per arch, release URL", () => {
  for (const a of ["amd64", "arm64"]) assert.match(COSIGN_PINS[a], /^[0-9a-f]{64}$/);
  assert.match(cosignUrl("amd64"), /releases\/download\/v\d+\.\d+\.\d+\/cosign-linux-amd64$/);
});

test("decodeCa accepts a base64 PEM and rejects garbage", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  assert.equal(decodeCa(Buffer.from(pem).toString("base64")), pem);
  assert.throws(() => decodeCa(Buffer.from("hello").toString("base64")), /PEM/);
});

test("meterEvent is a CloudEvent with no secret material", () => {
  const e = JSON.parse(meterEvent("sign", { GITHUB_REPOSITORY: "acme/app", GITHUB_RUN_ID: "7", VAULT_ROLE: "r" } as NodeJS.ProcessEnv, { key: "k" }));
  assert.equal(e.specversion, "1.0");
  assert.equal(e.type, "dev.planeo.vault.sign");
  assert.equal(e.source, "https://github.com/acme/app");
});

test("sign (digest mode) end to end: login → key guard → sign → verify → revoke; token masked", async () => {
  const { f, calls } = fakeVault({
    "POST /v1/auth/github-jwt/login": () => [200, LOGIN],
    "GET /v1/transit/keys/k": () => [200, KEY],
    "POST /v1/transit/sign/k/sha2-256": () => [200, { data: { signature: "vault:v2:SIG" } }],
    "POST /v1/transit/verify/k/sha2-256": () => [200, { data: { valid: true } }],
    "POST /v1/auth/token/revoke-self": () => [204, undefined],
  });
  const c = fakeCore();
  await withEnv({ VAULT_URL: "https://vault.example.com", VAULT_AUTH_PATH: "github-jwt", VAULT_ROLE: "r", VAULT_AUDIENCE: "https://vault.planeo.dev/acme", KEY: "k", MODE: "digest", DIGEST: `sha256:${D}` }, () =>
    signRun({ core: c.core, exec: {} as any, github: {}, context: {} }, f));
  assert.equal(c.out.signature, "vault:v2:SIG");
  assert.equal(c.out["key-version"], "2");
  assert.ok(c.secrets.includes("hvs.TEST"));
  assert.equal(calls[0].body.jwt, "jwt-for:https://vault.planeo.dev/acme");
  assert.equal(calls.at(-1)!.url.endsWith("/v1/auth/token/revoke-self"), true);
});

test("sign refuses an exportable key and still revokes the token", async () => {
  const { f, calls } = fakeVault({
    "POST /v1/auth/github-jwt/login": () => [200, LOGIN],
    "GET /v1/transit/keys/k": () => [200, { data: { ...KEY.data, exportable: true } }],
    "POST /v1/auth/token/revoke-self": () => [204, undefined],
  });
  const c = fakeCore();
  await assert.rejects(
    withEnv({ VAULT_URL: "https://vault.example.com", VAULT_ROLE: "r", KEY: "k", MODE: "digest", DIGEST: D }, () => signRun({ core: c.core, exec: {} as any, github: {}, context: {} }, f)),
    /refusing to sign/,
  );
  assert.equal(calls.at(-1)!.url.endsWith("/v1/auth/token/revoke-self"), true);
});

test("rotate end to end: read v4 → write with cas 4 → v5; value masked, not output by default; dispatch has no value", async () => {
  let written: any;
  const { f } = fakeVault({
    "POST /v1/auth/github-jwt/login": () => [200, LOGIN],
    "GET /v1/kv/data/customers/acme-prd/ci/app-token": () => [200, { data: { data: { token: "old", user: "svc" }, metadata: { version: 4 } } }],
    "POST /v1/kv/data/customers/acme-prd/ci/app-token": (c) => { written = c.body; return [200, { data: { version: 5 } }]; },
    "POST /v1/auth/token/revoke-self": () => [204, undefined],
  });
  const c = fakeCore();
  let dispatched: any;
  const github = { rest: { repos: { createDispatchEvent: async (p: any) => { dispatched = p; } } } };
  await withEnv({ VAULT_URL: "https://vault.example.com", VAULT_ROLE: "r", KV_MOUNT: "kv", SECRET_PATH: "customers/acme-prd/ci/app-token", FIELD: "token", DISPATCH_REPOSITORY: "acme/app" }, () =>
    rotateRun({ core: c.core, exec: {} as any, github, context: {} }, f));
  assert.equal(written.options.cas, 4);
  assert.equal(written.data.user, "svc");
  assert.notEqual(written.data.token, "old");
  assert.ok(c.secrets.includes(written.data.token));
  assert.equal(c.out.version, "5");
  assert.equal(c.out["previous-version"], "4");
  assert.equal(c.out.value, undefined);
  assert.equal(JSON.stringify(dispatched).includes(written.data.token), false);
  assert.equal(dispatched.client_payload.version, 5);
});

test("rotate: a CAS conflict (another rotation won) fails the step", async () => {
  const { f } = fakeVault({
    "POST /v1/auth/github-jwt/login": () => [200, LOGIN],
    "GET /v1/kv/data/p": () => [200, { data: { data: { value: "a" }, metadata: { version: 1 } } }],
    "POST /v1/kv/data/p": () => [400, { errors: ["check-and-set parameter did not match the current version"] }],
    "POST /v1/auth/token/revoke-self": () => [204, undefined],
  });
  const c = fakeCore();
  await assert.rejects(
    withEnv({ VAULT_URL: "https://vault.example.com", VAULT_ROLE: "r", KV_MOUNT: "kv", SECRET_PATH: "p" }, () => rotateRun({ core: c.core, exec: {} as any, github: {}, context: {} }, f)),
    /check-and-set/,
  );
});
