"""Aggregate report: runs even when scans fail; missing results fail closed.

Inputs: plan.json (required), scan-plan.json (may be absent if that job failed), every
resolved.json and result.json that was uploaded, and ``toJSON(needs)`` for job results.
Every image in the plan and every target in the scan plan is EXPECTED; an absent or stale
(other plan fingerprint) result is an error, so a cancelled/crashed job can never read as pass.

Outputs: report.md · report.json (overall status + counts) · inventory.json (image →
digests → every deployment occurrence → scan/SBOM/provenance) · digest-lock.json (ref →
repo@digest, non-secret) · kustomize-images.yaml (only when the name→digest map is unambiguous).
Overall status: error > policy-fail > pass. report-only downgrades ONLY policy-fail.
"""
import json
import os

from . import ImgsecError, SCHEMA_VERSION
from . import imageref, scanplan, util, yamlio

ORDER = {"pass": 0, "policy-fail": 1, "error": 2}


def _worst(a, b):
    return a if ORDER[a] >= ORDER[b] else b


def build(plan, sp, resolved, results, needs):
    fp = plan.get("fingerprint")
    rep = {"schema": SCHEMA_VERSION, "plan-fingerprint": fp, "status": "pass", "problems": [], "jobs": {},
           "counts": {"images": 0, "targets": 0, "pass": 0, "policy-fail": 0, "error": 0, "missing": 0}}
    for job, v in (needs or {}).items():
        rep["jobs"][job] = (v or {}).get("result", "unknown")
    inventory = {"schema": SCHEMA_VERSION, "plan-fingerprint": fp, "source": plan.get("source"),
                 "sources": [{k: s.get(k) for k in ("id", "type", "tools", "render-fingerprint", "documents", "occurrences")}
                             | {"settings": {k: v for k, v in (s.get("settings") or {}).items() if k not in ("set", "set-string")}}
                             for s in plan.get("sources", [])],
                 "warnings": plan.get("warnings", []), "unsupported": plan.get("unsupported", []), "images": []}
    lock = {"schema": SCHEMA_VERSION, "plan-fingerprint": fp, "entries": []}
    if plan.get("status") != "ok":
        err = plan.get("error") or {"kind": "internal", "message": "plan missing"}
        rep["status"] = "error"
        rep["problems"].append(f"plan failed ({err['kind']}): {err['message']}")
        return rep, inventory, lock
    rep["counts"]["images"] = len(plan["images"])
    if not plan["images"]:
        rep["problems"].append("no images (allow-empty) — nothing was scanned")
        return rep, inventory, lock
    units_by_image = {}
    if not sp or sp.get("status") != "ok" or sp.get("plan-fingerprint") != fp:
        rep["status"] = "error"
        rep["problems"].append("scan plan missing, failed or stale — no image results can be trusted")
        sp = {"units": [], "resolve-errors": []}
    for u in sp["units"]:
        units_by_image.setdefault(u["image-id"], []).extend(u["targets"])
    resolve_err = {e["id"]: e["error"] for e in sp.get("resolve-errors", [])}
    for img in plan["images"]:
        rdocs = [d for d in resolved.get(img["id"], []) if d.get("plan-fingerprint") == fp]
        r = rdocs[0] if len(rdocs) == 1 else None
        entry = {"id": img["id"], "ref": img["ref"], "labels": img.get("labels", {}), "origins": img.get("origins", []),
                 "settings": img["settings"], "expected-source": img.get("expected-source"),
                 "digest": (r or {}).get("digest"), "index-digest": (r or {}).get("index-digest"),
                 "available-platforms": (r or {}).get("available-platforms"), "occurrences": img.get("occurrences", []),
                 "targets": [], "status": "pass"}
        if img["id"] in resolve_err or r is None or r.get("status") != "ok":
            err = resolve_err.get(img["id"]) or (r or {}).get("error") or {"kind": "internal", "message": "resolve result missing"}
            entry["status"] = "error"
            entry["error"] = err
            rep["problems"].append(f"{img['ref']}: not scanned — {err['kind']}: {err['message'][:300]}")
        expected = units_by_image.get(img["id"], [])
        if entry["status"] == "pass" and not expected:
            entry["status"] = "error"
            entry["error"] = {"kind": "internal", "message": "no scan targets planned"}
            rep["problems"].append(f"{img['ref']}: no scan targets planned")
        for t in expected:
            rep["counts"]["targets"] += 1
            res = results.get(t["id"])
            if res is None or res.get("plan-fingerprint") != fp or res.get("digest") != t["digest"]:
                rep["counts"]["missing"] += 1
                tr = {"id": t["id"], "platform": t["platform"], "digest": t["digest"], "status": "error",
                      "error": {"kind": "missing-result", "message": "no (current) result — scan job failed, was cancelled or uploaded nothing"}}
                rep["problems"].append(f"{img['ref']} {t['platform']}: result missing")
            else:
                tr = {k: res.get(k) for k in ("id", "platform", "digest", "status", "error", "counts", "fixable", "violation-count",
                                             "violations", "policy-problems", "sbom", "provenance", "scanner", "files")}
                if res["status"] == "policy-fail":
                    rep["problems"].append(f"{img['ref']} {t['platform']}: " + "; ".join(res.get("policy-problems") or []))
                elif res["status"] == "error":
                    e = res.get("error") or {"kind": "internal", "message": "?"}
                    rep["problems"].append(f"{img['ref']} {t['platform']}: {e['kind']}: {e['message'][:300]}")
            rep["counts"][tr["status"]] = rep["counts"].get(tr["status"], 0) + 1
            entry["status"] = _worst(entry["status"], tr["status"] if tr["status"] in ORDER else "error")
            entry["targets"].append(tr)
        rep["status"] = _worst(rep["status"], entry["status"])
        inventory["images"].append(entry)
        if entry["digest"]:
            repo = imageref.parse(img["ref"]).repository
            lock["entries"].append({"ref": img["ref"], "pinned": f"{repo}@{entry['digest']}", "digest": entry["digest"],
                                    "index": bool(entry["index-digest"]), "status": entry["status"],
                                    "platforms": {t["platform"]: t["digest"] for t in entry["targets"]},
                                    "declared-as": sorted({o["image"] for o in entry["occurrences"]})})
    if any(v in ("failure", "cancelled") for v in rep["jobs"].values()) and rep["status"] == "pass":
        rep["status"] = "error"
        rep["problems"].append("a job failed or was cancelled: " + ", ".join(f"{k}={v}" for k, v in rep["jobs"].items()))
    return rep, inventory, lock


