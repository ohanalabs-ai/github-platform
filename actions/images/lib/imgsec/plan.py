"""The credential-free plan: images input + rendered sources → a deduplicated image inventory.

Interfaces (all JSON strings from workflow inputs; credentials are never accepted in them):

images — one of
  "nginx:1.27"                                       a single reference
  ["nginx:1.27", {"ref": "ghcr.io/o/app:1", "platforms": ["linux/amd64"]}]
  {"version": 1,
   "mode": "scan" | "annotate",
   "defaults": {"platforms": "all" | [..], "sbom-policy": "...", "severity-threshold": "HIGH", "ignore-unfixed": false},
   "images": [{"ref": "...", "platforms": [..], "sbom-policy": "...", "severity-threshold": "...",
               "ignore-unfixed": false,
               "expected-source": {"repository": "owner/repo", "revision": "<40-hex>"},
               "labels": {"service": "frontend", "dockerfile": "src/frontend/Dockerfile"}}]}

Merge rules with ``sources``:
  * the scanned set is the UNION of images-input refs and discovered refs, deduplicated by the
    normalized reference (repository[:tag][@digest]); every occurrence is kept;
  * mode "annotate" entries do NOT add images — they only attach settings/labels/expected-source
    to discovered refs, and an annotate entry that matches no discovered ref is an error;
  * per-image settings > images.defaults > workflow inputs;
  * the same ref listed twice in images with different settings is an error.
"""
import os
import re

from . import ImgsecError, SCHEMA_VERSION
from . import discover as disc
from . import imageref, render, util

SEVERITIES = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
THRESHOLDS = SEVERITIES + ["NONE"]
SBOM_POLICIES = ("prefer-registry", "require-verified", "generate")
PROVENANCE = ("off", "verify", "verify-source")
_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_LABEL_KEY = re.compile(r"^[A-Za-z0-9_.-]{1,63}$")
_WORKFLOW = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$")
MAX_MATRIX = 256

PLATFORM_BUILDER_WORKFLOW = "ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml"
GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"

_OPTION_KEYS = {"version", "allowed-registries", "allow-empty", "max-parallel", "max-scan-jobs", "upload-sarif",
                "report-only", "trivy", "attestation-signers", "provenance", "allow-credentials-on-pull-request"}


def _platforms(value, what):
    if value in (None, "", "all"):
        return "all"
    if isinstance(value, str):
        value = [v.strip() for v in value.split(",") if v.strip()]
    if not isinstance(value, list) or not value:
        raise ImgsecError("input", f"{what}: platforms must be 'all' or a list like [\"linux/amd64\"]")
    out = []
    for v in value:
        p = imageref.platform_str(*imageref.parse_platform(v))
        if p not in out:
            out.append(p)
    return out


def _settings(obj, base, what):
    s = dict(base)
    if "platforms" in obj:
        s["platforms"] = _platforms(obj["platforms"], what)
    if "sbom-policy" in obj:
        if obj["sbom-policy"] not in SBOM_POLICIES:
            raise ImgsecError("input", f"{what}: sbom-policy must be one of {SBOM_POLICIES}")
        s["sbom-policy"] = obj["sbom-policy"]
    if "severity-threshold" in obj:
        v = str(obj["severity-threshold"]).upper()
        if v not in THRESHOLDS:
            raise ImgsecError("input", f"{what}: severity-threshold must be one of {THRESHOLDS}")
        s["severity-threshold"] = v
    if "ignore-unfixed" in obj:
        if not isinstance(obj["ignore-unfixed"], bool):
            raise ImgsecError("input", f"{what}: ignore-unfixed must be a boolean")
        s["ignore-unfixed"] = obj["ignore-unfixed"]
    return s


def base_settings(platforms, sbom_policy, severity, ignore_unfixed):
    return _settings(
        {"platforms": platforms or "all", "sbom-policy": sbom_policy or "prefer-registry",
         "severity-threshold": severity or "HIGH", "ignore-unfixed": str(ignore_unfixed).lower() == "true"},
        {}, "workflow inputs")


