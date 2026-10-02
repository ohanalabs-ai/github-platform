"""Registry authentication: trusted per-host profiles → an isolated DOCKER_CONFIG.

registry-auth-profiles (a TRUSTED workflow input — written by the caller's workflow file,
never derived from manifests/images):

  {
    "version": 1,
    "vault": {"url": "https://vault.example.com:8200", "auth-path": "jwt-github",
              "audience": "https://github.com/<org>", "namespace": ""},
    "registries": {
      "docker.io":        {"type": "secret", "source": "dockerhub"},
      "ghcr.io":          {"type": "github-token"},
      "quay.io":          {"type": "anonymous"},
      "registry.example.com:5000":
                          {"type": "vault", "role": "imgsec-pull-example",
                           "kv-path": "kv/data/ci/registries/example", "username-key": "username",
                           "password-key": "password", "repositories": ["team/*"]},
      "harbor.example.com": {"type": "secret", "source": "registry-credentials-json"}
    }
  }

Isolation rules enforced here:
  * lookup is by the EXACT normalized host[:port] of the image being handled; there is no
    wildcard/suffix matching, so no hostname can select another registry's credentials;
  * github-token only for ghcr.io, dockerhub secret only for docker.io; a registry-credentials-json
    secret is read ONLY at the exact host key;
  * each job writes a fresh DOCKER_CONFIG (0700 dir, 0600 file) holding at most that one host —
    anonymous jobs get an EMPTY config so ambient runner credentials are never used;
  * Vault url/auth-path/role/kv-path come only from this trusted document; the image input
    can only pick WHICH of the declared hosts applies, by its own host;
  * private/loopback/link-local/special-use hosts (and names resolving to them) are refused
    unless listed explicitly in options.allowed-registries;
  * pull_request / pull_request_target runs are anonymous-only unless the caller sets
    options.allow-credentials-on-pull-request=true.
"""
import base64
import fnmatch
import ipaddress
import json
import os
import re
import shutil
import socket
import stat
import tempfile

from . import ImgsecError
from . import imageref, util

TYPES = ("anonymous", "github-token", "secret", "vault")
PR_EVENTS = ("pull_request", "pull_request_target")
_KV_PATH = re.compile(r"^[A-Za-z0-9_-]+(/[A-Za-z0-9_.-]+)+$")
_ROLE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_KEY = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_AUTH_PATH = re.compile(r"^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$")
_VAULT_URL = re.compile(r"^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$")
_AUDIENCE = re.compile(r"^[A-Za-z0-9:/._-]{1,256}$")
_REPO_PATTERN = re.compile(r"^[a-z0-9._*/-]{1,255}$")
_SPECIAL_SUFFIXES = (".localhost", ".local", ".internal", ".svc", ".cluster.local", ".lan", ".home.arpa", ".intranet", ".corp")


