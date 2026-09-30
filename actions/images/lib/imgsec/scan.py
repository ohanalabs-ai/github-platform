"""Scan every image/platform target of one scan unit.

Security gate: Trivy scans the EXACT platform manifest digest straight from the registry
(``--image-src remote``) — never a third-party SBOM as the only input. All severities are kept
in trivy.json; the pass/fail policy (threshold, ignore-unfixed) is evaluated here so that the
raw results stay complete. The Trivy vulnerability DB is downloaded once per job and its
metadata is recorded next to every result.

Per target directory: result.json · trivy.json · [trivy.sarif] · SBOM file(s) · sbom-meta.json ·
summary.md. result.json is written even on errors (``status: error`` + kind) so the report can
tell policy failures from auth/network/scanner failures.
"""
import json
import os

from . import ImgsecError, SCHEMA_VERSION
from . import sbom as sb
from . import resolve as rs
from . import util

SEVERITIES = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]


def trivy_env(cache_dir):
    return dict(os.environ, TRIVY_NO_PROGRESS="true", TRIVY_CACHE_DIR=cache_dir, TRIVY_DISABLE_VEX_NOTICE="true")


def prepare_db(trivy_opts, cache_dir, trivy="trivy"):
    args = [trivy, "image", "--download-db-only", "--cache-dir", cache_dir, "--quiet"]
    if trivy_opts.get("db-repository"):
        args += ["--db-repository", trivy_opts["db-repository"]]
    rc, _, err = util.run(args, env=trivy_env(cache_dir), timeout=900)
    if rc != 0:
        raise ImgsecError("scanner", f"trivy DB download failed: {util.tail(err, 600)}")
    rc, out, err = util.run([trivy, "version", "--format", "json", "--cache-dir", cache_dir], env=trivy_env(cache_dir), timeout=60)
    if rc != 0:
        raise ImgsecError("scanner", f"trivy version failed: {util.tail(err, 300)}")
    try:
        v = json.loads(out)
    except ValueError:
        raise ImgsecError("scanner", "trivy version returned non-JSON") from None
    return {"name": "trivy", "version": v.get("Version", "unknown"), "vulnerability-db": v.get("VulnerabilityDB") or {},
            "java-db": v.get("JavaDB") or {}, "db-repository": trivy_opts.get("db-repository") or "default"}


def run_trivy(target, trivy_opts, cache_dir, out_file, trivy="trivy"):
    ref = f"{target['repository']}@{target['digest']}"
    args = [trivy, "image", "--image-src", "remote", "--scanners", trivy_opts["scanners"], "--format", "json",
            "--output", out_file, "--severity", ",".join(SEVERITIES), "--timeout", trivy_opts["timeout"],
            "--cache-dir", cache_dir, "--skip-db-update", "--quiet"]
    if trivy_opts.get("java-db-repository"):
        args += ["--java-db-repository", trivy_opts["java-db-repository"]]
    args.append(ref)
    rc, _, err = util.run(args, env=trivy_env(cache_dir), timeout=7200)
    if rc != 0:
        kind = util.classify_registry_error(err)
        raise ImgsecError(kind if kind in ("auth", "network", "not-found") else "scanner", f"trivy failed on {ref}: {util.tail(err, 800)}")
    try:
        report = util.read_json(out_file, "trivy.json")
    except ImgsecError as e:
        raise ImgsecError("scanner", f"trivy produced no readable JSON: {e.message}") from None
    if report.get("ArtifactName") != ref:
        raise ImgsecError("scanner", f"trivy report is for {report.get('ArtifactName')!r}, expected {ref}")
    return report


