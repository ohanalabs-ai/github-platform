#!/usr/bin/env python3
"""Evaluate a Trivy SBOM scan against the policy and write the image-security report.

The report reuses the format of Vionix's `actions/docker/sbom-reporter` (Viasat/vionix and
ohanalabs-ai/oahana-github, used by docker-compose-devsecops-check-workflow.yaml's `sbom` job):
`# :jigsaw: SBOM Report` → `## :whale: <image>` → `* Revision:` → a collapsed
`|Dependency|Version|Type|` table; the same markdown goes to the job summary and to one sticky
PR comment per image. A vulnerability section and the policy verdict are added below it.

Inputs (env): SBOM, TRIVY_JSON, IMAGE, DIGEST, REVISION, THRESHOLD, IGNORE_UNFIXED, SBOM_ORIGIN, OUT_MD.
Outputs: written to $GITHUB_OUTPUT — status (pass|policy-fail), counts per severity, blocking.
Stdlib only.
"""
import json, os, sys

ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]
env = os.environ.get


def pkg_type(p):
    for r in p.get("externalRefs") or []:
        loc = r.get("referenceLocator", "")
        if loc.startswith("pkg:"):
            return loc[4:].split("/", 1)[0]
    return (p.get("primaryPackagePurpose") or "").lower() or "package"


def main():
    threshold = (env("THRESHOLD") or "CRITICAL").upper()
    if threshold not in ORDER + ["NONE"]:
        print(f"::error::severity-threshold must be one of {ORDER + ['NONE']}, got {threshold}")
        return 2
    ignore_unfixed = (env("IGNORE_UNFIXED") or "false").lower() == "true"
    sbom = json.load(open(env("SBOM")))
    trivy = json.load(open(env("TRIVY_JSON")))

    deps = []
    for p in sbom.get("packages") or []:
        if p.get("SPDXID") == "SPDXRef-DocumentRoot" or (p.get("primaryPackagePurpose") or "") == "CONTAINER":
            continue
        deps.append((p.get("name", ""), p.get("versionInfo", ""), pkg_type(p)))
    deps.sort(key=lambda d: (d[2], d[0].lower()))

    vulns = []
    for res in trivy.get("Results") or []:
        for v in res.get("Vulnerabilities") or []:
            vulns.append({
                "id": v.get("VulnerabilityID", ""), "pkg": v.get("PkgName", ""),
                "installed": v.get("InstalledVersion", ""), "fixed": v.get("FixedVersion", "") or "",
                "sev": (v.get("Severity") or "UNKNOWN").upper(), "title": (v.get("Title") or "")[:90],
            })
    counts = {s: sum(1 for v in vulns if v["sev"] == s) for s in ORDER}
    fixable = {s: sum(1 for v in vulns if v["sev"] == s and v["fixed"]) for s in ORDER}

    if threshold == "NONE":
        blocking = []
    else:
        at_or_above = ORDER[: ORDER.index(threshold) + 1]
        blocking = [v for v in vulns if v["sev"] in at_or_above and (v["fixed"] or not ignore_unfixed)]
    status = "policy-fail" if blocking else "pass"

    image, digest = env("IMAGE"), env("DIGEST")
    out = []
    w = out.append
    # ---- Vionix sbom-reporter format (verbatim structure) ----
    w("# :jigsaw: SBOM Report"); w("")
    w(f"## :whale: {image}"); w("")
    w(f"* Revision: {env('REVISION', '')}")
    w(f"* Digest: `{digest}`")
    w(f"* SBOM: {env('SBOM_ORIGIN', '')}"); w("")
    w("<details>"); w("  <summary>Dependencies</summary>"); w("")
    w("|Dependency|Version|Type|"); w("|---|---|----|")
    for n, ver, t in deps:
        w(f"|{n}|{ver}|{t}|")
    w(""); w("</details>"); w("")
    # ---- image security (Trivy on the SBOM) ----
    icon = ":white_check_mark:" if status == "pass" else ":x:"
    rule = "report only" if threshold == "NONE" else f"fail on {threshold} or above" + (", fixed only" if ignore_unfixed else "")
    w(f"## :shield: Vulnerabilities — {icon} {status}"); w("")
    w(f"* Policy: {rule}")
    w(f"* Scanner: Trivy on the SBOM ({len(deps)} packages)"); w("")
    w("|Severity|Total|Fixable|"); w("|---|---|---|")
    for s in ORDER:
        w(f"|{s}|{counts[s]}|{fixable[s]}|")
    w("")
    if blocking:
        w("<details open>"); w(f"  <summary>{len(blocking)} blocking finding(s)</summary>"); w("")
        w("|ID|Package|Installed|Fixed|Severity|"); w("|---|---|---|---|---|")
        for v in sorted(blocking, key=lambda v: (ORDER.index(v["sev"]), v["pkg"]))[:100]:
            w(f"|{v['id']}|{v['pkg']}|{v['installed']}|{v['fixed'] or '—'}|{v['sev']}|")
        if len(blocking) > 100:
            w(f"|… {len(blocking) - 100} more in the artifact|||||")
        w(""); w("</details>")
    md = "\n".join(out) + "\n"
    open(env("OUT_MD"), "w").write(md)

    with open(env("GITHUB_OUTPUT"), "a") as f:
        f.write(f"status={status}\n")
        for s in ORDER:
            f.write(f"{s.lower()}-count={counts[s]}\n")
        f.write(f"blocking-count={len(blocking)}\n")
        f.write(f"package-count={len(deps)}\n")
    print(f"{image}@{digest}: {status} — " + ", ".join(f"{s} {counts[s]}" for s in ORDER) + f"; blocking {len(blocking)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
