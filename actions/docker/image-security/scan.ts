// Trivy on the SBOM.
import type { Ctx } from "./types.ts";

export default async function run({ exec }: Ctx): Promise<void> {
  await exec.exec("trivy", ["sbom", "--quiet", "--format", "json", "--output", "trivy.json", "--scanners", "vuln", "sbom.spdx.json"]);
}
