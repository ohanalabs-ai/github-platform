import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD, hostFromServerUrl, logicalPath, kvDataUrl, parseKvRead, writeBody } from "./config-stream.ts";

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
