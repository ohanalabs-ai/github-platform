"""Image discovery over RENDERED Kubernetes objects.

Only documented, structured locations are read:

  built-in workloads (core/apps/extensions/batch API groups)
    Pod                     spec
    Deployment ReplicaSet StatefulSet DaemonSet ReplicationController Job
                            spec.template.spec
    CronJob                 spec.jobTemplate.spec.template.spec
    PodTemplate             template.spec
    *List (items[])         recursively

  in each PodSpec
    containers[].image              → container
    initContainers[].image          → init-container  (restartPolicy: Always → sidecar)
    ephemeralContainers[].image     → ephemeral-container
    volumes[].image.reference       → image-volume (Kubernetes ImageVolume)

  custom resources — ONLY through explicit adapters from the sources document:
    {"apiVersion": "argoproj.io/v1alpha1", "kind": "Rollout", "pod-spec-paths": ["spec.template.spec"]}
    {"apiVersion": "example.com/v1", "kind": "Thing", "image-paths": ["spec.image", "spec.workers[*].image"]}

Everything else is NOT interpreted. Instead, any other object (Secrets and ConfigMaps
excluded, metadata subtrees excluded) that has a field which *may* declare an image (an
``image`` string, an ``image`` mapping with ``repository``, or a ``containers`` /
``initContainers`` list) is reported as *unsupported* — the plan fails on it unless the
caller set ``unsupported-resources: warn``. Nothing is silently skipped.
"""
import re

from . import ImgsecError
from . import imageref

BUILTIN = {
    "Pod": ({"v1"}, ("spec",)),
    "PodTemplate": ({"v1"}, ("template", "spec")),
    "ReplicationController": ({"v1"}, ("spec", "template", "spec")),
    "Deployment": ({"apps/v1", "apps/v1beta1", "apps/v1beta2", "extensions/v1beta1"}, ("spec", "template", "spec")),
    "ReplicaSet": ({"apps/v1", "apps/v1beta2", "extensions/v1beta1"}, ("spec", "template", "spec")),
    "DaemonSet": ({"apps/v1", "apps/v1beta2", "extensions/v1beta1"}, ("spec", "template", "spec")),
    "StatefulSet": ({"apps/v1", "apps/v1beta1", "apps/v1beta2"}, ("spec", "template", "spec")),
    "Job": ({"batch/v1"}, ("spec", "template", "spec")),
    "CronJob": ({"batch/v1", "batch/v1beta1", "batch/v2alpha1"}, ("spec", "jobTemplate", "spec", "template", "spec")),
}
# Objects whose string payloads are data, not declarations — never scanned for images.
DATA_KINDS = {("v1", "Secret"), ("v1", "ConfigMap")}
_PATH_SEG = re.compile(r"^([A-Za-z0-9_-]+)(\[(\*|[0-9]+)\])?$")
_MAX_WALK_NODES = 200000


class Occurrence(dict):
    """One image declaration: where it came from and where it sits in the object."""


def _parse_path(path, what):
    if not isinstance(path, str) or not path:
        raise ImgsecError("input", f"{what}: path must be a non-empty string")
    segs = []
    for seg in path.split("."):
        m = _PATH_SEG.match(seg)
        if not m:
            raise ImgsecError("input", f"{what}: invalid path segment {seg!r} in {path!r} (key, key[N] or key[*])")
        segs.append((m.group(1), m.group(3)))
    return segs