def parse_profiles(text):
    if text is None or not str(text).strip():
        return {"version": 1, "vault": None, "registries": {}}
    doc = util.load_json_text(text, "registry-auth-profiles")
    if not isinstance(doc, dict) or doc.get("version") != 1:
        raise ImgsecError("input", "registry-auth-profiles must be {\"version\": 1, \"registries\": {…}}")
    util.reject_credential_keys({k: v for k, v in doc.items()}, "registry-auth-profiles")
    if set(doc) - {"version", "vault", "registries"}:
        raise ImgsecError("input", f"registry-auth-profiles: unknown keys {sorted(set(doc) - {'version', 'vault', 'registries'})}")
    vault = doc.get("vault")
    if vault is not None:
        if not isinstance(vault, dict) or set(vault) - {"url", "auth-path", "audience", "namespace"}:
            raise ImgsecError("input", "registry-auth-profiles.vault accepts url, auth-path, audience, namespace")
        if not _VAULT_URL.match(str(vault.get("url", ""))):
            raise ImgsecError("input", "registry-auth-profiles.vault.url must be https://host[:port] (TLS verification is always on)")
        if not _AUTH_PATH.match(str(vault.get("auth-path", "jwt"))):
            raise ImgsecError("input", "registry-auth-profiles.vault.auth-path invalid")
        if vault.get("audience") and not _AUDIENCE.match(vault["audience"]):
            raise ImgsecError("input", "registry-auth-profiles.vault.audience invalid")
        if vault.get("namespace") and not _AUTH_PATH.match(vault["namespace"]):
            raise ImgsecError("input", "registry-auth-profiles.vault.namespace invalid")
        vault = {"url": vault["url"].rstrip("/"), "auth-path": vault.get("auth-path", "jwt"),
                 "audience": vault.get("audience", ""), "namespace": vault.get("namespace", "")}
    regs = doc.get("registries", {})
    if not isinstance(regs, dict):
        raise ImgsecError("input", "registry-auth-profiles.registries must be an object keyed by host[:port]")
    out = {}
    for raw_host, p in regs.items():
        host = imageref.normalize_host(raw_host)
        what = f"registry-auth-profiles.registries[{raw_host!r}]"
        if host in out:
            raise ImgsecError("input", f"{what}: duplicate host after normalization ({host})")
        if not isinstance(p, dict) or p.get("type") not in TYPES:
            raise ImgsecError("input", f"{what}.type must be one of {TYPES}")
        t = p["type"]
        allowed = {"type", "repositories"} | {
            "anonymous": set(), "github-token": set(), "secret": {"source"},
            "vault": {"role", "kv-path", "username-key", "password-key"}}[t]
        if set(p) - allowed:
            raise ImgsecError("input", f"{what}: unknown keys for {t}: {sorted(set(p) - allowed)}")
        repos = p.get("repositories", [])
        if not isinstance(repos, list) or not all(isinstance(r, str) and _REPO_PATTERN.match(r) for r in repos):
            raise ImgsecError("input", f"{what}.repositories must be a list of repository path patterns (e.g. team/*)")
        if t == "github-token" and host != "ghcr.io":
            raise ImgsecError("input", f"{what}: github-token is only valid for ghcr.io (never sent to another host)")
        if t == "secret":
            src = p.get("source", "registry-credentials-json")
            if src not in ("registry-credentials-json", "dockerhub"):
                raise ImgsecError("input", f"{what}.source must be registry-credentials-json or dockerhub")
            if src == "dockerhub" and host != "docker.io":
                raise ImgsecError("input", f"{what}: the dockerhub secret pair is only valid for docker.io")
            p = dict(p, source=src)
        if t == "vault":
            if vault is None:
                raise ImgsecError("input", f"{what}: type vault needs the top-level vault block")
            if not _ROLE.match(str(p.get("role", ""))):
                raise ImgsecError("input", f"{what}.role is required ([A-Za-z0-9_.-])")
            kv = str(p.get("kv-path", ""))
            if not _KV_PATH.match(kv) or ".." in kv.split("/"):
                raise ImgsecError("input", f"{what}.kv-path must be mount/path (no '..', no spaces)")
            for k in ("username-key", "password-key"):
                if not _KEY.match(str(p.get(k, ""))):
                    raise ImgsecError("input", f"{what}.{k} is required")
        out[host] = dict(p)
    return {"version": 1, "vault": vault, "registries": out}


def special_host_reason(host):
    """Why a host must not be contacted without an explicit allowlist entry (or None)."""
    name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        ip = None
    if ip is not None:
        return _ip_reason(ip)
    if name == "localhost" or name.endswith(_SPECIAL_SUFFIXES) or "." not in name:
        return f"{name} is a local/special-use name"
    return None


def _ip_reason(ip):
    if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified \
            or not ip.is_global:
        return f"{ip} is not a public address"
    return None


