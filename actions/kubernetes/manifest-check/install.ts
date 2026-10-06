// Install the manifest-check toolchain — kustomize, helm, kubeconform, yq — from their release
// artifacts, each checked against a sha256 pinned in THIS file (the published checksums of the same
// releases, cross-checked when the pins were taken). Same approach as
// actions/docker/image-security/install.ts. TOOLS (env) selects a subset; yq is always installed.
// Node built-ins only (fetch, crypto, fs) + github-script's exec.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, arch as osArch } from "node:os";
import type { Ctx } from "./types.ts";

export const VERSIONS = { kustomize: "5.8.2", helm: "3.22.0", kubeconform: "0.8.0", yq: "4.54.1" };
export const PINS: Record<string, string> = {
  "kustomize-amd64": "06af0a202c2b831207d0173f9c9cdb1b30abceca0747cb3fbb72792d26055c95",
  "kustomize-arm64": "0991957191951cb7dddd142403b5bb98a1fcd6378ba0079dddc1e2c309080a7f",
  "helm-amd64": "1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb",
  "helm-arm64": "f14e804dfee240f55525b667488fe9adca349e63e00c9af634c0beb1421ac310",
  "kubeconform-amd64": "9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883",
  "kubeconform-arm64": "1f53fc8e81258197a35e8603054162a5af1de8c5af13746c71ab680d9534ed87",
  "yq-amd64": "8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f",
  "yq-arm64": "189088da0c6429ec5178dfaab1a114805f6cab0b61b165ab236efedf1d57a71b",
};

export function urlFor(tool: string, arch: string): string {
  const v = VERSIONS as Record<string, string>;
  switch (tool) {
    case "kustomize": return `https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${v.kustomize}/kustomize_v${v.kustomize}_linux_${arch}.tar.gz`;
    case "helm": return `https://get.helm.sh/helm-v${v.helm}-linux-${arch}.tar.gz`;
    case "kubeconform": return `https://github.com/yannh/kubeconform/releases/download/v${v.kubeconform}/kubeconform-linux-${arch}.tar.gz`;
    case "yq": return `https://github.com/mikefarah/yq/releases/download/v${v.yq}/yq_linux_${arch}`;
    default: throw new Error(`unknown tool ${tool}`);
  }
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

async function verified(tool: string, arch: string, dest: string): Promise<void> {
  const url = urlFor(tool, arch);
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
  const tools = new Set((process.env.TOOLS || "kustomize helm kubeconform").split(/\s+/).filter(Boolean));
  tools.add("yq");
  const binDir = process.env.BIN_DIR || join(process.env.RUNNER_TEMP || tmpdir(), "manifest-check-bin");
  mkdirSync(binDir, { recursive: true });
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "mcheck-"));
  for (const tool of tools) {
    if (tool === "yq") {
      const dest = join(binDir, "yq");
      await verified("yq", arch, dest);
      chmodSync(dest, 0o755);
      continue;
    }
    const tgz = join(work, `${tool}.tgz`);
    await verified(tool, arch, tgz);
    if (tool === "helm") await exec.exec("tar", ["-xzf", tgz, "-C", binDir, "--strip-components=1", `linux-${arch}/helm`]);
    else await exec.exec("tar", ["-xzf", tgz, "-C", binDir, tool]);
  }
  core.addPath(binDir);
  for (const tool of tools) {
    const args = tool === "kustomize" ? ["version"] : tool === "helm" ? ["version", "--short"] : tool === "kubeconform" ? ["-v"] : ["--version"];
    await exec.exec(join(binDir, tool), args);
  }
}