def evaluate(report, threshold, ignore_unfixed):
    counts = {s: 0 for s in SEVERITIES}
    fixable = {s: 0 for s in SEVERITIES}
    violations = []
    rank = {s: i for i, s in enumerate(SEVERITIES)}
    limit = None if threshold == "NONE" else rank[threshold]
    for res in report.get("Results") or []:
        for v in res.get("Vulnerabilities") or []:
            sev = str(v.get("Severity", "UNKNOWN")).upper()
            sev = sev if sev in rank else "UNKNOWN"
            counts[sev] += 1
            has_fix = bool(v.get("FixedVersion")) or v.get("Status") == "fixed"
            if has_fix:
                fixable[sev] += 1
            if limit is not None and rank[sev] >= limit and (has_fix or not ignore_unfixed):
                violations.append({"id": v.get("VulnerabilityID"), "severity": sev, "package": v.get("PkgName"),
                                   "installed": v.get("InstalledVersion"), "fixed": v.get("FixedVersion") or "",
                                   "target": res.get("Target")})
    violations.sort(key=lambda x: (-rank[x["severity"]], str(x["id"]), str(x["package"])))
    return counts, fixable, violations


def to_sarif(trivy_json, sarif_path, category, trivy="trivy"):
    rc, _, err = util.run([trivy, "convert", "--format", "sarif", "--output", sarif_path, trivy_json], timeout=600)
    if rc != 0:
        raise ImgsecError("scanner", f"trivy convert failed: {util.tail(err, 300)}")
    doc = util.read_json(sarif_path, "sarif")
    for run in doc.get("runs") or []:
        run["automationDetails"] = {"id": f"{category}/"}
    util.write_json(sarif_path, doc)


def scan_target(target, image, options, cache_dir, scanner_meta, tdir, *, registry=None, verifier=None, tools=None):
    tools = tools or {}
    s = image["settings"]
    result = {"schema": SCHEMA_VERSION, "id": target["id"], "image-id": image["id"], "ref": image["ref"],
              "platform": target["platform"], "digest": target["digest"], "index-digest": target.get("index-digest"),
              "scanned-reference": f"{target['repository']}@{target['digest']}", "settings": s,
              "scanner": scanner_meta, "status": "error", "errors": [], "policy-problems": [], "files": []}
    os.makedirs(tdir, exist_ok=True)
    trivy_file = os.path.join(tdir, "trivy.json")
    try:
        report = run_trivy(target, options["trivy"], cache_dir, trivy_file, trivy=tools.get("trivy", "trivy"))
        counts, fixable, violations = evaluate(report, s["severity-threshold"], s["ignore-unfixed"])
        result.update({"counts": counts, "fixable": fixable, "violation-count": len(violations), "violations": violations[:50]})
        result["files"].append("trivy.json")
        if violations:
            result["policy-problems"].append(f"{len(violations)} vulnerabilit{'y' if len(violations) == 1 else 'ies'} at or above "
                                             f"{s['severity-threshold']}" + (" (fixable only)" if s["ignore-unfixed"] else ""))
        if options.get("upload-sarif"):
            to_sarif(trivy_file, os.path.join(tdir, "trivy.sarif"), f"imgsec/{target['id']}", trivy=tools.get("trivy", "trivy"))
            result["files"].append("trivy.sarif")
    except ImgsecError as e:
        result["errors"].append(e.as_dict())
    signers = options["attestation-signers"]
    registry = registry or rs.Registry(tools.get("oras", "oras"))
    verifier = verifier or sb.Verifier(tools.get("gh", "gh"), tools.get("cosign", "cosign"))
    try:
        meta, problem = sb.sbom_for_target(target, s["sbom-policy"], signers, registry, verifier, tdir, syft=tools.get("syft", "syft"))
        util.write_json(os.path.join(tdir, "sbom-meta.json"), meta)
        result["sbom"] = {"policy": meta["policy"], "primary": meta.get("primary"),
                          "files": [{k: f[k] for k in ("file", "source", "verified", "scope", "subject")} for f in meta["files"]]}
        result["files"] += [f["file"] for f in meta["files"]] + ["sbom-meta.json"]
        if problem:
            result["policy-problems"].append(problem)
    except ImgsecError as e:
        result["errors"].append(e.as_dict())
        result["sbom"] = {"policy": s["sbom-policy"], "error": e.as_dict()}
    try:
        prov, problem = sb.provenance_for_target(target, options["provenance"], signers, registry, verifier, image.get("expected-source"))
        result["provenance"] = prov
        if problem:
            result["policy-problems"].append(problem)
    except ImgsecError as e:
        result["errors"].append(e.as_dict())
        result["provenance"] = {"status": "error", "error": e.as_dict()}
    if result["errors"]:
        result["status"] = "error"
        result["error"] = result["errors"][0]
    elif result["policy-problems"]:
        result["status"] = "policy-fail"
    else:
        result["status"] = "pass"
    util.write_json(os.path.join(tdir, "result.json"), result)
    with open(os.path.join(tdir, "summary.md"), "w", encoding="utf-8") as f:
        f.write(summary_line(result) + "\n")
    return result