def validate_adapters(adapters):
    out = []
    if adapters is None:
        return out
    if not isinstance(adapters, list):
        raise ImgsecError("input", "sources.adapters must be a list")
    seen = set()
    for i, a in enumerate(adapters):
        what = f"sources.adapters[{i}]"
        if not isinstance(a, dict):
            raise ImgsecError("input", f"{what} must be an object")
        extra = set(a) - {"apiVersion", "kind", "pod-spec-paths", "image-paths"}
        if extra:
            raise ImgsecError("input", f"{what}: unknown keys {sorted(extra)}")
        api, kind = a.get("apiVersion"), a.get("kind")
        if not isinstance(api, str) or not re.match(r"^[a-z0-9.-]+/[a-z0-9]+$|^v1$", api or ""):
            raise ImgsecError("input", f"{what}.apiVersion must be group/version")
        if not isinstance(kind, str) or not re.match(r"^[A-Z][A-Za-z0-9]*$", kind or ""):
            raise ImgsecError("input", f"{what}.kind must be a Kind name")
        if kind in BUILTIN and api in BUILTIN[kind][0]:
            raise ImgsecError("input", f"{what}: {api} {kind} is built in; adapters are for custom resources")
        if (api, kind) in seen:
            raise ImgsecError("input", f"{what}: duplicate adapter for {api} {kind}")
        seen.add((api, kind))
        pod = [_parse_path(p, what) for p in a.get("pod-spec-paths", [])]
        img = [_parse_path(p, what) for p in a.get("image-paths", [])]
        if not pod and not img:
            raise ImgsecError("input", f"{what}: needs pod-spec-paths and/or image-paths")
        out.append({"apiVersion": api, "kind": kind, "pod": list(zip(a.get("pod-spec-paths", []), pod)),
                    "img": list(zip(a.get("image-paths", []), img))})
    return out


def _select(obj, segs, prefix=""):
    """Yield (value, dotted-path) for a parsed path with [N]/[*] support."""
    if not segs:
        yield obj, prefix
        return
    (key, idx), rest = segs[0], segs[1:]
    if not isinstance(obj, dict) or key not in obj:
        return
    val = obj[key]
    p = f"{prefix}.{key}" if prefix else key
    if idx is None:
        yield from _select(val, rest, p)
    elif isinstance(val, list):
        rng = range(len(val)) if idx == "*" else [int(idx)] if int(idx) < len(val) else []
        for i in rng:
            yield from _select(val[i], rest, f"{p}[{i}]")


def _meta(doc, default_ns):
    md = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
    r = {
        "apiVersion": doc.get("apiVersion"),
        "kind": doc.get("kind"),
        "namespace": md.get("namespace") or default_ns or "",
        "name": md.get("name") or "",
    }
    ann = md.get("annotations") if isinstance(md.get("annotations"), dict) else {}
    hook = ann.get("helm.sh/hook")
    if isinstance(hook, str) and hook:
        # Helm hooks/tests are rendered by default (policy: sources.helm hooks/skip-tests) and marked.
        r["helm-hook"] = hook
    return r


def _podspec(spec, base_path, resource, add, errors):
    if not isinstance(spec, dict):
        errors.append(f"{describe(resource)}: {base_path} is not a PodSpec object")
        return
    fields = (("containers", "container"), ("initContainers", "init-container"), ("ephemeralContainers", "ephemeral-container"))
    for field, ctype in fields:
        items = spec.get(field)
        if items is None:
            continue
        if not isinstance(items, list):
            errors.append(f"{describe(resource)}: {base_path}.{field} is not a list")
            continue
        for i, c in enumerate(items):
            path = f"{base_path}.{field}[{i}]"
            if not isinstance(c, dict):
                errors.append(f"{describe(resource)}: {path} is not an object")
                continue
            t = ctype
            if field == "initContainers" and c.get("restartPolicy") == "Always":
                t = "sidecar"
            if "image" not in c:
                errors.append(f"{describe(resource)}: {path} ({c.get('name', '?')}) declares no image")
                continue
            add(c.get("image"), resource, {"type": t, "name": str(c.get("name", "")), "path": f"{path}.image"})
    vols = spec.get("volumes")
    if isinstance(vols, list):
        for i, v in enumerate(vols):
            if isinstance(v, dict) and isinstance(v.get("image"), dict) and "reference" in v["image"]:
                add(v["image"]["reference"], resource,
                    {"type": "image-volume", "name": str(v.get("name", "")), "path": f"{base_path}.volumes[{i}].image.reference"})


def describe(r):
    ns = f"{r['namespace']}/" if r.get("namespace") else ""
    return f"{r.get('apiVersion')} {r.get('kind')} {ns}{r.get('name')}"


