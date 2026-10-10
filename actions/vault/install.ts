// Install cosign from its GitHub release, checked against a sha256 pinned in THIS file (taken from the
// release's cosign_checksums.txt, 2026-10-09). Same approach as actions/kubernetes/manifest-check/install.ts.
// Only the `cosign` mode of vault-sign needs it; the `digest` mode is pure TypeScript.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, arch as osArch } from "node:os";
import type { Ctx } from "./types.ts";

export const COSIGN_VERSION = "3.1.3";
export const COSIGN_PINS: Record<string, string> = {
  amd64: "4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71",
  arm64: "c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a",
};

export function cosignUrl(arch: string): string {
  return `https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${arch}`;
}

async function download(url: string): Promise<Buffer> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export default async function run({ core }: Ctx): Promise<void> {
  const a = osArch();
  const arch = a === "x64" ? "amd64" : a === "arm64" ? "arm64" : "";
  if (!arch) return core.setFailed(`unsupported arch ${a}`);
  const body = await download(cosignUrl(arch));
  const got = createHash("sha256").update(body).digest("hex");
  if (got !== COSIGN_PINS[arch]) return core.setFailed(`cosign checksum mismatch: got ${got}, pinned ${COSIGN_PINS[arch]}`);
  const dir = join(process.env.RUNNER_TEMP || tmpdir(), "vault-sign-bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cosign"), body);
  chmodSync(join(dir, "cosign"), 0o755);
  core.addPath(dir);
  core.info(`cosign v${COSIGN_VERSION} (${arch}) installed, sha256 verified`);
}
