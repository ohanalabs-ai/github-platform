import { test } from "node:test";
import assert from "node:assert/strict";
import { VACUUM, OASDIFF, platformKey, sha256Hex, verifyChecksum } from "./tools.ts";

test("every pinned checksum is a 64-hex sha256 and every URL carries the pinned version", () => {
  for (const t of [VACUUM, OASDIFF]) {
    for (const [k, v] of Object.entries(t.sha256)) {
      assert.match(v, /^[a-f0-9]{64}$/, `${t.name} ${k}`);
      assert.ok(t.url(k).includes(t.version), `${t.name} url has version`);
      assert.ok(t.url(k).endsWith(`${k}.tar.gz`));
    }
  }
});

test("platform keys: linux/x64 on the runners, darwin/arm64 locally, anything else throws", () => {
  assert.equal(platformKey(VACUUM, "linux", "x64"), "linux_x86_64");
  assert.equal(platformKey(OASDIFF, "linux", "x64"), "linux_amd64");
  assert.equal(platformKey(OASDIFF, "darwin", "arm64"), "darwin_all");
  assert.throws(() => platformKey(VACUUM, "win32", "x64"), /no pinned archive/);
});

test("checksum verification accepts the pinned bytes' hash and rejects any other content", () => {
  const data = new TextEncoder().encode("hello");
  assert.equal(sha256Hex(data), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  const t = { ...VACUUM, sha256: { linux_x86_64: sha256Hex(data) } };
  verifyChecksum(t, "linux_x86_64", data);
  assert.throws(() => verifyChecksum(t, "linux_x86_64", new TextEncoder().encode("tampered")), /checksum mismatch/);
  assert.throws(() => verifyChecksum(t, "darwin_arm64", data), /no checksum pinned/);
});
