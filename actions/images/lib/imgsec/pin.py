"""Digest pinning of RENDERED manifests — structured, never text substitution.

Only the image fields that discovery understands (built-in PodSpec paths + configured
adapters) are rewritten. A mapping entry matches an occurrence when the canonical references
are equal (so the short Skaffold name ``emailservice`` matches ``docker.io/library/emailservice:latest``
only if the caller explicitly maps it). Checks:

  --require-digest   every image field in the output must carry a digest
  --expect REF       each REF (repo@sha256:…) must appear in the output at least once
  --forbid REF       no occurrence may still reference REF (e.g. unsubstituted short names,
                     chart-default registries) — a build-map mismatch fails here
Secrets: the output is the full rendered set; it refuses to write when it contains
Secret objects unless --allow-secrets (then treat the file as sensitive).
"""
import json
import os
import re

from . import ImgsecError
from . import discover as disc
from . import imageref, util, yamlio

_SEG = re.compile(r"^([A-Za-z0-9_-]+)(?:\[([0-9]+)\])?$")
_ITEMS = re.compile(r" items\[([0-9]+)\]")


def load_mapping(path):
    doc = util.read_json(path, "mapping")
    entries = []
    if isinstance(doc, dict) and "entries" in doc:  # digest-lock.json from the report
        for e in doc["entries"]:
            if e.get("pinned"):
                entries.append((e["ref"], e["pinned"]))
    elif isinstance(doc, dict) and "images" in doc:
        for e in doc["images"]:
            entries.append((e["match"], e["pinned"]))
    else:
        raise ImgsecError("input", "mapping must be a digest-lock (entries[]) or {images:[{match,pinned}]}")
    mapping = {}
    for match, pinned in entries:
        m = imageref.parse(match).canonical
        p = imageref.parse(pinned)
        if not p.digest:
            raise ImgsecError("input", f"mapping for {match}: {pinned} has no digest")
        if m in mapping and mapping[m] != p.at(p.digest):
            raise ImgsecError("input", f"mapping: {match} maps to two different digests")
        mapping[m] = p.at(p.digest)
    return mapping


def _set(obj, path, value):
    segs = path.split(".")
    for i, seg in enumerate(segs):
        m = _SEG.match(seg)
        if not m:
            raise ImgsecError("internal", f"bad path {path}")
        key, idx = m.group(1), m.group(2)
        last = i == len(segs) - 1
        if last and idx is None:
            obj[key] = value
            return
        obj = obj[key]
        if idx is not None:
            if last:
                obj[int(idx)] = value
                return
            obj = obj[int(idx)]


def pin(docs, mapping, *, adapters=None, require_digest=False, expect=(), forbid=(), allow_secrets=False):
    """docs: list of (origin, doc). Returns (docs, report)."""
    adapters = disc.validate_adapters(adapters or [])
    forbid_c = set()
    for f in forbid:
        forbid_c.add(f)
        try:
            forbid_c.add(imageref.parse(f).canonical)
        except ImgsecError:
            pass
    replaced, problems, final = [], [], []
    for n, (origin, doc) in enumerate(docs):
        if isinstance(doc, dict) and doc.get("kind") == "Secret" and not allow_secrets:
            raise ImgsecError("input", f"{origin}: rendered output contains a Secret; refusing to write it (use --allow-secrets and protect the file)")
        occ, _, errs = disc.discover([(f"doc{n}", doc)], source_id="pin", adapters=adapters)
        problems += errs
        for o in occ:
            target = doc
            for i in _ITEMS.findall(o["resource"]["origin"]):
                target = target["items"][int(i)]
            if o["error"]:
                problems.append(f"{origin}: {o['image']!r}: {o['error']}")
                continue
            new = mapping.get(o["ref"])
            value = o["image"]
            if new:
                _set(target, o["container"]["path"], new)
                replaced.append({"from": o["image"], "to": new, "resource": disc.describe(o["resource"]), "path": o["container"]["path"]})
                value = new
            ref = imageref.parse(value)
            final.append({"image": value, "ref": ref.canonical, "resource": disc.describe(o["resource"]), "path": o["container"]["path"]})
            if require_digest and not ref.digest:
                problems.append(f"{disc.describe(o['resource'])} {o['container']['path']}: {value} is not digest-pinned")
            if value in forbid_c or ref.canonical in forbid_c:
                problems.append(f"{disc.describe(o['resource'])} {o['container']['path']}: forbidden image {value} still referenced")
    present = {f["ref"] for f in final}
    for e in expect:
        if imageref.parse(e).canonical not in present:
            problems.append(f"expected image {e} is not referenced by the rendered output")
    if problems:
        raise ImgsecError("discovery", "\n".join(problems[:50]))
    return docs, {"replaced": replaced, "images": final}


def main(args):
    with open(args.manifests, "rb") as f:
        text = f.read(64 * 1024 * 1024 + 1)
    docs = [(f"{os.path.basename(args.manifests)}#{i}", d) for i, d in enumerate(yamlio.load_all(text.decode("utf-8"), args.manifests)) if d is not None]
    mapping = load_mapping(args.mapping) if args.mapping else {}
    expect = json.loads(args.expect_json) if args.expect_json else []
    forbid = json.loads(args.forbid_json) if args.forbid_json else []
    adapters = json.loads(args.adapters_json) if args.adapters_json else []
    if not all(isinstance(x, list) and all(isinstance(s, str) for s in x) for x in (expect, forbid)):
        raise ImgsecError("input", "--expect-json/--forbid-json must be JSON string arrays")
    docs, rep = pin(docs, mapping, adapters=adapters, require_digest=args.require_digest, expect=expect,
                    forbid=forbid, allow_secrets=args.allow_secrets)
    fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(yamlio.dump_all([d for _, d in docs]))
    if args.report:
        util.write_json(args.report, rep)
    util.append_summary(f"📌 pinned {len(rep['replaced'])} image field(s); {len(rep['images'])} image field(s) in output, "
                        f"all digest-pinned: {all(imageref.parse(i['image']).digest for i in rep['images'])}\n")
    return 0
