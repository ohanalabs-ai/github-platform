"""Resolve one image reference ONCE to immutable digests (index + per-platform manifests).

Uses ``oras`` (argument lists only) against the registry with the job's isolated
DOCKER_CONFIG. Every later step (SBOM, Trivy, report, digest lock) works on the digests
recorded here, so a mutable tag cannot drift between resolution and scanning.

Index handling: attestation manifests (``vnd.docker.reference.type: attestation-manifest``)
and ``unknown/unknown`` entries are filtered out; platforms are matched with docker's
normalization (arm64 ≡ arm64/v8); a requested platform that is absent, or ambiguous
(e.g. linux/arm with v6 and v7 present), fails the image instead of scanning something else.
"""
import json
import os

from . import ImgsecError
from . import imageref, util

INDEX_TYPES = {"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"}
MANIFEST_TYPES = {"application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"}
IMAGE_CONFIG_TYPES = {"application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"}


class Registry:
    """Thin oras wrapper; tests substitute a stub ``oras`` on PATH."""

    def __init__(self, oras="oras"):
        self.oras = oras

    def _run(self, args, what):
        rc, out, err = util.run([self.oras] + args, timeout=300)
        if rc != 0:
            raise ImgsecError(util.classify_registry_error(err), f"{what}: {util.tail(err, 600)}")
        return out

    def descriptor(self, ref):
        out = self._run(["manifest", "fetch", "--descriptor", ref], f"resolve {ref}")
        try:
            d = json.loads(out)
        except ValueError:
            raise ImgsecError("registry", f"resolve {ref}: unexpected descriptor output") from None
        if not imageref.is_digest(d.get("digest")):
            raise ImgsecError("registry", f"resolve {ref}: registry returned no sha256 digest")
        return d

    def manifest(self, ref_at_digest):
        out = self._run(["manifest", "fetch", ref_at_digest], f"fetch {ref_at_digest}")
        digest = ref_at_digest.rsplit("@", 1)[1]
        if "sha256:" + util.sha256_hex(out) != digest:
            raise ImgsecError("registry", f"fetch {ref_at_digest}: content does not match its digest")
        try:
            return json.loads(out)
        except ValueError:
            raise ImgsecError("registry", f"fetch {ref_at_digest}: manifest is not JSON") from None

    def blob_json(self, ref_at_digest):
        out = self._run(["blob", "fetch", "--output", "-", ref_at_digest], f"blob {ref_at_digest}")
        digest = ref_at_digest.rsplit("@", 1)[1]
        if "sha256:" + util.sha256_hex(out) != digest:
            raise ImgsecError("registry", f"blob {ref_at_digest}: content does not match its digest")
        try:
            return json.loads(out)
        except ValueError:
            raise ImgsecError("registry", f"blob {ref_at_digest}: not JSON") from None

    def discover(self, ref_at_digest):
        out = self._run(["discover", "--format", "json", ref_at_digest], f"discover referrers of {ref_at_digest}")
        try:
            return json.loads(out)
        except ValueError:
            raise ImgsecError("registry", f"discover {ref_at_digest}: unexpected output") from None

    def manifest_or_none(self, ref):
        """Fetch a manifest by tag; None only on a clean not-found (auth/network errors raise)."""
        try:
            out = self._run(["manifest", "fetch", ref], f"fetch {ref}")
        except ImgsecError as e:
            if e.kind == "not-found":
                return None
            raise
        try:
            return json.loads(out)
        except ValueError:
            raise ImgsecError("registry", f"fetch {ref}: manifest is not JSON") from None


def _entry_platform(p):
    if not isinstance(p, dict):
        return None
    os_, arch, var = p.get("os", ""), p.get("architecture", ""), p.get("variant", "") or ""
    if not os_ or not arch or os_ == "unknown" or arch == "unknown":
        return None
    try:
        return imageref.platform_str(*imageref.parse_platform(f"{os_}/{arch}" + (f"/{var}" if var else "")))
    except ImgsecError:
        return None


def select_platforms(available, requested):
    """available: {platform: descriptor}. Returns (selected {platform: descriptor}, missing [..])."""
    if requested == "all":
        return dict(available), []
    selected, missing = {}, []
    for req in requested:
        if req in available:
            selected[req] = available[req]
            continue
        os_, arch, var = imageref.parse_platform(req)
        cands = [p for p in available if not var and p.split("/")[:2] == [os_, arch]]
        if len(cands) == 1:
            selected[cands[0]] = available[cands[0]]
        elif len(cands) > 1:
            raise ImgsecError("platform", f"platform {req} is ambiguous here ({', '.join(sorted(cands))}); request a variant")
        else:
            missing.append(req)
    return selected, missing


