"""Checked-in build maps for reference builds (e.g. WSO2 Online Boutique).

A build map is data, never inferred: each service names its image, Docker context and
Dockerfile explicitly. ``validate`` cross-checks it against the checked-out source — the
revision must equal the pinned one, every service must match an artifact in skaffold.yaml
(same image name, context and Dockerfile, in the declared skaffold config), every skaffold
artifact must be in the map, and each Dockerfile must be a regular file inside the context.
Any mismatch fails the build instead of silently building or scanning something else.
"""
import json
import os
import re

from . import ImgsecError, SCHEMA_VERSION
from . import imageref, util, yamlio

_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
_TAG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def load(path):
    m = util.read_json(path, "build map")
    if not isinstance(m, dict) or m.get("schema") != 1:
        raise ImgsecError("input", "build map: schema must be 1")
    src = m.get("source") or {}
    if not _REPO.match(src.get("repository", "")) or not re.match(r"^[0-9a-f]{40}$", src.get("revision", "")):
        raise ImgsecError("input", "build map: source.repository owner/repo and a 40-hex source.revision are required")
    services = m.get("services")
    if not isinstance(services, list) or not services:
        raise ImgsecError("input", "build map: services[] required")
    seen = set()
    for i, s in enumerate(services):
        what = f"build map services[{i}]"
        if not isinstance(s, dict) or set(s) - {"name", "image", "context", "dockerfile", "skaffold-config", "optional", "extra-manifest"}:
            raise ImgsecError("input", f"{what}: unknown/missing keys")
        if not _NAME.match(str(s.get("name", ""))) or s.get("image") != s["name"]:
            raise ImgsecError("input", f"{what}: name must be a lowercase service name equal to its skaffold image name")
        if s["name"] in seen:
            raise ImgsecError("input", f"{what}: duplicate service {s['name']}")
        seen.add(s["name"])
        for k in ("context", "dockerfile", "skaffold-config"):
            if not isinstance(s.get(k), str) or not s[k]:
                raise ImgsecError("input", f"{what}.{k} required")
        s.setdefault("optional", False)
        if not isinstance(s["optional"], bool):
            raise ImgsecError("input", f"{what}.optional must be boolean")
    return m


def _skaffold_artifacts(root, rel):
    path = util.confine(root, rel, "skaffold file", must_exist=True)
    with open(path, "rb") as f:
        docs = yamlio.load_all(f.read(), rel)
    arts = {}
    for d in docs:
        if not isinstance(d, dict) or d.get("kind") != "Config":
            continue
        cfg = ((d.get("metadata") or {}).get("name")) or ""
        for a in ((d.get("build") or {}).get("artifacts") or []):
            img = a.get("image")
            if img in arts:
                raise ImgsecError("input", f"skaffold: image {img} declared twice")
            arts[img] = {"config": cfg, "context": a.get("context", "."),
                         "dockerfile": ((a.get("docker") or {}).get("dockerfile")) or "Dockerfile"}
    return arts


def validate(m, root, revision):
    if revision != m["source"]["revision"]:
        raise ImgsecError("input", f"checked-out revision {revision} ≠ build map revision {m['source']['revision']}")
    arts = _skaffold_artifacts(root, m.get("skaffold", "skaffold.yaml"))
    names = {s["name"] for s in m["services"]}
    missing = sorted(set(arts) - names)
    if missing:
        raise ImgsecError("input", f"skaffold declares artifacts not in the build map: {missing}")
    for s in m["services"]:
        a = arts.get(s["image"])
        if a is None:
            raise ImgsecError("input", f"{s['name']}: not a skaffold artifact")
        if (a["config"], os.path.normpath(a["context"]), a["dockerfile"]) != (s["skaffold-config"], os.path.normpath(s["context"]), s["dockerfile"]):
            raise ImgsecError("input", f"{s['name']}: build map {s['skaffold-config']}:{s['context']}/{s['dockerfile']} ≠ skaffold "
                                       f"{a['config']}:{a['context']}/{a['dockerfile']}")
        ctx = util.confine(root, s["context"], f"{s['name']} context", must_exist=True)
        if not os.path.isdir(ctx):
            raise ImgsecError("input", f"{s['name']}: context {s['context']} is not a directory")
        df = util.confine(ctx, s["dockerfile"], f"{s['name']} Dockerfile", must_exist=True)
        if not os.path.isfile(df) or os.path.islink(df):
            raise ImgsecError("input", f"{s['name']}: Dockerfile {s['context']}/{s['dockerfile']} is not a regular file")
        if s.get("extra-manifest"):
            util.confine(root, s["extra-manifest"], f"{s['name']} extra-manifest", must_exist=True)
    return True


