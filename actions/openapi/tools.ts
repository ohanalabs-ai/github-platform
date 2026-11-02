// 🧰 devsecops-openapi — tool installation: vacuum (MIT) and oasdiff (Apache-2.0), each pinned by VERSION and
// by the SHA-256 of the release archive (checked before anything is unpacked). No npm, no shell logic; the
// only subprocess is `tar`. Checksums are the upstream `checksums.txt` of each release (the table is the
// single place to bump — update the README together).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Tool { name: string; version: string; license: string; url: (platform: string) => string; sha256: Record<string, string>; binary: string }

export const VACUUM: Tool = {
  name: "vacuum", version: "0.36.2", license: "MIT", binary: "vacuum",
  url: (p) => `https://github.com/daveshanley/vacuum/releases/download/v0.36.2/vacuum_0.36.2_${p}.tar.gz`,
  sha256: {
    linux_x86_64: "5736f27a806888f7ed89fba6bb8a3a00e5da895f1ad870f699b3018b7c8bcb0d",
    darwin_arm64: "7fb1666195a8fe2075fd4fb4076831f1152ef8257dfe087d343e71f17a389688",
  },
};

export const OASDIFF: Tool = {
  name: "oasdiff", version: "1.35.0", license: "Apache-2.0", binary: "oasdiff",
  url: (p) => `https://github.com/oasdiff/oasdiff/releases/download/v1.35.0/oasdiff_1.35.0_${p}.tar.gz`,
  sha256: {
    linux_amd64: "a8023002fcb2eaa7f5758148a9303cb63d33b939886df312268bc0fc7b939140",
    darwin_all: "964ad2c0331768c4515fc49779827094bc89a65b1d309dac28886d1c3faf305c",
  },
};

/** The release-asset platform suffix for this host (GitHub runners are linux/x64; darwin is for local runs). */
export function platformKey(tool: Tool, platform = process.platform, arch = process.arch): string {
  const linux = tool === VACUUM ? "linux_x86_64" : "linux_amd64";
  const darwin = tool === VACUUM ? "darwin_arm64" : "darwin_all";
  if (platform === "linux" && arch === "x64") return linux;
  if (platform === "darwin" && arch === "arm64") return darwin;
  throw new Error(`${tool.name}: no pinned archive for ${platform}/${arch}`);
}

export function sha256Hex(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }

export function verifyChecksum(tool: Tool, key: string, data: Uint8Array): void {
  const want = tool.sha256[key];
  if (!want) throw new Error(`${tool.name} ${tool.version}: no checksum pinned for ${key}`);
  const got = sha256Hex(data);
  if (got !== want) throw new Error(`${tool.name} ${tool.version} ${key}: checksum mismatch — expected ${want}, got ${got}`);
}

/** Download, verify the SHA-256, unpack, put the binary on PATH. Fails loudly (never a silent fallback). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function install(tool: Tool, { core, exec }: { core: any; exec: any }, dir = join(process.env.RUNNER_TEMP || "/tmp", "openapi-tools")): Promise<string> {
  const key = platformKey(tool);
  const bin = join(dir, tool.name, tool.binary);
  if (!existsSync(bin)) {
    const url = tool.url(key);
    core.info(`📥 ${tool.name} ${tool.version} (${tool.license}) ← ${url}`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${tool.name}: download failed — HTTP ${res.status} ${url}`);
    const data = new Uint8Array(await res.arrayBuffer());
    verifyChecksum(tool, key, data);
    mkdirSync(join(dir, tool.name), { recursive: true });
    const archive = join(dir, `${tool.name}.tar.gz`);
    writeFileSync(archive, data);
    await exec.exec("tar", ["-xzf", archive, "-C", join(dir, tool.name)]);
    chmodSync(bin, 0o755);
  }
  core.addPath(join(dir, tool.name));
  core.info(`✅ ${tool.name} ${tool.version} sha256 ${tool.sha256[key]}`);
  return bin;
}
