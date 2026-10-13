import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD, hostFromServerUrl, logicalPath, kvDataUrl, parseKvRead, writeBody, summaryMarkdown } from "./config-stream.ts";

test("the path is derived from where the workflow runs", () => {
  assert.equal(logicalPath("github.com", "planeodev"), "global/github.com/planeodev/platform/vionix/config-stream");
  assert.equal(logicalPath(hostFromServerUrl("https://git.example.com"), "acme"), "global/git.example.com/acme/platform/vionix/config-stream");
  assert.throws(() => logicalPath("github.com", ""), /github org/);
  assert.throws(() => logicalPath("github.com", "../etc"), /invalid/);
});

test("KV v2 data URL", () => {
  assert.equal(kvDataUrl("https://vault.example.com/", "planeo", "global/github.com/o/platform/vionix/config-stream"),
    "https://vault.example.com/v1/planeo/data/global/github.com/o/platform/vionix/config-stream");
  assert.throws(() => kvDataUrl("vault.example.com", "planeo", "p"), /http/);
  assert.throws(() => kvDataUrl("https://v", "bad mount", "p"), /mount/);
});

test("KV read: found, missing, deleted, error", () => {
  assert.deepEqual(parseKvRead(200, { data: { data: { [FIELD]: "k" }, metadata: { version: 3 } } }), { found: true, value: "k", version: 3 });
  assert.deepEqual(parseKvRead(404, null), { found: false });
  assert.deepEqual(parseKvRead(200, { data: { data: null, metadata: { version: 4 } } }), { found: false, version: 4 });
  assert.throws(() => parseKvRead(403, {}), /HTTP 403/);
});

test("writes are create-only unless rotating, and rotation is compare-and-set", () => {
  assert.deepEqual(writeBody("k", false), { data: { [FIELD]: "k" }, options: { cas: 0 } });
  assert.deepEqual(writeBody("k", true, 5), { data: { [FIELD]: "k" }, options: { cas: 5 } });
});

test("summary: every outcome renders, and never a key value", () => {
  const kept = summaryMarkdown({ mode: "setup", outcome: "kept", path: "planeo/global/github.com/o/platform/vionix/config-stream", org: "o", host: "github.com", version: 1, rotate: false, orgSecret: "not-requested" });
  assert.match(kept, /kept \(unchanged\)/);
  assert.match(kept, /v1/);
  assert.match(kept, /create-only/);
  assert.match(kept, /not requested/);
  const created = summaryMarkdown({ mode: "setup", outcome: "created", path: "p", org: "o", version: 1, rotate: false, orgSecret: "pushed" });
  assert.match(created, /✅ created/);
  assert.match(created, /pushed to \*\*o\*\*/);
  assert.match(summaryMarkdown({ mode: "get", outcome: "read", source: "vault", version: 2, path: "p" }), /read from Vault[\s\S]*Key source \| Vault/);
  assert.match(summaryMarkdown({ mode: "get", outcome: "provided", source: "env" }), /org secret CONFIG_STREAM_KEY/);
  assert.match(summaryMarkdown({ mode: "revoke", outcome: "revoked", httpStatus: 204 }), /🔒 Vault token[\s\S]*revoked[\s\S]*204/);
  assert.match(summaryMarkdown({ mode: "revoke", outcome: "no-token" }), /no Vault token/);
  const failed = summaryMarkdown({ mode: "setup", error: "VAULT_ADDR must be an http(s) URL | x" });
  assert.match(failed, /❌ failed/);
  assert.match(failed, /VAULT_ADDR must be/);
  assert.match(failed, /\\\|/); // a pipe in an error cannot break the table
  for (const md of [kept, created, failed]) assert.doesNotMatch(md, /[A-Za-z0-9+/]{43}=/); // no base64 32-byte key
});