def parse_images(text, base):
    """→ (mode, [{"ref": ImageRef, "settings": {...}, "expected-source":…, "labels":…}])"""
    if text is None or not str(text).strip():
        return "scan", []
    t = str(text).strip()
    if t[0] not in "[{":
        return "scan", [{"ref": imageref.parse(t), "settings": dict(base), "expected-source": None, "labels": {}, "raw": t}]
    doc = util.load_json_text(t, "images")
    util.reject_credential_keys(doc, "images")
    mode, entries, defaults = "scan", doc, base
    if isinstance(doc, dict):
        if doc.get("version") != 1:
            raise ImgsecError("input", "images manifest: version must be 1")
        extra = set(doc) - {"version", "mode", "defaults", "images"}
        if extra:
            raise ImgsecError("input", f"images manifest: unknown keys {sorted(extra)}")
        mode = doc.get("mode", "scan")
        if mode not in ("scan", "annotate"):
            raise ImgsecError("input", "images manifest: mode must be scan or annotate")
        defaults = _settings(doc.get("defaults") or {}, base, "images.defaults")
        entries = doc.get("images")
    if not isinstance(entries, list):
        raise ImgsecError("input", "images: expected a reference, a JSON array or a {version:1, images:[…]} manifest")
    out = []
    for i, e in enumerate(entries):
        what = f"images[{i}]"
        if isinstance(e, str):
            e = {"ref": e}
        if not isinstance(e, dict) or "ref" not in e:
            raise ImgsecError("input", f"{what}: must be a reference string or an object with ref")
        extra = set(e) - {"ref", "platforms", "sbom-policy", "severity-threshold", "ignore-unfixed", "expected-source", "labels"}
        if extra:
            raise ImgsecError("input", f"{what}: unknown keys {sorted(extra)}")
        ref = imageref.parse(e["ref"])
        exp = e.get("expected-source")
        if exp is not None:
            if (not isinstance(exp, dict) or set(exp) - {"repository", "revision"}
                    or not _REPO.match(str(exp.get("repository", ""))) or not _SHA.match(str(exp.get("revision", "")))):
                raise ImgsecError("input", f"{what}.expected-source must be {{repository: owner/repo, revision: <40-hex>}}")
        labels = e.get("labels", {})
        if not isinstance(labels, dict) or not all(_LABEL_KEY.match(str(k)) and isinstance(v, str) and len(v) <= 512 for k, v in labels.items()):
            raise ImgsecError("input", f"{what}.labels must map short keys to strings")
        out.append({"ref": ref, "settings": _settings(e, defaults, what), "expected-source": exp, "labels": labels, "raw": e["ref"]})
    return mode, out


def parse_options(text, owner):
    doc = {} if text is None or not str(text).strip() else util.load_json_text(text, "options")
    if not isinstance(doc, dict):
        raise ImgsecError("input", "options must be a JSON object")
    util.reject_credential_keys(doc, "options")
    if doc and doc.get("version", 1) != 1:
        raise ImgsecError("input", "options.version must be 1")
    extra = set(doc) - _OPTION_KEYS
    if extra:
        raise ImgsecError("input", f"options: unknown keys {sorted(extra)}")
    o = {
        "allowed-registries": [imageref.normalize_host(h) for h in doc.get("allowed-registries", [])],
        "allow-empty": bool(doc.get("allow-empty", False)),
        "max-parallel": doc.get("max-parallel", 8),
        "max-scan-jobs": doc.get("max-scan-jobs", MAX_MATRIX),
        "upload-sarif": bool(doc.get("upload-sarif", False)),
        "report-only": bool(doc.get("report-only", False)),
        "provenance": doc.get("provenance", "off"),
        "allow-credentials-on-pull-request": bool(doc.get("allow-credentials-on-pull-request", False)),
    }
    for k in ("max-parallel", "max-scan-jobs"):
        if not isinstance(o[k], int) or isinstance(o[k], bool) or not 1 <= o[k] <= MAX_MATRIX:
            raise ImgsecError("input", f"options.{k} must be an integer 1..{MAX_MATRIX}")
    if o["provenance"] not in PROVENANCE:
        raise ImgsecError("input", f"options.provenance must be one of {PROVENANCE}")
    trivy = doc.get("trivy", {})
    if not isinstance(trivy, dict) or set(trivy) - {"scanners", "timeout", "db-repository", "java-db-repository"}:
        raise ImgsecError("input", "options.trivy accepts scanners, timeout, db-repository, java-db-repository")
    scanners = trivy.get("scanners", "vuln")
    if not re.match(r"^(vuln|misconfig|license)(,(vuln|misconfig|license))*$", scanners) or "vuln" not in scanners.split(","):
        raise ImgsecError("input", "options.trivy.scanners must include vuln and may add misconfig,license (secret scanning is off: findings would copy secrets into artifacts)")
    timeout = trivy.get("timeout", "15m")
    if not re.match(r"^[0-9]{1,3}[smh]$", timeout):
        raise ImgsecError("input", "options.trivy.timeout must look like 15m")
    for k in ("db-repository", "java-db-repository"):
        v = trivy.get(k, "")
        if v:
            r = imageref.parse(v)
            trivy[k] = r.repository + (f":{r.tag}" if r.tag and not r.implicit_tag else "")
    o["trivy"] = {"scanners": scanners, "timeout": timeout, "db-repository": trivy.get("db-repository", ""),
                  "java-db-repository": trivy.get("java-db-repository", "")}
    signers = doc.get("attestation-signers")
    if signers is None:
        signers = default_signers(owner)
    o["attestation-signers"] = validate_signers(signers)
    return o