def selected(m, include_optional):
    return [s for s in m["services"] if include_optional or not s["optional"]]


def destination(registry, namespace):
    ref = imageref.parse(f"{registry}/{namespace}/probe:tag")
    if ref.path.count("/") < 1 or ref.domain != imageref.normalize_host(registry):
        raise ImgsecError("input", "registry must be a host[:port] and namespace a repository path")
    return f"{ref.domain}/{ref.path.rsplit('/', 1)[0]}"


def record(service, image, tag, digest, out):
    if not imageref.is_digest(digest):
        raise ImgsecError("input", f"{service}: build produced no sha256 digest ({digest!r})")
    if not _TAG.match(tag):
        raise ImgsecError("input", f"invalid tag {tag!r}")
    ref = imageref.parse(f"{image}:{tag}")
    util.write_json(out, {"schema": 1, "service": service, "image": ref.repository, "tag": tag, "digest": digest})


def assemble(m, records_dir, registry, namespace, tag, include_optional, run_url=""):
    dest = destination(registry, namespace)
    recs = {}
    for dirpath, _, files in os.walk(records_dir):
        for f in files:
            if f.endswith(".json") and not os.path.islink(os.path.join(dirpath, f)):
                r = util.read_json(os.path.join(dirpath, f), "build record")
                if r.get("service") in recs:
                    raise ImgsecError("input", f"duplicate build record for {r.get('service')}")
                recs[r.get("service")] = r
    services, mapping, expect, forbid, labels = [], [], [], [], []
    want = selected(m, include_optional)
    extra = sorted(set(recs) - {s["name"] for s in want})
    if extra:
        raise ImgsecError("input", f"build records for services not selected in the build map: {extra}")
    for s in want:
        r = recs.get(s["name"])
        if r is None:
            raise ImgsecError("input", f"{s['name']}: no build record (build failed or was skipped)")
        image = f"{dest}/{s['image']}"
        if r["image"] != imageref.parse(image + ":x").repository or r["tag"] != tag or not imageref.is_digest(r["digest"]):
            raise ImgsecError("input", f"{s['name']}: build record {r['image']}:{r['tag']}@{r['digest']} does not match {image}:{tag}")
        pinned = f"{image}@{r['digest']}"
        services.append(dict(s, **{"image-repository": image, "tagged": f"{image}:{tag}", "digest": r["digest"], "pinned": pinned}))
        mapping.append({"match": f"{image}:{tag}", "pinned": pinned})
        mapping.append({"match": s["image"], "pinned": pinned})
        expect.append(pinned)
        forbid += [s["image"], f"{image}:{tag}"]
        labels.append({"ref": pinned, "labels": {
            "service": s["name"], "source-repository": m["source"]["repository"], "source-revision": m["source"]["revision"],
            "context": s["context"], "dockerfile": s["dockerfile"], "build-tag": f"{image}:{tag}", "build-digest": r["digest"],
            "build-run": run_url}})
    builds = {"schema": SCHEMA_VERSION, "source": m["source"], "destination": dest, "tag": tag,
              "include-optional": include_optional, "services": services}
    return builds, {"schema": 1, "images": mapping}, expect, forbid, labels