def kustomize_images(lock):
    by_name = {}
    for e in lock["entries"]:
        for declared in e["declared-as"]:
            name = declared.split("@", 1)[0]
            last = name.rsplit("/", 1)[-1]
            if ":" in last:
                name = name[: len(name) - len(last)] + last.split(":", 1)[0]
            by_name.setdefault(name, set()).add((imageref.parse(e["ref"]).repository, e["digest"]))
    if not by_name or any(len(v) != 1 for v in by_name.values()):
        return None
    return {"images": [{"name": n, "newName": list(v)[0][0], "digest": list(v)[0][1]} for n, v in sorted(by_name.items())]}


def markdown(rep, inventory, report_only):
    icon = {"pass": "✅", "policy-fail": "❌", "error": "🛑"}[rep["status"]]
    status = rep["status"] + (" (report-only: not failing)" if report_only and rep["status"] == "policy-fail" else "")
    c = rep["counts"]
    out = [f"## {icon} Container image scan — {status}", "",
           f"{c['images']} image(s) · {c['targets']} image/platform target(s) · ✅ {c['pass']} · ❌ {c['policy-fail']} · "
           f"🛑 {c['error']} (of which {c['missing']} missing result(s))", ""]
    if rep["problems"]:
        out += ["### Problems", ""] + [f"- {p}" for p in rep["problems"][:100]] + [""]
    out += ["### Images", "", "| status | image | platform | scanned digest | C/H/M/L/U | SBOM | provenance |", "|---|---|---|---|---|---|---|"]
    for i in inventory["images"]:
        if not i["targets"]:
            out.append(f"| 🛑 {i['status']} | `{i['ref']}` | — | — | — | — | — |")
        for t in i["targets"]:
            cn = t.get("counts") or {}
            counts = "/".join(str(cn.get(k, 0)) for k in ("CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN")) if cn else "—"
            sb = t.get("sbom") or {}
            sbd = ", ".join(f"{f['source']}{' ✔verified' if f.get('verified') else ''} ({f['scope']})" for f in sb.get("files", [])) or \
                ((sb.get("error") or {}).get("kind") or "—")
            pv = (t.get("provenance") or {}).get("status", "—")
            out.append(f"| {t['status']} | `{i['ref']}` | {t['platform']} | `{t['digest']}` | {counts} | {sbd} | {pv} |")
    out += ["", "### Where each image is declared", "", "| image | resource | container | source |", "|---|---|---|---|"]
    for i in inventory["images"]:
        for o in i["occurrences"][:200]:
            r = o["resource"]
            ns = f"{r['namespace']}/" if r.get("namespace") else ""
            hook = f" (hook: {r['helm-hook']})" if r.get("helm-hook") else ""
            out.append(f"| `{o['image']}` | {r['kind']} {ns}{r['name']}{hook} | {o['container']['type']} `{o['container']['name']}` | "
                       f"{o['source']} @ {(o.get('source-revision') or o.get('source-artifact') or '')[:12]} |")
        if not i["occurrences"]:
            out.append(f"| `{i['ref']}` | (images input) | — | — |")
    if inventory["warnings"]:
        out += ["", "### Warnings", ""] + [f"- {w}" for w in inventory["warnings"][:50]]
    out += ["", "<sub>Vulnerability scanning covers the exact platform digests above with the recorded Trivy DB. It does not by itself "
                "prove who built an image or from which source (see SBOM/provenance columns), and only images declared in the rendered "
                "configuration were discovered — admission-injected sidecars and operator-created pods are not included.</sub>"]
    return "\n".join(out) + "\n"


