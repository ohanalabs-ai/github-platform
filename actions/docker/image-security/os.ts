// OS packages from the image, when the SBOM declares no operating system.
//
// `trivy sbom` scans OS packages only when the SBOM declares the operating system (an SPDX package
// with primaryPackagePurpose OPERATING-SYSTEM / a CycloneDX operating-system component). The build's
// Syft SPDX lists the deb/apk packages with distro purls but no such package, so without this step
// every OS vulnerability is silently skipped (seen on all ten Online Boutique images: 0 os-pkgs
// findings). Scan the image's OS packages by digest and merge the results into trivy.json.
import { readFileSync, writeFileSync } from "node:fs";
import type { Ctx } from "./types.ts";

interface TrivyDoc { Results?: Array<{ Class?: string; Vulnerabilities?: unknown[] | null }> | null }

export function declaresOs(sbom: { packages?: Array<{ primaryPackagePurpose?: string }> }): boolean {
  return (sbom.packages || []).some((p) => p.primaryPackagePurpose === "OPERATING-SYSTEM");
}

export function mergeResults(base: TrivyDoc, os: TrivyDoc): TrivyDoc {
  return { ...base, Results: [...(base.Results || []), ...(os.Results || [])] };
}

export default async function run({ core, exec }: Ctx): Promise<void> {
  const sbom = JSON.parse(readFileSync("sbom.spdx.json", "utf8"));
  if (declaresOs(sbom)) return core.setOutput("origin", "SBOM (declares the OS)");
  await exec.exec("trivy", ["image", "--quiet", "--scanners", "vuln", "--pkg-types", "os", "--format", "json", "--output", "trivy-os.json", process.env.REF || ""]);
  const merged = mergeResults(JSON.parse(readFileSync("trivy.json", "utf8")), JSON.parse(readFileSync("trivy-os.json", "utf8")));
  writeFileSync("trivy.json", JSON.stringify(merged));
  const n = (merged.Results || []).filter((r) => r.Class === "os-pkgs").reduce((a, r) => a + (r.Vulnerabilities || []).length, 0);
  core.notice(`the build SBOM declares no operating system — OS packages scanned from the image by digest (${n} finding(s))`);
  core.setOutput("origin", "image by digest (the SBOM declares no OS)");
}
