// Install Trivy and Syft from their GitHub release tarballs, each checked against a sha256 pinned in
// THIS file (pins and approach adopted from ohanalabs-ai/github-platform PR #35's toolchain installer).
// Trivy is deliberately NOT installed through aquasecurity/trivy-action or setup-trivy: their tags
// were compromised (GHSA-69fq-xp46-6x23). Node built-ins only (fetch, crypto, fs) + github-script's exec.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, arch as osArch } from "node:os";
import type { Ctx } from "./types.ts";

const TRIVY_VERSION = "0.74.0";
const SYFT_VERSION = "1.52.0";
const PINS: Record<string, string> = {
  "trivy-amd64": "2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a",
  "trivy-arm64": "b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5",
  "syft-amd64": "caeedb81fb0491615f1ebd1761e4145d41ee86dd2cc7bf80669f9f5ad9d6133d",
  "syft-arm64": "c46d5e4c28e12aa4c5becfaa343ef1c7f89045b6b895f2c21d471c62db09c706",
};

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

async function verified(tool: string, arch: string, url: string, dest: string): Promise<void> {
  const body = await download(url);
  const got = createHash("sha256").update(body).digest("hex");
  const want = PINS[`${tool}-${arch}`];
  if (got !== want) throw new Error(`${tool} checksum mismatch for ${url}: got ${got}, pinned ${want}`);
  writeFileSync(dest, body);
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const a = osArch();
  const arch = a === "x64" ? "amd64" : a === "arm64" ? "arm64" : "";
  if (!arch) return core.setFailed(`unsupported arch ${a}`);
  const binDir = process.env.BIN_DIR || join(process.env.RUNNER_TEMP || tmpdir(), "image-security-bin");
  mkdirSync(binDir, { recursive: true });
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "imgsec-"));
  const trivyArch = arch === "amd64" ? "64bit" : "ARM64";
  const trivyTgz = join(work, "trivy.tgz");
  await verified("trivy", arch, `https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${trivyArch}.tar.gz`, trivyTgz);
  await exec.exec("tar", ["-xzf", trivyTgz, "-C", binDir, "trivy"]);
  const syftTgz = join(work, "syft.tgz");
  await verified("syft", arch, `https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_${arch}.tar.gz`, syftTgz);
  await exec.exec("tar", ["-xzf", syftTgz, "-C", binDir, "syft"]);
  core.addPath(binDir);
  await exec.exec(join(binDir, "trivy"), ["--version"]);
  await exec.exec(join(binDir, "syft"), ["version"]);
}
