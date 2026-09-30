"""Shared plumbing: JSON I/O, GitHub Actions outputs, path confinement, subprocess, hashing."""
import hashlib
import json
import os
import re
import subprocess
import sys

from . import ImgsecError

# Keys that would carry credential values. Inputs (images / sources / options) are
# configuration, never a secret channel: a key like these anywhere in them is rejected.
_CRED_KEYS = {
    "password", "passwd", "pass", "token", "accesstoken", "identitytoken", "secret", "secrets",
    "credential", "credentials", "auth", "authorization", "username", "user", "apikey",
    "accesskey", "secretkey", "privatekey", "dockerconfigjson", "dockercfg", "pullsecret",
    "pullsecrets", "imagepullsecrets", "bearer", "cookie",
}


def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def fingerprint(obj):
    return "sha256:" + sha256_hex(canonical_json(obj))


def short_id(prefix, value, n=12):
    return f"{prefix}{sha256_hex(value)[:n]}"


def load_json_text(text, what):
    try:
        return json.loads(text)
    except (ValueError, TypeError) as e:
        raise ImgsecError("input", f"{what}: invalid JSON ({e})") from None


def read_json(path, what=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise ImgsecError("internal", f"{what or path}: file not found") from None
    except ValueError as e:
        raise ImgsecError("internal", f"{what or path}: invalid JSON ({e})") from None


def write_json(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")


def reject_credential_keys(obj, what, path="$"):
    """Raise if any mapping key in obj looks like a credential field."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            norm = re.sub(r"[-_.\s]", "", str(k)).lower()
            if norm in _CRED_KEYS:
                raise ImgsecError(
                    "input",
                    f"{what}: key {path}.{k} looks like a credential — credentials are never accepted in "
                    "images/sources/options inputs (use registry-auth-profiles + secrets/Vault)",
                )
            reject_credential_keys(v, what, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            reject_credential_keys(v, what, f"{path}[{i}]")


# ---------------------------------------------------------------- GitHub Actions
def gh_output(name, value):
    """Append name=value to $GITHUB_OUTPUT (heredoc form for multi-line)."""
    path = os.environ.get("GITHUB_OUTPUT")
    value = "" if value is None else str(value)
    if not path:
        print(f"[output] {name}={value}")
        return
    with open(path, "a", encoding="utf-8") as f:
        if "\n" in value:
            delim = "EOF_" + sha256_hex(value)[:16]
            f.write(f"{name}<<{delim}\n{value}\n{delim}\n")
        else:
            f.write(f"{name}={value}\n")


def gh_env(name, value):
    path = os.environ.get("GITHUB_ENV")
    if "\n" in str(value):
        raise ImgsecError("internal", f"refusing multi-line env value for {name}")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")


def _escape_cmd(s):
    return str(s).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def annotate(level, message):
    """::error:: / ::warning:: / ::notice:: workflow commands (escaped)."""
    print(f"::{level}::{_escape_cmd(message)}", flush=True)


def add_mask(value):
    if not value:
        return
    for line in str(value).splitlines():
        if line.strip():
            print(f"::add-mask::{line}", flush=True)


def append_summary(markdown):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(markdown)
            if not markdown.endswith("\n"):
                f.write("\n")


# ---------------------------------------------------------------- paths
_SAFE_REL = re.compile(r"^[A-Za-z0-9_.@+=,-][A-Za-z0-9_./@+=,-]*$")
_SAFE_GLOB = re.compile(r"^[A-Za-z0-9_.@+=,*?\[\]-][A-Za-z0-9_./@+=,*?\[\]-]*$")


def confine(root, rel, what, allow_glob=False, must_exist=True):
    """Resolve rel under root; reject absolute paths, '..', odd characters and symlink escapes."""
    if not isinstance(rel, str) or not rel:
        raise ImgsecError("input", f"{what}: path must be a non-empty string")
    pat = _SAFE_GLOB if allow_glob else _SAFE_REL
    if rel.startswith("/") or not pat.match(rel):
        raise ImgsecError("input", f"{what}: {rel!r} must be a relative path of [A-Za-z0-9_./@+=,-] characters")
    if any(part == ".." for part in rel.split("/")):
        raise ImgsecError("input", f"{what}: {rel!r} must not contain '..'")
    root_real = os.path.realpath(root)
    full = os.path.join(root_real, rel)
    if allow_glob and any(c in rel for c in "*?["):
        return full
    real = os.path.realpath(full)
    if real != root_real and not real.startswith(root_real + os.sep):
        raise ImgsecError("input", f"{what}: {rel!r} resolves outside the source root (symlink escape)")
    if must_exist and not os.path.exists(real):
        raise ImgsecError("input", f"{what}: {rel!r} does not exist")
    return real


def inside(root, path):
    root_real = os.path.realpath(root)
    real = os.path.realpath(path)
    return real == root_real or real.startswith(root_real + os.sep)


def check_tree_symlinks(root, tree, what):
    """Every symlink under tree must resolve inside root."""
    for dirpath, dirnames, filenames in os.walk(tree, followlinks=False):
        for name in dirnames + filenames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p) and not inside(root, p):
                raise ImgsecError("input", f"{what}: symlink {os.path.relpath(p, root)} points outside the source root")


# ---------------------------------------------------------------- subprocess
def run(args, *, env=None, cwd=None, timeout=900, input_bytes=None):
    """Run a tool with an argument list (never a shell). Returns (rc, stdout bytes, stderr str)."""
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise ImgsecError("internal", "run(): args must be a list of strings")
    try:
        p = subprocess.run(
            args, env=env, cwd=cwd, timeout=timeout, input=input_bytes,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
    except FileNotFoundError:
        raise ImgsecError("internal", f"tool not found on PATH: {args[0]}") from None
    except subprocess.TimeoutExpired:
        raise ImgsecError("network", f"{args[0]} timed out after {timeout}s") from None
    return p.returncode, p.stdout, p.stderr.decode("utf-8", "replace")


def tail(text, n=1500):
    text = (text or "").strip()
    return text if len(text) <= n else "…" + text[-n:]


def classify_registry_error(stderr):
    """Map a registry client's stderr to an error kind (auth · not-found · network · registry).
    Status codes are matched as whole words so hex digests in messages cannot trigger them."""
    s = (stderr or "").lower()

    def has(words, codes=()):
        return any(k in s for k in words) or any(re.search(r"(?<![0-9a-f])" + c + r"(?![0-9a-f])", s) for c in codes)

    if has(("unauthorized", "denied", "forbidden", "authentication required", "no basic auth credentials",
            "insufficient_scope"), ("401", "403")):
        return "auth"
    if has(("manifest_unknown", "not found", "name_unknown", "no such manifest"), ("404",)):
        return "not-found"
    if has(("no such host", "dial tcp", "server misbehaving", "timeout", "timed out", "connection refused", "connection reset", "tls handshake",
            "x509", "i/o timeout", "unexpected eof", "network is unreachable", "temporary failure",
            "toomanyrequests", "too many requests"), ("429", "502", "503", "504")):
        return "network"
    return "registry"


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)
