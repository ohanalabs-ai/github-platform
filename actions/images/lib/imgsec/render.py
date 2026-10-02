"""The ``sources`` document (schema v1) and credential-free rendering.

  {
    "version": 1,
    "sources": [
      {"id": "raw",  "type": "manifests", "paths": ["k8s/*.yaml", "k8s/**/*.yml"], "namespace": "default"},
      {"id": "shop", "type": "kustomize", "path": "deploy/overlays/prod",
       "allowed-remote-resources": ["https://github.com/org/base//app?ref=<40-hex commit>"]},
      {"id": "ob",   "type": "helm", "chart": "helm-chart", "release-name": "onlineboutique",
       "namespace": "shop", "values-files": ["values/prod.yaml"],
       "set": {"loadGenerator.create": false}, "set-string": {"images.tag": "v1.2.3"},
       "kube-version": "1.33.0", "api-versions": ["monitoring.coreos.com/v1"],
       "include-crds": true, "skip-tests": false, "hooks": "include",
       "dependencies": "vendored" | "build-locked",
       "allowed-dependency-repositories": ["https://charts.bitnami.com/bitnami", "oci://registry-1.docker.io/bitnamicharts"]}
    ],
    "adapters": [ … see discover.py … ],
    "unsupported-resources": "fail" | "warn",
    "forbidden-images": ["frontend", "adservice"]
  }

Rendering never touches a cluster (KUBECONFIG=/dev/null), never enables kustomize exec /
alpha plugins / --enable-helm, never passes a Helm post-renderer, runs Helm with empty,
isolated HELM_* homes and plugin dir, and confines every path to the source root (no
absolute paths, no '..' in caller paths, no symlink escapes). Remote kustomize resources are
refused unless listed exactly in allowed-remote-resources with a 40-hex ``ref=``; Helm
dependencies are either vendored (no network) or built from Chart.lock against an explicit
repository allowlist.

Helm ``lookup`` returns an empty map offline and ``.Capabilities`` come only from
kube-version/api-versions — charts that branch on live cluster state render the offline
branch; that is a documented blind spot, not something this code can see.
"""
import glob
import os
import re
import shutil
import tempfile

from . import ImgsecError
from . import util, yamlio

SOURCE_TYPES = ("manifests", "kustomize", "helm")
_ID = re.compile(r"^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$")
_DNS_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$")
_RELEASE = re.compile(r"^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$")
_KUBE_VERSION = re.compile(r"^v?[0-9]+\.[0-9]+(\.[0-9]+)?$")
_API_VERSION = re.compile(r"^[A-Za-z0-9.-]+(/[A-Za-z0-9.-]+){0,2}$")
_VALUE_KEY = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$")
_REMOTE_REF = re.compile(r"[?&]ref=[0-9a-f]{40}(&|$)")
_REPO_URL = re.compile(r"^(https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?|oci://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?)$")
MAX_FILE_BYTES = 20 * 1024 * 1024
KUSTOMIZATION_FILES = ("kustomization.yaml", "kustomization.yml", "Kustomization")

_COMMON_KEYS = {"id", "type", "namespace"}
_TYPE_KEYS = {
    "manifests": {"paths"},
    "kustomize": {"path", "allowed-remote-resources"},
    "helm": {"chart", "release-name", "values-files", "set", "set-string", "kube-version", "api-versions",
             "include-crds", "skip-tests", "hooks", "dependencies", "allowed-dependency-repositories"},
}
_DOC_KEYS = {"version", "sources", "adapters", "unsupported-resources", "forbidden-images"}


