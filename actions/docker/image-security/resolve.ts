// Log in to ghcr.io (read) when the image lives there, then resolve the image to its immutable digest.
import type { Ctx } from "./types.ts";

/** repo without tag or digest: "ghcr.io/o/r/svc:tag" → "ghcr.io/o/r/svc"; handles registry ports. */
export function repoOf(image: string): string {
  const noDigest = image.split("@")[0];
  const slash = noDigest.lastIndexOf("/");
  const colon = noDigest.lastIndexOf(":");
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const image = process.env.IMAGE_IN || "";
  const sbomSource = process.env.SBOM_SOURCE || "build";
  if (sbomSource !== "build" && sbomSource !== "generate") return core.setFailed("sbom-source must be build or generate");
  if (image.startsWith("ghcr.io/")) {
    const token = process.env.GH_TOKEN || "";
    await exec.exec("docker", ["login", "ghcr.io", "-u", process.env.GITHUB_ACTOR || "github-actions", "--password-stdin"], {
      input: Buffer.from(token),
      silent: true,
    });
  }
  const out = await exec.getExecOutput("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"], { silent: true });
  const digest = String((JSON.parse(out.stdout) as { digest?: string }).digest || "");
  if (!digest.startsWith("sha256:")) return core.setFailed(`could not resolve a digest for ${image}`);
  const repo = repoOf(image);
  core.setOutput("repo", repo);
  core.setOutput("digest", digest);
  core.setOutput("ref", `${repo}@${digest}`);
  core.info(`Scanning ${repo}@${digest}`);
}