def kustomize_overlay(m, builds, root, out_rel):
    """Overlay (inside the source root) using kustomize's own images transformer: exact
    short image names → built digests. Selected services' extra manifests (e.g. the
    loadgenerator that skaffold deploys from a separate config) are copied in, because the
    root-only load restrictor forbids loading files from outside the overlay."""
    base = (m.get("kustomize") or {}).get("base")
    if not base:
        raise ImgsecError("input", "build map has no kustomize.base")
    base_dir = util.confine(root, base, "kustomize base", must_exist=True)
    out_dir = util.confine(root, out_rel, "overlay directory", must_exist=False)
    os.makedirs(out_dir, exist_ok=True)
    files = []
    chosen = {s["name"] for s in builds["services"]}
    for s in m["services"]:
        if s["name"] in chosen and s.get("extra-manifest"):
            src = util.confine(root, s["extra-manifest"], f"{s['name']} extra manifest", must_exist=True)
            name = os.path.basename(src)
            with open(src, "rb") as f_in, open(os.path.join(out_dir, name), "wb") as f_out:
                f_out.write(f_in.read())
            files.append(name)
    images = [{"name": s["image"], "newName": s["image-repository"], "digest": s["digest"]} for s in builds["services"]]
    doc = {"apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization",
           "resources": [os.path.relpath(base_dir, out_dir)] + files, "images": images}
    with open(os.path.join(out_dir, "kustomization.yaml"), "w", encoding="utf-8") as f:
        f.write(yamlio.dump_all([doc]))


def main(args):
    m = load(args.map)
    if args.action == "validate":
        validate(m, os.path.realpath(args.root), args.revision)
        sel = selected(m, args.include_optional)
        util.gh_output("matrix", util.canonical_json({"include": [
            {"service": s["name"], "context": s["context"], "dockerfile": s["dockerfile"]} for s in sel]}))
        util.gh_output("services", util.canonical_json([s["name"] for s in sel]))
        util.append_summary(f"🗺️ build map validated against skaffold.yaml @ {args.revision}: {len(sel)} service(s)\n")
        return 0
    if args.action == "record":
        svc = next((s for s in m["services"] if s["name"] == args.service), None)
        if svc is None:
            raise ImgsecError("input", f"{args.service} not in the build map")
        record(svc["name"], f"{destination(args.registry, args.namespace)}/{svc['image']}", args.tag, args.digest, args.out)
        return 0
    if args.action == "assemble":
        builds, mapping, expect, forbid, labels = assemble(m, args.records_dir, args.registry, args.namespace, args.tag,
                                                           args.include_optional, os.environ.get("IMGSEC_RUN_URL", ""))
        os.makedirs(args.out, exist_ok=True)
        util.write_json(os.path.join(args.out, "builds.json"), builds)
        util.write_json(os.path.join(args.out, "mapping.json"), mapping)
        util.write_json(os.path.join(args.out, "expect.json"), expect)
        util.write_json(os.path.join(args.out, "forbid.json"), forbid)
        util.write_json(os.path.join(args.out, "images-annotate.json"),
                        {"version": 1, "mode": "annotate", "images": labels})
        if args.kustomize_overlay:
            kustomize_overlay(m, builds, os.path.realpath(args.root), args.kustomize_overlay)
        util.gh_output("expect", json.dumps(expect))
        util.gh_output("forbid", json.dumps(forbid))
        util.append_summary("| service | source | pinned build |\n|---|---|---|\n" + "\n".join(
            f"| {s['name']} | `{m['source']['repository']}@{m['source']['revision'][:12]}:{s['context']}/{s['dockerfile']}` | `{s['pinned']}` |"
            for s in builds["services"]) + "\n")
        return 0
    raise ImgsecError("input", f"unknown buildmap action {args.action}")