def parse_sources(text):
    """Validate the sources JSON; returns the normalized document (or None when empty)."""
    if text is None or not str(text).strip():
        return None
    doc = util.load_json_text(text, "sources")
    if not isinstance(doc, dict):
        raise ImgsecError("input", "sources must be a JSON object with version and sources[]")
    util.reject_credential_keys(doc, "sources")
    if doc.get("version") != 1:
        raise ImgsecError("input", "sources.version must be 1")
    extra = set(doc) - _DOC_KEYS
    if extra:
        raise ImgsecError("input", f"sources: unknown keys {sorted(extra)}")
    srcs = doc.get("sources")
    if not isinstance(srcs, list) or not srcs:
        raise ImgsecError("input", "sources.sources must be a non-empty list")
    ids = set()
    out = []
    for i, s in enumerate(srcs):
        what = f"sources.sources[{i}]"
        if not isinstance(s, dict):
            raise ImgsecError("input", f"{what} must be an object")
        t = s.get("type")
        if t not in SOURCE_TYPES:
            raise ImgsecError("input", f"{what}.type must be one of {SOURCE_TYPES}")
        extra = set(s) - _COMMON_KEYS - _TYPE_KEYS[t]
        if extra:
            raise ImgsecError("input", f"{what}: unknown keys for type {t}: {sorted(extra)}")
        sid = s.get("id") or f"{t}-{i}"
        if not isinstance(sid, str) or not _ID.match(sid):
            raise ImgsecError("input", f"{what}.id must match {_ID.pattern}")
        if sid in ids:
            raise ImgsecError("input", f"{what}.id {sid!r} is duplicated")
        ids.add(sid)
        n = dict(s, id=sid)
        ns = s.get("namespace", "")
        if ns and (not isinstance(ns, str) or not _DNS_LABEL.match(ns)):
            raise ImgsecError("input", f"{what}.namespace must be a DNS-1123 label")
        if t == "manifests":
            paths = s.get("paths")
            if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
                raise ImgsecError("input", f"{what}.paths must be a non-empty list of strings")
        elif t == "kustomize":
            if not isinstance(s.get("path"), str):
                raise ImgsecError("input", f"{what}.path is required")
            rem = s.get("allowed-remote-resources", [])
            if not isinstance(rem, list) or not all(isinstance(r, str) and _REMOTE_REF.search(r) for r in rem):
                raise ImgsecError("input", f"{what}.allowed-remote-resources entries must pin ref=<40-hex commit>")
        else:
            _validate_helm(s, what)
        out.append(n)
    policy = doc.get("unsupported-resources", "fail")
    if policy not in ("fail", "warn"):
        raise ImgsecError("input", "sources.unsupported-resources must be fail or warn")
    forb = doc.get("forbidden-images", [])
    if not isinstance(forb, list) or not all(isinstance(f, str) and f for f in forb):
        raise ImgsecError("input", "sources.forbidden-images must be a list of strings")
    return {"version": 1, "sources": out, "adapters": doc.get("adapters", []),
            "unsupported-resources": policy, "forbidden-images": forb}


def _validate_helm(s, what):
    if not isinstance(s.get("chart"), str):
        raise ImgsecError("input", f"{what}.chart (a local chart directory) is required")
    rn = s.get("release-name", "release")
    if not isinstance(rn, str) or not _RELEASE.match(rn):
        raise ImgsecError("input", f"{what}.release-name must be a DNS-1123 name of ≤53 characters")
    vf = s.get("values-files", [])
    if not isinstance(vf, list) or not all(isinstance(v, str) for v in vf):
        raise ImgsecError("input", f"{what}.values-files must be a list of paths")
    for key in ("set", "set-string"):
        m = s.get(key, {})
        if not isinstance(m, dict):
            raise ImgsecError("input", f"{what}.{key} must be an object of dotted.key → value")
        for k, v in m.items():
            if not _VALUE_KEY.match(k):
                raise ImgsecError("input", f"{what}.{key}: key {k!r} must be dotted [A-Za-z0-9_-] segments (use a values file for anything else)")
            if key == "set-string" and not isinstance(v, str):
                raise ImgsecError("input", f"{what}.set-string.{k} must be a string")
    both = set(s.get("set", {})) & set(s.get("set-string", {}))
    if both:
        raise ImgsecError("input", f"{what}: keys in both set and set-string: {sorted(both)}")
    kv = s.get("kube-version")
    if kv is not None and (not isinstance(kv, str) or not _KUBE_VERSION.match(kv)):
        raise ImgsecError("input", f"{what}.kube-version must look like 1.33.0")
    av = s.get("api-versions", [])
    if not isinstance(av, list) or not all(isinstance(a, str) and _API_VERSION.match(a) for a in av):
        raise ImgsecError("input", f"{what}.api-versions must be a list like monitoring.coreos.com/v1")
    for b in ("include-crds", "skip-tests"):
        if b in s and not isinstance(s[b], bool):
            raise ImgsecError("input", f"{what}.{b} must be a boolean")
    if s.get("hooks", "include") not in ("include", "exclude"):
        raise ImgsecError("input", f"{what}.hooks must be include or exclude")
    if s.get("dependencies", "vendored") not in ("vendored", "build-locked"):
        raise ImgsecError("input", f"{what}.dependencies must be vendored or build-locked")
    repos = s.get("allowed-dependency-repositories", [])
    if not isinstance(repos, list) or not all(isinstance(r, str) and _REPO_URL.match(r) for r in repos):
        raise ImgsecError("input", f"{what}.allowed-dependency-repositories must be https:// or oci:// URLs")