def default_signers(owner):
    """The identities of this platform's docker-multiarch-cicd.yaml builder (both storage forms)."""
    signers = [{
        "type": "cosign",
        "certificate-identity-regexp": "^https://github\\.com/ohanalabs-ai/github-platform/\\.github/workflows/docker-multiarch-cicd\\.yaml@",
        "certificate-oidc-issuer": GITHUB_OIDC_ISSUER,
    }]
    if owner and re.match(r"^[A-Za-z0-9_.-]+$", owner):
        signers.insert(0, {"type": "github", "owner": owner, "signer-workflow": PLATFORM_BUILDER_WORKFLOW})
    return signers


def validate_signers(signers):
    if not isinstance(signers, list):
        raise ImgsecError("input", "options.attestation-signers must be a list")
    out = []
    for i, s in enumerate(signers):
        what = f"options.attestation-signers[{i}]"
        if not isinstance(s, dict):
            raise ImgsecError("input", f"{what} must be an object")
        if s.get("type") == "github":
            if set(s) - {"type", "owner", "repo", "signer-workflow", "hostname"}:
                raise ImgsecError("input", f"{what}: unknown keys")
            if not s.get("owner") and not s.get("repo"):
                raise ImgsecError("input", f"{what}: github signer needs owner or repo")
            if s.get("owner") and not re.match(r"^[A-Za-z0-9_.-]+$", s["owner"]):
                raise ImgsecError("input", f"{what}.owner invalid")
            if s.get("repo") and not _REPO.match(s["repo"]):
                raise ImgsecError("input", f"{what}.repo must be owner/repo")
            if not s.get("signer-workflow") or not _WORKFLOW.match(s["signer-workflow"]):
                raise ImgsecError("input", f"{what}.signer-workflow must be owner/repo/.github/workflows/<file>.yaml (an identity pin is required)")
            if s.get("hostname") and not re.match(r"^[a-z0-9.-]+$", s["hostname"]):
                raise ImgsecError("input", f"{what}.hostname invalid")
        elif s.get("type") == "cosign":
            if set(s) - {"type", "certificate-identity", "certificate-identity-regexp", "certificate-oidc-issuer"}:
                raise ImgsecError("input", f"{what}: unknown keys")
            ident = s.get("certificate-identity") or s.get("certificate-identity-regexp")
            if not ident or not isinstance(ident, str) or len(ident) > 512:
                raise ImgsecError("input", f"{what}: certificate-identity or certificate-identity-regexp is required")
            rx = s.get("certificate-identity-regexp")
            if rx and not (rx.startswith("^") and ("@" in rx or rx.endswith("$"))):
                raise ImgsecError("input", f"{what}.certificate-identity-regexp must be anchored (^…@ or ^…$)")
            iss = s.get("certificate-oidc-issuer")
            if not iss or not re.match(r"^https://[A-Za-z0-9./-]+$", iss):
                raise ImgsecError("input", f"{what}.certificate-oidc-issuer must be an https URL")
        else:
            raise ImgsecError("input", f"{what}.type must be github or cosign")
        out.append(dict(s))
    return out


