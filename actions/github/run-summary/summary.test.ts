import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRunSummary, parseOutcomes, parseLines } from "./summary.ts";

test("every step with its outcome, labels, only the listed outputs", () => {
  const md = renderRunSummary(
    "vionix config-stream key",
    {
      join: { outcome: "success" },
      vault: { outcome: "success", outputs: { CONFIG_STREAM_KEY: "SHOULD-NOT-APPEAR" } },
      key: { outcome: "success", outputs: { path: "planeo/global/github.com/o/platform/vionix/config-stream", version: "1", created: "false" } },
      revoke: { outcome: "failure" },
    },
    { join: "🌐 tailnet join", key: "🔑 key" },
    ["key.path", "key.version", "key.created"],
    { "Rotate": "false" },
    "failure",
  );
  assert.match(md, /📋 vionix config-stream key — ❌ failure/);
  assert.match(md, /\| 🌐 tailnet join \| ✅ success \|/);
  assert.match(md, /\| revoke \| ❌ failure \|/);
  assert.match(md, /🔑 key · version \| `1`/);
  assert.match(md, /Rotate \| `false`/);
  assert.doesNotMatch(md, /SHOULD-NOT-APPEAR/);
});

test("a run that failed before any id'd step still summarizes", () => {
  const md = renderRunSummary("x", {}, {}, [], {}, "failure");
  assert.match(md, /📋 x — ❌ failure/);
});

test("explicit outcome lines (an empty outcome = skipped step)", () => {
  const steps = parseOutcomes("🌐 tailnet join=success\n🔐 Vault login=failure\n🔑 key=\nnot a line");
  assert.deepEqual(steps, { "🌐 tailnet join": { outcome: "success" }, "🔐 Vault login": { outcome: "failure" }, "🔑 key": { outcome: "skipped" } });
  assert.match(renderRunSummary("t", steps, {}, [], { "Vault path": "planeo/x" }, "failure"), /🔑 key \| ⏭️ skipped[\s\S]*Vault path \| `planeo\/x`/);
});

test("fact lines: first = splits, blank values dropped from the table", () => {
  assert.deepEqual(parseLines("Vault path=planeo/a=b\nKV version=1\nEmpty=\n"), { "Vault path": "planeo/a=b", "KV version": "1", Empty: "" });
  assert.doesNotMatch(renderRunSummary("t", {}, {}, [], parseLines("Empty=")), /Empty/);
});
