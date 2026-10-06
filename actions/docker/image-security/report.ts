// Evaluate a Trivy SBOM scan against the policy and write the image-security report.
//
// The report reuses the format of Vionix's `actions/docker/sbom-reporter` (Viasat/vionix and
// ohanalabs-ai/oahana-github, used by docker-compose-devsecops-check-workflow.yaml's `sbom` job):
// `# :jigsaw: SBOM Report` → `## :whale: <image>` → `* Revision:` → a collapsed
// `|Dependency|Version|Type|` table; the same markdown goes to the job summary and to one sticky PR
// comment per image. A vulnerability section and the policy verdict are added below it.
//
// buildReport() is pure (unit-tested by report.test.ts); run() is the github-script entry point.
// Inputs (env): SBOM, TRIVY_JSON, IMAGE, DIGEST, REVISION, THRESHOLD, IGNORE_UNFIXED, SBOM_ORIGIN, OUT_MD,
// OUT_META (optional: also write the verdict as JSON — consumed by pr-security-synchronizer.yaml).
// Outputs: status (pass|policy-fail), <severity>-count, blocking-count, package-count.
import { readFileSync, writeFileSync } from "node:fs";
import type { Ctx } from "./types.ts";

export const ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Severity = (typeof ORDER)[number];

interface SpdxPackage {
  SPDXID?: string;
  name?: string;
  versionInfo?: string;
  primaryPackagePurpose?: string;
  externalRefs?: Array<{ referenceLocator?: string }>;
}
interface TrivyVuln {
  VulnerabilityID?: string; PkgName?: string; InstalledVersion?: string; FixedVersion?: string; Severity?: string; Title?: string;
}
export interface Vuln { id: string; pkg: string; installed: string; fixed: string; sev: Severity; title: string }
export interface ReportInput {
  sbom: { packages?: SpdxPackage[] };
  trivy: { Results?: Array<{ Vulnerabilities?: TrivyVuln[] | null }> | null };
  image: string; digest: string; revision: string; sbomOrigin: string;
  threshold: string; ignoreUnfixed: boolean;
}
export interface ReportResult {
  md: string; status: "pass" | "policy-fail";
  counts: Record<Severity, number>; fixable: Record<Severity, number>;
  blocking: Vuln[]; packageCount: number;
}

function pkgType(p: SpdxPackage): string {
  for (const r of p.externalRefs || []) {
    const loc = r.referenceLocator || "";
    if (loc.startsWith("pkg:")) return loc.slice(4).split("/", 1)[0];
  }
  return (p.primaryPackagePurpose || "").toLowerCase() || "package";
}

function asSeverity(s: string | undefined): Severity {
  const u = (s || "UNKNOWN").toUpperCase();
  return (ORDER as readonly string[]).includes(u) ? (u as Severity) : "UNKNOWN";
}