def build_plan(*, images_text, sources_text, options_text, root, source_meta, base, owner, renderer=None):
    """Returns the plan dict. Raises ImgsecError on any input/render/discovery failure; the
    caller writes an error plan in that case."""
    options = parse_options(options_text, owner)
    mode, entries = parse_images(images_text, base)
    sources = render.parse_sources(sources_text)
    if sources is None and not entries:
        if not options["allow-empty"]:
            raise ImgsecError("input", "no images and no sources given (set options.allow-empty=true to allow an empty scan)")
    if mode == "annotate" and sources is None:
        raise ImgsecError("input", "images mode=annotate needs sources to annotate")

    by_ref = {}
    order = []

    def entry_for(ref):
        key = ref.canonical
        if key not in by_ref:
            by_ref[key] = {"ref": ref, "settings": dict(base), "expected-source": None, "labels": {},
                           "origins": [], "occurrences": [], "inputs": []}
            order.append(key)
        return by_ref[key]

    explicit = {}
    for e in entries:
        key = e["ref"].canonical
        sig = util.canonical_json([e["settings"], e["expected-source"], e["labels"]])
        if key in explicit and explicit[key] != sig:
            raise ImgsecError("input", f"images: {key} listed twice with different settings")
        explicit[key] = sig

    source_records, unsupported, warnings, errors = [], [], [], []
    if sources:
        adapters = disc.validate_adapters(sources["adapters"])
        forbidden = {}
        for f in sources["forbidden-images"]:
            forbidden[f] = f
            try:
                forbidden[imageref.parse(f).canonical] = f
            except ImgsecError:
                pass
        r = renderer or render.Renderer(root)
        try:
            for src in sources["sources"]:
                docs, versions = r.render(src)
                fp = util.fingerprint({"source": src, "tools": versions, "revision": source_meta.get("revision", "")})
                occ, uns, errs = disc.discover(
                    docs, source_id=src["id"], default_namespace=src.get("namespace", ""), adapters=adapters,
                    extra={"source-repository": source_meta.get("repository", ""),
                           "source-revision": source_meta.get("revision", ""),
                           "source-artifact": source_meta.get("artifact", ""),
                           "render-fingerprint": fp})
                errors += errs
                for u in uns:
                    unsupported.append(dict(u, source=src["id"]))
                for o in occ:
                    if o["error"]:
                        errors.append(f"unresolved image {o['image']!r} at {disc.describe(o['resource'])} {o['container']['path']}: {o['error']}")
                        continue
                    if o["image"] in forbidden or o["ref"] in forbidden:
                        errors.append(f"forbidden image {o['image']!r} (unsubstituted placeholder?) at {disc.describe(o['resource'])} {o['container']['path']}")
                        continue
                    if o["image"] != o["ref"] and imageref.parse(o["image"]).implicit_tag:
                        warnings.append(f"{o['image']!r} has no tag (implicit :latest) at {disc.describe(o['resource'])}")
                    e = entry_for(imageref.parse(o["ref"]))
                    e["occurrences"].append(dict(o))
                    if f"source:{src['id']}" not in e["origins"]:
                        e["origins"].append(f"source:{src['id']}")
                source_records.append({
                    "id": src["id"], "type": src["type"], "settings": src, "tools": versions,
                    "render-fingerprint": fp, "documents": len(docs),
                    "occurrences": sum(1 for o in occ if o["source"] == src["id"]),
                })
        finally:
            if renderer is None:
                r.cleanup()
        if unsupported:
            msg = "; ".join(f"{disc.describe(u['resource'])} ({', '.join(u['paths'][:3])})" for u in unsupported[:10])
            if sources["unsupported-resources"] == "fail":
                errors.append(f"{len(unsupported)} resource(s) may declare images in fields this scanner does not read "
                              f"(add an adapter or set unsupported-resources=warn): {msg}")
            else:
                warnings.append(f"NOT SCANNED — {len(unsupported)} unsupported resource(s) may declare images: {msg}")
    if errors:
        raise ImgsecError("discovery", "\n".join(errors[:50]) + (f"\n… {len(errors) - 50} more" if len(errors) > 50 else ""))

    for e in entries:
        key = e["ref"].canonical
        if mode == "annotate" and key not in by_ref:
            raise ImgsecError("input", f"images (annotate): {key} was not discovered in the rendered sources")
        rec = entry_for(e["ref"])
        rec["settings"], rec["expected-source"], rec["labels"] = e["settings"], e["expected-source"], e["labels"]
        rec["inputs"].append(e["raw"])
        if mode == "scan" and "images-input" not in rec["origins"]:
            rec["origins"].append("images-input")

    images = []
    for key in order:
        rec = by_ref[key]
        ref = rec["ref"]
        if options["allowed-registries"] and ref.host not in options["allowed-registries"]:
            raise ImgsecError("input", f"{key}: registry {ref.host} is not in options.allowed-registries")
        if options["provenance"] == "verify-source" and not rec["expected-source"]:
            raise ImgsecError("input", f"{key}: provenance=verify-source needs images[].expected-source for every image")
        for o in rec["occurrences"]:
            o["platforms"] = rec["settings"]["platforms"]
        images.append(dict(ref.as_dict(), id=util.short_id("i", key), settings=rec["settings"],
                           **{"expected-source": rec["expected-source"], "labels": rec["labels"],
                              "origins": rec["origins"], "inputs": rec["inputs"], "occurrences": rec["occurrences"]}))
    if not images and not options["allow-empty"]:
        raise ImgsecError("discovery", "zero images discovered (set options.allow-empty=true to allow an empty scan)")
    if len(images) > MAX_MATRIX:
        raise ImgsecError("input", f"{len(images)} images exceed the per-call limit of {MAX_MATRIX}; split the sources across calls")

    plan = {
        "schema": SCHEMA_VERSION, "status": "ok", "source": source_meta, "options": options,
        "defaults": base, "images-mode": mode, "sources": source_records, "images": images,
        "warnings": warnings, "unsupported": unsupported,
    }
    plan["fingerprint"] = util.fingerprint({"images": [{k: i[k] for k in ("ref", "settings", "expected-source")} for i in images],
                                            "sources": [s["render-fingerprint"] for s in source_records],
                                            "options": options, "source": source_meta})
    return plan