def _image_like_paths(obj, covered, prefix="", seen=None, budget=None):
    """Paths in a non-built-in object that may declare an image (for the unsupported report)."""
    if seen is None:
        seen, budget = set(), [0]
    found = []
    if isinstance(obj, (dict, list)):
        if id(obj) in seen:
            return found
        seen.add(id(obj))
        budget[0] += 1
        if budget[0] > _MAX_WALK_NODES:
            raise ImgsecError("discovery", "object too large/deep to inspect for image declarations")
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "metadata":
                continue
            p = f"{prefix}.{k}" if prefix else str(k)
            if any(p == c or p.startswith(c + ".") or p.startswith(c + "[") for c in covered):
                continue
            if k == "image" and ((isinstance(v, str) and v.strip()) or (isinstance(v, dict) and "repository" in v)):
                found.append(p)
            elif k in ("containers", "initContainers", "ephemeralContainers") and isinstance(v, list) and any(isinstance(x, dict) for x in v):
                found.append(p)
            else:
                found.extend(_image_like_paths(v, covered, p, seen, budget))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            found.extend(_image_like_paths(v, covered, f"{prefix}[{i}]", seen, budget))
    return found


def discover(docs, *, source_id, default_namespace="", adapters=None, extra=None):
    """Return (occurrences, unsupported, errors) for a list of (origin, document) pairs.

    occurrences: list of dicts {image, ref|None, error|None, source, resource{…}, container{…}}
    unsupported: list of {resource, paths[]} for objects that may declare images we don't read
    errors:      structural problems (non-object documents, container without image, …)
    """
    adapters = adapters or []
    occ, unsupported, errors = [], [], []

    def add(raw, resource, container):
        o = Occurrence(image=raw if isinstance(raw, str) else repr(raw), source=source_id,
                       resource=dict(resource), container=container)
        if extra:
            o.update(extra)
        try:
            o["ref"] = imageref.parse(raw).canonical
            o["error"] = None
        except ImgsecError as e:
            o["ref"], o["error"] = None, e.message
        occ.append(o)

    def visit(doc, origin, depth=0):
        if doc is None:
            return
        if depth > 8:
            errors.append(f"{origin}: List nesting too deep")
            return
        if not isinstance(doc, dict):
            errors.append(f"{origin}: YAML document is not a Kubernetes object (got {type(doc).__name__})")
            return
        api, kind = doc.get("apiVersion"), doc.get("kind")
        if not isinstance(api, str) or not isinstance(kind, str):
            errors.append(f"{origin}: YAML document lacks apiVersion/kind — not a Kubernetes object")
            return
        if kind.endswith("List") and isinstance(doc.get("items"), list):
            for i, item in enumerate(doc["items"]):
                visit(item, f"{origin} items[{i}]", depth + 1)
            return
        resource = _meta(doc, default_namespace)
        resource["origin"] = origin
        if (api, kind) in DATA_KINDS:
            return
        if kind in BUILTIN and api in BUILTIN[kind][0]:
            segs = [(s, None) for s in BUILTIN[kind][1]]
            found = list(_select(doc, segs))
            if not found:
                errors.append(f"{describe(resource)}: missing {'.'.join(BUILTIN[kind][1])}")
            for spec, path in found:
                _podspec(spec, path, resource, add, errors)
            return
        covered = []
        for a in adapters:
            if a["apiVersion"] == api and a["kind"] == kind:
                for raw_path, segs in a["pod"]:
                    for spec, path in _select(doc, segs):
                        covered.append(path)
                        _podspec(spec, path, resource, add, errors)
                for raw_path, segs in a["img"]:
                    for val, path in _select(doc, segs):
                        covered.append(path)
                        add(val, resource, {"type": "adapter", "name": "", "path": path})
        paths = _image_like_paths(doc, covered)
        if paths:
            unsupported.append({"resource": resource, "paths": paths[:20]})

    for origin, doc in docs:
        visit(doc, origin)
    return occ, unsupported, errors