export function buildReport(input: ReportInput): ReportResult {
  const threshold = (input.threshold || "CRITICAL").toUpperCase();
  if (!(ORDER as readonly string[]).includes(threshold) && threshold !== "NONE") {
    throw new Error(`severity-threshold must be one of ${[...ORDER, "NONE"].join(", ")}, got ${threshold}`);
  }
  const deps: Array<[string, string, string]> = [];
  for (const p of input.sbom.packages || []) {
    if (p.SPDXID === "SPDXRef-DocumentRoot" || (p.primaryPackagePurpose || "") === "CONTAINER") continue;
    deps.push([p.name || "", p.versionInfo || "", pkgType(p)]);
  }
  deps.sort((a, b) => (a[2] === b[2] ? (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0) : a[2] < b[2] ? -1 : 1));

  const vulns: Vuln[] = [];
  for (const res of input.trivy.Results || []) {
    for (const v of res.Vulnerabilities || []) {
      vulns.push({
        id: v.VulnerabilityID || "", pkg: v.PkgName || "", installed: v.InstalledVersion || "",
        fixed: v.FixedVersion || "", sev: asSeverity(v.Severity), title: (v.Title || "").slice(0, 90),
      });
    }
  }
  const counts = Object.fromEntries(ORDER.map((s) => [s, vulns.filter((v) => v.sev === s).length])) as Record<Severity, number>;
  const fixable = Object.fromEntries(ORDER.map((s) => [s, vulns.filter((v) => v.sev === s && v.fixed).length])) as Record<Severity, number>;

  let blocking: Vuln[] = [];
  if (threshold !== "NONE") {
    const atOrAbove = ORDER.slice(0, ORDER.indexOf(threshold as Severity) + 1) as readonly string[];
    blocking = vulns.filter((v) => atOrAbove.includes(v.sev) && (v.fixed || !input.ignoreUnfixed));
  }
  const status = blocking.length ? "policy-fail" : "pass";

  const out: string[] = [];
  const w = (s: string) => out.push(s);
  // ---- Vionix sbom-reporter format (verbatim structure) ----
  w("# :jigsaw: SBOM Report"); w("");
  w(`## :whale: ${input.image}`); w("");
  w(`* Revision: ${input.revision}`);
  w(`* Digest: \`${input.digest}\``);
  w(`* SBOM: ${input.sbomOrigin}`); w("");
  w("<details>"); w("  <summary>Dependencies</summary>"); w("");
  w("|Dependency|Version|Type|"); w("|---|---|----|");
  for (const [n, ver, t] of deps) w(`|${n}|${ver}|${t}|`);
  w(""); w("</details>"); w("");
  // ---- image security (Trivy on the SBOM) ----
  const icon = status === "pass" ? ":white_check_mark:" : ":x:";
  const rule = threshold === "NONE" ? "report only" : `fail on ${threshold} or above` + (input.ignoreUnfixed ? ", fixed only" : "");
  w(`## :shield: Vulnerabilities — ${icon} ${status}`); w("");
  w(`* Policy: ${rule}`);
  w(`* Scanner: Trivy on the SBOM (${deps.length} packages)`); w("");
  w("|Severity|Total|Fixable|"); w("|---|---|---|");
  for (const s of ORDER) w(`|${s}|${counts[s]}|${fixable[s]}|`);
  w("");
  if (blocking.length) {
    w("<details open>"); w(`  <summary>${blocking.length} blocking finding(s)</summary>`); w("");
    w("|ID|Package|Installed|Fixed|Severity|"); w("|---|---|---|---|---|");
    const sorted = [...blocking].sort((a, b) => ORDER.indexOf(a.sev) - ORDER.indexOf(b.sev) || (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
    for (const v of sorted.slice(0, 100)) w(`|${v.id}|${v.pkg}|${v.installed}|${v.fixed || "—"}|${v.sev}|`);
    if (blocking.length > 100) w(`|… ${blocking.length - 100} more in the artifact|||||`);
    w(""); w("</details>");
  }
  return { md: out.join("\n") + "\n", status, counts, fixable, blocking, packageCount: deps.length };
}

export default async function run({ core }: Ctx): Promise<void> {
  const env = process.env;
  let r: ReportResult;
  try {
    r = buildReport({
      sbom: JSON.parse(readFileSync(env.SBOM || "sbom.spdx.json", "utf8")),
      trivy: JSON.parse(readFileSync(env.TRIVY_JSON || "trivy.json", "utf8")),
      image: env.IMAGE || "", digest: env.DIGEST || "", revision: env.REVISION || "", sbomOrigin: env.SBOM_ORIGIN || "",
      threshold: env.THRESHOLD || "CRITICAL", ignoreUnfixed: (env.IGNORE_UNFIXED || "false").toLowerCase() === "true",
    });
  } catch (e) {
    return core.setFailed(e instanceof Error ? e.message : String(e));
  }
  writeFileSync(env.OUT_MD || "image-security-report.md", r.md);
  if (env.OUT_META) {
    const threshold = (env.THRESHOLD || "CRITICAL").toUpperCase();
    writeFileSync(env.OUT_META, JSON.stringify({
      version: 1, image: env.IMAGE || "", digest: env.DIGEST || "", revision: env.REVISION || "",
      threshold, ignore_unfixed: (env.IGNORE_UNFIXED || "false").toLowerCase() === "true",
      sbom_origin: env.SBOM_ORIGIN || "", status: r.status, counts: r.counts, blocking: r.blocking.length,
    }));
  }
  await core.summary.addRaw(r.md).write();
  core.setOutput("status", r.status);
  for (const s of ORDER) core.setOutput(`${s.toLowerCase()}-count`, r.counts[s]);
  core.setOutput("blocking-count", r.blocking.length);
  core.setOutput("package-count", r.packageCount);
  core.info(`${env.IMAGE}@${env.DIGEST}: ${r.status} — ${ORDER.map((s) => `${s} ${r.counts[s]}`).join(", ")}; blocking ${r.blocking.length}`);
}