def matrix(plan):
    return {"include": [{"id": i["id"], "ref": i["ref"], "host": i["host"]} for i in plan["images"]]}


def main(args):
    base = base_settings(args.platforms, args.sbom_policy, args.severity_threshold, args.ignore_unfixed)
    meta = {"repository": args.source_repository or "", "revision": args.source_revision or "",
            "artifact": args.source_artifact or ""}
    root = os.path.realpath(args.root)
    out = os.path.join(args.out, "plan.json")
    try:
        plan = build_plan(images_text=os.environ.get("IMGSEC_IMAGES", ""), sources_text=os.environ.get("IMGSEC_SOURCES", ""),
                          options_text=os.environ.get("IMGSEC_OPTIONS", ""), root=root, source_meta=meta, base=base,
                          owner=os.environ.get("GITHUB_REPOSITORY_OWNER", ""))
    except ImgsecError as e:
        util.write_json(out, {"schema": SCHEMA_VERSION, "status": "error", "error": e.as_dict(), "source": meta, "images": []})
        for line in e.message.splitlines()[:30]:
            util.annotate("error", f"plan ({e.kind}): {line}")
        util.append_summary(f"### ❌ image plan failed ({e.kind})\n\n```\n{e.message}\n```\n")
        util.gh_output("status", "error")
        return 1
    util.write_json(out, plan)
    for w in plan["warnings"]:
        util.annotate("warning", w)
    util.gh_output("status", "ok")
    util.gh_output("fingerprint", plan["fingerprint"])
    util.gh_output("count", len(plan["images"]))
    util.gh_output("matrix", util.canonical_json(matrix(plan)))
    util.gh_output("max-parallel", plan["options"]["max-parallel"])
    util.gh_output("upload-sarif", str(plan["options"]["upload-sarif"]).lower())
    util.gh_output("report-only", str(plan["options"]["report-only"]).lower())
    lines = [f"### 🧭 image plan — {len(plan['images'])} image(s)", "",
             "| image | origins | occurrences | platforms |", "|---|---|---|---|"]
    for i in plan["images"]:
        pl = i["settings"]["platforms"]
        lines.append(f"| `{i['ref']}` | {', '.join(i['origins'])} | {len(i['occurrences'])} | {pl if isinstance(pl, str) else ', '.join(pl)} |")
    util.append_summary("\n".join(lines) + "\n")
    return 0