def resolve_reason(host, resolver=socket.getaddrinfo):
    """DNS check: every address a registry name resolves to must be public."""
    name = host.rsplit(":", 1)[0]
    try:
        infos = resolver(name, 443, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise ImgsecError("network", f"cannot resolve registry host {name}: {e}") from None
    for info in infos:
        try:
            reason = _ip_reason(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
        if reason:
            return f"{name} resolves to {info[4][0]} ({reason})"
    return None


def select(host, path, *, profiles, options, event, resolver=socket.getaddrinfo):
    """Decide the auth mode for one image. Returns a dict of NON-secret step outputs."""
    host = imageref.normalize_host(host)
    allowed = options.get("allowed-registries") or []
    if allowed and host not in allowed:
        raise ImgsecError("auth", f"registry {host} is not in options.allowed-registries")
    if host not in allowed:
        reason = special_host_reason(host) or resolve_reason(host, resolver)
        if reason:
            raise ImgsecError("auth", f"refusing to contact {host}: {reason} — list it in options.allowed-registries to allow a private registry")
    prof = profiles["registries"].get(host, {"type": "anonymous"})
    repos = prof.get("repositories") or []
    if repos and not any(fnmatch.fnmatchcase(path, r) for r in repos):
        raise ImgsecError("auth", f"{host}/{path} is outside the repositories allowed by its auth profile ({', '.join(repos)})")
    out = {"host": host, "mode": prof["type"], "config-key": imageref.registry_config_key(host), "note": ""}
    if prof["type"] != "anonymous" and event in PR_EVENTS and not options.get("allow-credentials-on-pull-request"):
        out["mode"] = "anonymous"
        out["note"] = f"credentials withheld on {event} (options.allow-credentials-on-pull-request=false)"
    if out["mode"] == "secret":
        out["secret-source"] = prof["source"]
    if out["mode"] == "vault":
        v = profiles["vault"]
        out.update({
            "vault-url": v["url"], "vault-auth-path": v["auth-path"], "vault-audience": v["audience"],
            "vault-namespace": v["namespace"], "vault-role": prof["role"],
            "vault-secrets": f"{prof['kv-path']} {prof['username-key']} | IMGSEC_REG_USERNAME ; "
                             f"{prof['kv-path']} {prof['password-key']} | IMGSEC_REG_PASSWORD",
        })
    return out


def _credentials(mode, host, env):
    if mode == "anonymous":
        return None
    if mode == "github-token":
        tok = env.get("IMGSEC_GITHUB_TOKEN", "")
        if not tok:
            raise ImgsecError("auth", "github-token profile but no GITHUB_TOKEN reached the step")
        return env.get("IMGSEC_GITHUB_ACTOR") or "github-actions", tok
    if mode == "vault":
        u, p = env.get("IMGSEC_REG_USERNAME", ""), env.get("IMGSEC_REG_PASSWORD", "")
        util.add_mask(u)
        util.add_mask(p)
        if not u or not p:
            raise ImgsecError("auth", "Vault returned no username/password for this registry profile")
        return u, p
    if mode == "secret-dockerhub":
        u, p = env.get("DOCKERHUB_USERNAME", ""), env.get("DOCKERHUB_TOKEN", "")
        util.add_mask(p)
        if not u or not p:
            raise ImgsecError("auth", "docker.io profile uses the dockerhub secret pair but DOCKERHUB_USERNAME/DOCKERHUB_TOKEN were not passed")
        return u, p
    if mode == "secret-json":
        raw = env.get("REGISTRY_CREDENTIALS_JSON", "")
        if not raw:
            raise ImgsecError("auth", "registry-credentials-json profile but the REGISTRY_CREDENTIALS_JSON secret was not passed")
        try:
            doc = json.loads(raw)
        except ValueError:
            raise ImgsecError("auth", "REGISTRY_CREDENTIALS_JSON is not valid JSON (content not shown)") from None
        if not isinstance(doc, dict):
            raise ImgsecError("auth", "REGISTRY_CREDENTIALS_JSON must be an object keyed by host[:port]")
        # GitHub masks the secret as a whole, not the values inside it: mask every leaf first.
        for v in doc.values():
            if isinstance(v, dict):
                for x in v.values():
                    if isinstance(x, str):
                        util.add_mask(x)
        match = None
        for k, v in doc.items():
            try:
                if imageref.normalize_host(k) == host:
                    if match is not None:
                        raise ImgsecError("auth", f"REGISTRY_CREDENTIALS_JSON has more than one entry for {host}")
                    match = v
            except ImgsecError as e:
                if e.kind == "auth":
                    raise
                continue
        if not isinstance(match, dict) or not match.get("username") or not match.get("password"):
            raise ImgsecError("auth", f"REGISTRY_CREDENTIALS_JSON has no username/password entry for exactly {host}")
        return str(match["username"]), str(match["password"])
    raise ImgsecError("internal", f"unknown auth mode {mode}")


def write_config(mode, host, env, base_dir):
    """Write an isolated docker config for exactly one host. Returns the DOCKER_CONFIG dir."""
    host = imageref.normalize_host(host)
    creds = _credentials(mode, host, env)
    d = tempfile.mkdtemp(prefix="imgsec-docker-", dir=base_dir)
    os.chmod(d, stat.S_IRWXU)
    cfg = {"auths": {}}
    if creds:
        token = base64.b64encode(f"{creds[0]}:{creds[1]}".encode()).decode()
        util.add_mask(token)
        cfg["auths"][imageref.registry_config_key(host)] = {"auth": token}
    path = os.path.join(d, "config.json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)
    return d


def cleanup(docker_config, base_dir):
    if docker_config and os.path.basename(docker_config).startswith("imgsec-docker-") and util.inside(base_dir, docker_config):
        shutil.rmtree(docker_config, ignore_errors=True)
        return True
    return False


def main_select(args):
    try:
        plan = util.read_json(args.plan, "plan.json")
        img = next((i for i in plan["images"] if i["id"] == args.image_id), None)
        if img is None:
            raise ImgsecError("internal", f"image id {args.image_id} is not in the plan")
        profiles = parse_profiles(os.environ.get("IMGSEC_AUTH_PROFILES", ""))
        out = select(img["host"], img["path"], profiles=profiles, options=plan["options"],
                     event=os.environ.get("GITHUB_EVENT_NAME", ""))
    except ImgsecError as e:
        util.annotate("error", f"registry auth ({e.kind}): {e.message}")
        if args.error_file:
            util.write_json(args.error_file, e.as_dict())
        util.gh_output("mode", "error")
        return 1
    for k, v in out.items():
        util.gh_output(k, v)
    print(f"registry {out['host']}: auth mode {out['mode']}" + (f" — {out['note']}" if out["note"] else ""))
    if out["note"]:
        util.annotate("notice", out["note"])
    return 0


def main_write(args):
    mode = os.environ.get("IMGSEC_AUTH_MODE", "")
    source = os.environ.get("IMGSEC_SECRET_SOURCE", "")
    if mode == "secret":
        mode = "secret-dockerhub" if source == "dockerhub" else "secret-json"
    base = os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()
    try:
        d = write_config(mode, os.environ.get("IMGSEC_HOST", ""), os.environ, base)
    except ImgsecError as e:
        util.annotate("error", f"registry auth ({e.kind}): {e.message}")
        if args.error_file:
            util.write_json(args.error_file, e.as_dict())
        return 1
    util.gh_env("DOCKER_CONFIG", d)
    print(f"isolated DOCKER_CONFIG written ({'1 host' if mode != 'anonymous' else 'anonymous, empty'})")
    return 0


def main_cleanup(_args):
    base = os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()
    removed = cleanup(os.environ.get("DOCKER_CONFIG", ""), base)
    print("DOCKER_CONFIG removed" if removed else "nothing to clean")
    return 0