def _nest(values, dotted, value, what):
    cur = values
    parts = dotted.split(".")
    for p in parts[:-1]:
        nxt = cur.setdefault(p, {})
        if not isinstance(nxt, dict):
            raise ImgsecError("input", f"{what}: {dotted!r} conflicts with another override")
        cur = nxt
    if parts[-1] in cur:
        raise ImgsecError("input", f"{what}: {dotted!r} conflicts with another override")
    cur[parts[-1]] = value


class Renderer:
    """Renders validated sources under ``root`` into [(origin, document)] — in memory only."""

    def __init__(self, root, workdir=None, tools=None):
        self.root = os.path.realpath(root)
        self.workdir = workdir or tempfile.mkdtemp(prefix="imgsec-render-")
        self.tools = tools or {"kustomize": "kustomize", "helm": "helm"}
        self._versions = {}

    # -- tool environment: nothing inherited that could point at a cluster, plugins or creds
    def _env(self, extra=None):
        home = os.path.join(self.workdir, "home")
        for d in ("home", "helm/cache", "helm/config", "helm/data", "helm/plugins", "kplugins"):
            os.makedirs(os.path.join(self.workdir, d), exist_ok=True)
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": home,
            "KUBECONFIG": "/dev/null",
            "HELM_CACHE_HOME": os.path.join(self.workdir, "helm/cache"),
            "HELM_CONFIG_HOME": os.path.join(self.workdir, "helm/config"),
            "HELM_DATA_HOME": os.path.join(self.workdir, "helm/data"),
            "HELM_PLUGINS": os.path.join(self.workdir, "helm/plugins"),
            "KUSTOMIZE_PLUGIN_HOME": os.path.join(self.workdir, "kplugins"),
            "LANG": "C.UTF-8",
        }
        if extra:
            env.update(extra)
        return env

    def tool_version(self, name):
        if name not in self._versions:
            args = [self.tools[name], "version"]
            if name == "helm":
                args += ["--template", "{{.Version}}"]
            rc, out, err = util.run(args, env=self._env(), timeout=60)
            self._versions[name] = out.decode().strip() if rc == 0 else f"unknown ({util.tail(err, 200)})"
        return self._versions[name]

    def render(self, src):
        t = src["type"]
        if t == "manifests":
            return self._manifests(src), {}
        if t == "kustomize":
            return self._kustomize(src), {"kustomize": self.tool_version("kustomize")}
        return self._helm(src), {"helm": self.tool_version("helm")}

    # -- raw manifests
    def _manifests(self, src):
        files = []
        for pat in src["paths"]:
            full = util.confine(self.root, pat, f"source {src['id']} paths", allow_glob=True)
            matches = sorted(glob.glob(full, recursive=True)) if any(c in pat for c in "*?[") else [full]
            matches = [m for m in matches if os.path.isfile(m)]
            if not matches:
                raise ImgsecError("render", f"source {src['id']}: {pat!r} matched no files")
            for m in matches:
                if not util.inside(self.root, m):
                    raise ImgsecError("render", f"source {src['id']}: {os.path.relpath(m, self.root)} resolves outside the source root")
                if not m.endswith((".yaml", ".yml", ".json")):
                    raise ImgsecError("render", f"source {src['id']}: {os.path.relpath(m, self.root)} is not .yaml/.yml/.json")
                if os.path.getsize(m) > MAX_FILE_BYTES:
                    raise ImgsecError("render", f"source {src['id']}: {os.path.relpath(m, self.root)} is larger than {MAX_FILE_BYTES} bytes")
                if os.path.realpath(m) not in files:
                    files.append(os.path.realpath(m))
        docs = []
        for f in files:
            rel = os.path.relpath(f, self.root)
            with open(f, "rb") as fh:
                for i, d in enumerate(yamlio.load_all(fh.read(), f"{src['id']}:{rel}")):
                    docs.append((f"{src['id']}:{rel}#{i}", d))
        return docs

    # -- kustomize
    def _kustomize(self, src):
        path = util.confine(self.root, src["path"], f"source {src['id']} path")
        if not os.path.isdir(path):
            raise ImgsecError("render", f"source {src['id']}: {src['path']!r} is not a directory")
        check_kustomization_graph(self.root, path, set(src.get("allowed-remote-resources", [])), what=f"source {src['id']}")
        rc, out, err = util.run(
            [self.tools["kustomize"], "build", "--load-restrictor", "LoadRestrictionsRootOnly", path],
            env=self._env(), cwd=self.root, timeout=600,
        )
        if rc != 0:
            raise ImgsecError("render", f"source {src['id']}: kustomize build failed: {util.tail(err)}")
        return [(f"{src['id']}:kustomize#{i}", d) for i, d in enumerate(yamlio.load_all(out, f"{src['id']}:kustomize"))]

    # -- helm
    def _helm(self, src):
        sid = src["id"]
        chart = util.confine(self.root, src["chart"], f"source {sid} chart")
        if not os.path.isfile(os.path.join(chart, "Chart.yaml")):
            raise ImgsecError("render", f"source {sid}: {src['chart']!r} has no Chart.yaml (only local chart directories are supported)")
        util.check_tree_symlinks(self.root, chart, f"source {sid}")
        self._helm_dependencies(src, chart)
        args = [self.tools["helm"], "template", src.get("release-name", "release"), chart]
        if src.get("namespace"):
            args += ["--namespace", src["namespace"]]
        for vf in src.get("values-files", []):
            args += ["--values", util.confine(self.root, vf, f"source {sid} values-files")]
        overrides = {}
        for k, v in src.get("set", {}).items():
            _nest(overrides, k, v, f"source {sid} set")
        for k, v in src.get("set-string", {}).items():
            _nest(overrides, k, v, f"source {sid} set-string")
        if overrides:
            gen = os.path.join(self.workdir, f"{sid}-overrides.yaml")
            with open(gen, "w", encoding="utf-8") as f:
                f.write(yamlio.dump_all([overrides]))
            args += ["--values", gen]  # last → highest precedence, typed exactly as given
        if src.get("kube-version"):
            args += ["--kube-version", src["kube-version"]]
        for a in src.get("api-versions", []):
            args += ["--api-versions", a]
        if src.get("include-crds", True):
            args.append("--include-crds")
        if src.get("skip-tests", False):
            args.append("--skip-tests")
        if src.get("hooks", "include") == "exclude":
            args.append("--no-hooks")
        rc, out, err = util.run(args, env=self._env(), cwd=self.root, timeout=600)
        if rc != 0:
            raise ImgsecError("render", f"source {sid}: helm template failed: {util.tail(err)}")
        return split_helm_output(out.decode("utf-8", "replace"), sid)

    def _helm_dependencies(self, src, chart):
        sid = src["id"]
        with open(os.path.join(chart, "Chart.yaml"), "rb") as f:
            docs = yamlio.load_all(f.read(), f"{sid}:Chart.yaml")
        meta = docs[0] if docs and isinstance(docs[0], dict) else {}
        deps = meta.get("dependencies") or []
        if not deps:
            return
        allowed = set(src.get("allowed-dependency-repositories", []))
        remote = []
        for d in deps:
            repo = (d or {}).get("repository", "") if isinstance(d, dict) else ""
            if not repo:
                continue
            if repo.startswith("file://"):
                target = os.path.normpath(os.path.join(chart, repo[len("file://"):]))
                if not util.inside(self.root, target):
                    raise ImgsecError("render", f"source {sid}: dependency {repo} is outside the source root")
                continue
            if repo.startswith("@") or repo.startswith("alias:"):
                raise ImgsecError("render", f"source {sid}: dependency repository alias {repo!r} is not supported; use the full URL")
            remote.append(repo)
        mode = src.get("dependencies", "vendored")
        if mode == "vendored":
            return  # helm template fails by itself if charts/ lacks a declared dependency
        not_allowed = sorted({r for r in remote if r not in allowed})
        if not_allowed:
            raise ImgsecError("render", f"source {sid}: dependency repositories not in allowed-dependency-repositories: {not_allowed}")
        if not os.path.isfile(os.path.join(chart, "Chart.lock")):
            raise ImgsecError("render", f"source {sid}: dependencies=build-locked requires a committed Chart.lock")
        for i, repo in enumerate(sorted({r for r in remote if r.startswith("https://")})):
            rc, _, err = util.run([self.tools["helm"], "repo", "add", f"imgsec-dep-{i}", repo], env=self._env(), timeout=300)
            if rc != 0:
                raise ImgsecError("render", f"source {sid}: helm repo add {repo} failed: {util.tail(err)}")
        rc, _, err = util.run([self.tools["helm"], "dependency", "build", chart], env=self._env(), cwd=self.root, timeout=600)
        if rc != 0:
            raise ImgsecError("render", f"source {sid}: helm dependency build (Chart.lock) failed: {util.tail(err)}")
        util.check_tree_symlinks(self.root, chart, f"source {sid}")

    def cleanup(self):
        shutil.rmtree(self.workdir, ignore_errors=True)