def summary_line(r):
    icon = {"pass": "✅", "policy-fail": "❌", "error": "🛑"}.get(r["status"], "❔")
    c = r.get("counts") or {}
    counts = " ".join(f"{k[0]}:{c.get(k, 0)}" for k in reversed(SEVERITIES)) if c else "—"
    extra = r["error"]["kind"] + ": " + r["error"]["message"][:160] if r.get("error") else "; ".join(r.get("policy-problems", []))[:200]
    sbom = (r.get("sbom") or {}).get("primary") or "—"
    return f"| {icon} {r['status']} | `{r['ref']}` | {r['platform']} | `{r['digest'][:19]}…` | {counts} | {sbom} | {extra.replace('|', '/')} |"


def main(args):
    plan = util.read_json(args.plan, "plan.json")
    sp = util.read_json(args.scan_plan, "scan-plan.json")
    unit = next((u for u in sp.get("units", []) if u["unit"] == args.unit), None)
    if unit is None or sp.get("plan-fingerprint") != plan.get("fingerprint"):
        raise ImgsecError("internal", f"unit {args.unit} not in the scan plan (or stale plan)")
    image = next(i for i in plan["images"] if i["id"] == unit["image-id"])
    os.makedirs(args.out, exist_ok=True)
    auth_err = util.read_json(args.auth_error) if args.auth_error and os.path.isfile(args.auth_error) else None
    scanner_meta, db_err = {}, None
    if not auth_err:
        cache = os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "imgsec-trivy-cache")
        try:
            scanner_meta = prepare_db(plan["options"]["trivy"], cache)
        except ImgsecError as e:
            db_err = e.as_dict()
    rc = 0
    lines = []
    for t in unit["targets"]:
        tdir = os.path.join(args.out, t["id"])
        if auth_err or db_err:
            os.makedirs(tdir, exist_ok=True)
            err = auth_err or db_err
            r = {"schema": SCHEMA_VERSION, "id": t["id"], "image-id": image["id"], "ref": image["ref"], "platform": t["platform"],
                 "digest": t["digest"], "index-digest": t.get("index-digest"), "status": "error", "error": err, "errors": [err],
                 "scanner": scanner_meta, "files": []}
            util.write_json(os.path.join(tdir, "result.json"), r)
        else:
            r = scan_target(t, image, plan["options"], cache, scanner_meta, tdir)
        r["plan-fingerprint"] = plan["fingerprint"]
        util.write_json(os.path.join(tdir, "result.json"), r)
        lines.append(summary_line(r))
        if r["status"] == "error":
            util.annotate("error", f"{image['ref']} {t['platform']}: {r['error']['kind']}: {r['error']['message'][:300]}")
            rc = 1
        elif r["status"] == "policy-fail":
            util.annotate("error", f"{image['ref']} {t['platform']}: " + "; ".join(r["policy-problems"])[:300])
            rc = rc or 2
    util.append_summary("| status | image | platform | digest | C H M L U | SBOM | detail |\n|---|---|---|---|---|---|---|\n" + "\n".join(lines) + "\n")
    util.gh_output("status", {0: "pass", 1: "error", 2: "policy-fail"}[rc])
    return 0
