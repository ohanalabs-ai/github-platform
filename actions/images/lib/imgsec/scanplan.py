"""Build the bounded scan matrix from the plan + every per-image resolve result.

One *unit* (matrix job) per image/platform target while that fits in options.max-scan-jobs;
otherwise one unit per image (all its platforms in one job). A unit never mixes registry
hosts, so each job only fetches credentials for exactly one host. Images whose resolve result
is missing, stale (other plan fingerprint) or errored get no unit and are carried as errors,
so the report fails closed instead of silently dropping them.
"""
import glob
import os

from . import ImgsecError, SCHEMA_VERSION
from . import imageref, util


def collect(directory, name):
    found = {}
    for path in sorted(glob.glob(os.path.join(directory, "**", name), recursive=True)):
        if os.path.islink(path):
            continue
        try:
            doc = util.read_json(path, name)
        except ImgsecError:
            continue
        if isinstance(doc, dict) and isinstance(doc.get("id"), str):
            found.setdefault(doc["id"], []).append(doc)
    return found


def build(plan, resolved_by_id):
    units, problems = [], []
    max_jobs = plan["options"]["max-scan-jobs"]
    ok = []
    for img in plan["images"]:
        docs = resolved_by_id.get(img["id"], [])
        if len(docs) != 1:
            problems.append({"id": img["id"], "ref": img["ref"], "error": {
                "kind": "internal", "message": "resolve result missing (job cancelled/failed before upload?)" if not docs
                else "duplicate resolve results"}})
            continue
        r = docs[0]
        if r.get("plan-fingerprint") != plan["fingerprint"]:
            problems.append({"id": img["id"], "ref": img["ref"], "error": {"kind": "internal", "message": "stale resolve result (plan fingerprint mismatch)"}})
            continue
        if r.get("status") != "ok":
            problems.append({"id": img["id"], "ref": img["ref"], "error": r.get("error") or {"kind": "internal", "message": "resolve failed"}})
            continue
        if not r.get("targets"):
            problems.append({"id": img["id"], "ref": img["ref"], "error": {"kind": "platform", "message": "no platform selected"}})
            continue
        ok.append((img, r))
    total = sum(len(r["targets"]) for _, r in ok)
    per_target = total <= max_jobs
    if not per_target and len(ok) > max_jobs:
        raise ImgsecError("input", f"{len(ok)} images need at least {len(ok)} scan jobs but options.max-scan-jobs={max_jobs}")
    for img, r in ok:
        targets = []
        for t in r["targets"]:
            targets.append({
                "id": f"{img['id']}-{imageref.platform_slug(t['platform'])}", "image-id": img["id"], "ref": img["ref"],
                "repository": r["repository"], "platform": t["platform"], "digest": t["digest"],
                "index-digest": r.get("index-digest"), "manifest-digest": r["digest"],
            })
        groups = [[t] for t in targets] if per_target else [targets]
        for g in groups:
            units.append({"unit": g[0]["id"] if per_target else img["id"], "image-id": img["id"], "host": img["host"], "targets": g})
    return {"schema": SCHEMA_VERSION, "plan-fingerprint": plan["fingerprint"], "status": "ok",
            "mode": "per-target" if per_target else "per-image", "units": units, "resolve-errors": problems}


def matrix(sp):
    return {"include": [{"unit": u["unit"], "image-id": u["image-id"], "host": u["host"]} for u in sp["units"]]}


def main(args):
    plan = util.read_json(args.plan, "plan.json")
    out = os.path.join(args.out, "scan-plan.json")
    try:
        if plan.get("status") != "ok":
            raise ImgsecError("internal", "plan did not succeed")
        sp = build(plan, collect(args.resolved_dir, "resolved.json"))
    except ImgsecError as e:
        util.write_json(out, {"schema": SCHEMA_VERSION, "plan-fingerprint": plan.get("fingerprint"), "status": "error",
                              "error": e.as_dict(), "units": [], "resolve-errors": []})
        util.annotate("error", f"scan-plan ({e.kind}): {e.message}")
        util.gh_output("count", 0)
        util.gh_output("matrix", util.canonical_json({"include": []}))
        return 1
    util.write_json(out, sp)
    for p in sp["resolve-errors"]:
        util.annotate("error", f"{p['ref']}: not scanned — {p['error']['kind']}: {p['error']['message'][:300]}")
    util.gh_output("count", len(sp["units"]))
    util.gh_output("matrix", util.canonical_json(matrix(sp)))
    util.append_summary(f"### 🧮 scan plan — {len(sp['units'])} job(s), {sum(len(u['targets']) for u in sp['units'])} "
                        f"image/platform target(s), {len(sp['resolve-errors'])} unresolved image(s)\n")
    return 0