def main(args):
    out = args.out
    os.makedirs(out, exist_ok=True)
    try:
        plan = util.read_json(args.plan, "plan.json")
    except ImgsecError:
        plan = {"status": "error", "error": {"kind": "internal", "message": "plan artifact missing"}, "images": []}
    sp = None
    if args.scan_plan and os.path.isfile(args.scan_plan):
        sp = util.read_json(args.scan_plan, "scan-plan.json")
    resolved = scanplan.collect(args.resolved_dir, "resolved.json") if args.resolved_dir else {}
    results = {}
    if args.results_dir:
        for rid, docs in scanplan.collect(args.results_dir, "result.json").items():
            results[rid] = docs[0] if len(docs) == 1 else None
            if len(docs) > 1:
                results[rid] = {"plan-fingerprint": None}
    needs = {}
    try:
        needs = json.loads(os.environ.get("IMGSEC_NEEDS") or "{}")
    except ValueError:
        pass
    rep, inventory, lock = build(plan, sp, resolved, results, needs)
    report_only = bool((plan.get("options") or {}).get("report-only"))
    rep["report-only"] = report_only
    util.write_json(os.path.join(out, "report.json"), rep)
    util.write_json(os.path.join(out, "inventory.json"), inventory)
    util.write_json(os.path.join(out, "digest-lock.json"), lock)
    k = kustomize_images(lock) if lock["entries"] and rep["status"] == "pass" else None
    if k:
        with open(os.path.join(out, "kustomize-images.yaml"), "w", encoding="utf-8") as f:
            f.write(yamlio.dump_all([k]))
    md = markdown(rep, inventory, report_only)
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8") as f:
        f.write(md)
    util.append_summary(md if len(md) < 900000 else md[:900000] + "\n… (truncated; see report.md artifact)\n")
    util.gh_output("status", rep["status"])
    util.gh_output("fingerprint", rep["plan-fingerprint"] or "")
    failing = rep["status"] == "error" or (rep["status"] == "policy-fail" and not report_only)
    util.gh_output("failed", str(failing).lower())
    return 0