def split_helm_output(text, sid):
    """Split `helm template` output per document, keeping the `# Source:` template path as origin."""
    docs, chunk, idx = [], [], 0

    def flush():
        nonlocal idx
        body = "\n".join(chunk)
        if not body.strip():
            return
        origin = f"{sid}:helm#{idx}"
        for line in chunk:
            if line.startswith("# Source: "):
                origin = f"{sid}:{line[len('# Source: '):].strip()}#{idx}"
                break
        for d in yamlio.load_all(body, origin):
            docs.append((origin, d))
        idx += 1

    for line in text.split("\n"):
        if line.rstrip() == "---":
            flush()
            chunk = []
        else:
            chunk.append(line)
    flush()
    return docs


def _looks_remote(entry):
    return ("://" in entry or entry.startswith(("github.com/", "gitlab.com/", "bitbucket.org/", "git@", "ssh:"))
            or "?ref=" in entry or "_git/" in entry or entry.endswith(".git"))


def check_kustomization_graph(root, directory, allowed_remote, what, _seen=None):
    """Statically walk a kustomization graph: local references stay inside root, remote ones are
    refused unless exactly allowlisted (pinned), helm inflation is refused."""
    _seen = _seen if _seen is not None else set()
    real = os.path.realpath(directory)
    if real in _seen:
        return
    _seen.add(real)
    kfile = next((os.path.join(real, n) for n in KUSTOMIZATION_FILES if os.path.isfile(os.path.join(real, n))), None)
    if not kfile:
        raise ImgsecError("render", f"{what}: {os.path.relpath(real, root)} has no kustomization.yaml")
    if not util.inside(root, kfile):
        raise ImgsecError("render", f"{what}: {os.path.relpath(kfile, root)} resolves outside the source root")
    with open(kfile, "rb") as f:
        docs = yamlio.load_all(f.read(), f"{what}:{os.path.relpath(kfile, root)}")
    k = docs[0] if docs else {}
    if not isinstance(k, dict):
        raise ImgsecError("render", f"{what}: {os.path.relpath(kfile, root)} is not a mapping")
    for bad in ("helmCharts", "helmChartInflationGenerator", "helmGlobals"):
        if bad in k:
            raise ImgsecError("render", f"{what}: {os.path.relpath(kfile, root)} uses {bad} — kustomize helm inflation is disabled; declare a helm source instead")

    def local(entry, key):
        p = os.path.normpath(os.path.join(real, entry))
        if not util.inside(root, p):
            raise ImgsecError("render", f"{what}: {key} entry {entry!r} in {os.path.relpath(kfile, root)} resolves outside the source root")
        return p

    for key in ("resources", "bases", "components"):
        for entry in k.get(key) or []:
            if not isinstance(entry, str):
                raise ImgsecError("render", f"{what}: non-string {key} entry in {os.path.relpath(kfile, root)}")
            cand = os.path.normpath(os.path.join(real, entry))
            if not os.path.exists(cand) and _looks_remote(entry):
                if entry not in allowed_remote:
                    raise ImgsecError("render", f"{what}: remote {key} entry {entry!r} is not in allowed-remote-resources (pinned ref=<40-hex> required)")
                continue
            p = local(entry, key)
            if os.path.isdir(p):
                check_kustomization_graph(root, p, allowed_remote, what, _seen)
            elif not os.path.isfile(p):
                raise ImgsecError("render", f"{what}: {key} entry {entry!r} in {os.path.relpath(kfile, root)} does not exist")

    def files_of(v):
        if isinstance(v, str):
            return [] if "\n" in v else [v.split("=", 1)[-1]]
        if isinstance(v, list):
            return [x for item in v for x in files_of(item)]
        if isinstance(v, dict):
            out = []
            for key in ("path", "files", "envs", "env"):
                if key in v:
                    out += files_of(v[key])
            return out
        return []

    for key in ("patchesStrategicMerge", "patches", "patchesJson6902", "configMapGenerator", "secretGenerator",
                "crds", "configurations", "generators", "transformers", "validators", "replacements", "openapi"):
        for entry in files_of(k.get(key)):
            if _looks_remote(entry):
                raise ImgsecError("render", f"{what}: remote {key} entry {entry!r} is not supported")
            local(entry, key)