def resolve(image, registry):
    ref = imageref.parse(image["ref"])
    lookup = ref.at(ref.digest) if ref.digest else f"{ref.repository}:{ref.tag}"
    desc = registry.descriptor(lookup)
    top = desc["digest"]
    if ref.digest and top != ref.digest:
        raise ImgsecError("registry", f"registry returned {top} for {lookup}")
    mt = desc.get("mediaType", "")
    doc = registry.manifest(ref.at(top))
    mt = mt or doc.get("mediaType", "")
    available, skipped = {}, []
    if mt in INDEX_TYPES or "manifests" in doc:
        index_digest = top
        for m in doc.get("manifests") or []:
            ann = m.get("annotations") or {}
            if ann.get("vnd.docker.reference.type") == "attestation-manifest":
                skipped.append({"digest": m.get("digest"), "reason": "attestation-manifest"})
                continue
            if m.get("mediaType") not in MANIFEST_TYPES:
                skipped.append({"digest": m.get("digest"), "reason": f"media type {m.get('mediaType')}"})
                continue
            p = _entry_platform(m.get("platform"))
            if p is None:
                skipped.append({"digest": m.get("digest"), "reason": "no/unknown platform"})
                continue
            if not imageref.is_digest(m.get("digest")):
                raise ImgsecError("registry", f"index {top} has an entry without a sha256 digest")
            if p in available:
                skipped.append({"digest": m.get("digest"), "reason": f"duplicate {p}"})
                continue
            available[p] = {"digest": m["digest"], "media-type": m["mediaType"]}
        if not available:
            raise ImgsecError("platform", f"index {top} has no runnable platform manifests")
    elif mt in MANIFEST_TYPES or "config" in doc:
        index_digest = None
        cfg = doc.get("config") or {}
        if cfg.get("mediaType") not in IMAGE_CONFIG_TYPES or not imageref.is_digest(cfg.get("digest")):
            raise ImgsecError("registry", f"{ref.at(top)} is not a container image (config media type {cfg.get('mediaType')})")
        conf = registry.blob_json(ref.at(cfg["digest"]))
        p = _entry_platform({"os": conf.get("os"), "architecture": conf.get("architecture"), "variant": conf.get("variant")})
        if p is None:
            raise ImgsecError("platform", f"{ref.at(top)} has no os/architecture in its config")
        available[p] = {"digest": top, "media-type": mt}
    else:
        raise ImgsecError("registry", f"{ref.at(top)}: unsupported manifest media type {mt!r}")
    selected, missing = select_platforms(available, image["settings"]["platforms"])
    result = {
        "id": image["id"], "ref": image["ref"], "repository": ref.repository, "digest": top,
        "index-digest": index_digest, "media-type": mt, "available-platforms": sorted(available),
        "skipped-manifests": skipped, "missing-platforms": missing,
        "targets": [{"platform": p, "digest": d["digest"], "media-type": d["media-type"]} for p, d in sorted(selected.items())],
    }
    if missing:
        raise _MissingPlatforms(result)
    return result


class _MissingPlatforms(ImgsecError):
    def __init__(self, result):
        super().__init__("platform", f"requested platform(s) {', '.join(result['missing-platforms'])} not in "
                                     f"{result['ref']} (available: {', '.join(result['available-platforms'])})")
        self.result = result


def main(args):
    plan = util.read_json(args.plan, "plan.json")
    out = os.path.join(args.out, "resolved.json")
    image = next((i for i in plan["images"] if i["id"] == args.image_id), None)
    base = {"schema": 1, "plan-fingerprint": plan.get("fingerprint"), "id": args.image_id}
    if image is None:
        util.write_json(out, dict(base, status="error", error={"kind": "internal", "message": "image not in plan"}))
        return 1
    if args.auth_error and os.path.isfile(args.auth_error):
        err = util.read_json(args.auth_error)
        util.write_json(out, dict(base, ref=image["ref"], status="error", error=err))
        return 1
    try:
        res = resolve(image, Registry())
    except _MissingPlatforms as e:
        util.write_json(out, dict(base, **e.result, status="error", error=e.as_dict()))
        util.annotate("error", f"{image['ref']}: {e.message}")
        return 1
    except ImgsecError as e:
        util.write_json(out, dict(base, ref=image["ref"], status="error", error=e.as_dict()))
        util.annotate("error", f"{image['ref']}: resolve failed ({e.kind}): {e.message}")
        return 1
    util.write_json(out, dict(base, **res, status="ok"))
    util.append_summary(f"🔎 `{image['ref']}` → `{res['digest']}` — {len(res['targets'])} platform(s): "
                        + ", ".join(f"{t['platform']} `{t['digest'][:19]}…`" for t in res["targets"]) + "\n")
    return 0
