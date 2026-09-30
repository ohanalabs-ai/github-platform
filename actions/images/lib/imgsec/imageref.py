"""Docker-compatible image reference parsing and normalization.

Follows the grammar of github.com/distribution/reference (the parser docker, containerd,
kubelet and Trivy use):

  reference  := name [ ":" tag ] [ "@" digest ]
  name       := [ domain "/" ] path-component { "/" path-component }
  domain     := host [ ":" port ]      — the first component is a domain only when it
                                         contains "." or ":", is "localhost", or has
                                         upper-case letters (docker's rule)

Normalization (docker.io/library rules):
  ubuntu                         → docker.io/library/ubuntu:latest   (implicit tag, flagged)
  my/image                       → docker.io/my/image:latest
  index.docker.io/my/image:1     → docker.io/my/image:1
  registry.example.com:5000/a/b  → registry.example.com:5000/a/b:latest
  repo:tag@sha256:<64 hex>       → the digest is authoritative; the tag is kept as metadata

Anything that still looks like a template/placeholder ({{ }}, ${ }, $( ), <…>, spaces) is
rejected as *unresolved* rather than guessed at.
"""
import re

from . import ImgsecError

DEFAULT_DOMAIN = "docker.io"
LEGACY_DEFAULT_DOMAIN = "index.docker.io"
DOCKER_CONFIG_KEY_DOCKERHUB = "https://index.docker.io/v1/"

_ALNUM = r"[a-z0-9]+"
_SEP = r"(?:[._]|__|[-]+)"
_PATH_COMPONENT = re.compile(r"^" + _ALNUM + r"(?:" + _SEP + _ALNUM + r")*$")
_DOMAIN_LABEL = r"(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])"
_DOMAIN = re.compile(r"^" + _DOMAIN_LABEL + r"(?:\." + _DOMAIN_LABEL + r")*(?::[0-9]{1,5})?$")
_TAG = re.compile(r"^[\w][\w.-]{0,127}$")
_DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
_PLACEHOLDER = re.compile(r"(\{\{|\}\}|\$\{|\$\(|<|>|%|\s|`|\\|\"|')")
MAX_NAME = 255


class UnresolvedImage(ImgsecError):
    def __init__(self, message):
        super().__init__("discovery", message)


class ImageRef:
    __slots__ = ("domain", "path", "tag", "digest", "implicit_tag", "original")

    def __init__(self, domain, path, tag, digest, implicit_tag, original):
        self.domain, self.path, self.tag, self.digest = domain, path, tag, digest
        self.implicit_tag, self.original = implicit_tag, original

    @property
    def host(self):
        return self.domain

    @property
    def repository(self):
        return f"{self.domain}/{self.path}"

    @property
    def canonical(self):
        s = self.repository
        if self.tag:
            s += f":{self.tag}"
        if self.digest:
            s += f"@{self.digest}"
        return s

    def at(self, digest):
        """The immutable reference repository@digest."""
        if not _DIGEST.match(digest or ""):
            raise ImgsecError("internal", f"not a sha256 digest: {digest!r}")
        return f"{self.repository}@{digest}"

    @property
    def docker_config_key(self):
        return registry_config_key(self.domain)

    def as_dict(self):
        return {
            "ref": self.canonical,
            "host": self.domain,
            "repository": self.repository,
            "path": self.path,
            "tag": self.tag,
            "digest": self.digest,
            "implicit-latest": self.implicit_tag,
        }

    def __repr__(self):
        return f"ImageRef({self.canonical})"


def registry_config_key(host):
    """The DOCKER_CONFIG ``auths`` key docker/oras/trivy/cosign look up for a host."""
    return DOCKER_CONFIG_KEY_DOCKERHUB if host == DEFAULT_DOMAIN else host


def normalize_host(host):
    """Exact, lower-cased host[:port]; index.docker.io folds into docker.io."""
    if not isinstance(host, str) or not host:
        raise ImgsecError("input", "registry host must be a non-empty string")
    h = host.strip().lower()
    if h in (LEGACY_DEFAULT_DOMAIN, "registry-1.docker.io", "https://index.docker.io/v1/"):
        return DEFAULT_DOMAIN
    if not _DOMAIN.match(h):
        raise ImgsecError("input", f"invalid registry host {host!r} (expected host or host:port, no scheme/path)")
    if ":" in h:
        port = int(h.rsplit(":", 1)[1])
        if not 0 < port < 65536:
            raise ImgsecError("input", f"invalid registry port in {host!r}")
    return h


def parse(ref):
    """Parse and normalize an image reference; raises UnresolvedImage on anything else."""
    if not isinstance(ref, str):
        raise UnresolvedImage(f"image reference must be a string, got {type(ref).__name__}")
    original = ref
    if not ref or ref.strip() == "":
        raise UnresolvedImage("empty image reference")
    if _PLACEHOLDER.search(ref):
        raise UnresolvedImage(f"unresolved template/placeholder or illegal characters in image reference {ref!r}")
    if len(ref) > 512:
        raise UnresolvedImage("image reference too long")
    if "://" in ref:
        raise UnresolvedImage(f"image reference must not contain a scheme: {ref!r}")

    digest = None
    if "@" in ref:
        ref, digest = ref.split("@", 1)
        if not _DIGEST.match(digest):
            raise UnresolvedImage(f"unsupported or malformed digest in {original!r} (only sha256:<64 lowercase hex>)")
    tag = None
    last = ref.rsplit("/", 1)[-1]
    if ":" in last:
        ref, tag = ref.rsplit(":", 1)
        if not _TAG.match(tag):
            raise UnresolvedImage(f"malformed tag in {original!r}")

    parts = ref.split("/")
    if len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost" or parts[0] != parts[0].lower()):
        domain, path_parts = parts[0], parts[1:]
        if not _DOMAIN.match(domain):
            raise UnresolvedImage(f"malformed registry host in {original!r}")
        domain = domain.lower()
        if domain == LEGACY_DEFAULT_DOMAIN:
            domain = DEFAULT_DOMAIN
    else:
        domain, path_parts = DEFAULT_DOMAIN, parts
    if not path_parts or any(not _PATH_COMPONENT.match(p) for p in path_parts):
        raise UnresolvedImage(f"malformed repository path in {original!r} (lower-case a-z0-9 components separated by . _ __ -)")
    if domain == DEFAULT_DOMAIN and len(path_parts) == 1:
        path_parts = ["library"] + path_parts
    path = "/".join(path_parts)
    if len(domain) + 1 + len(path) > MAX_NAME:
        raise UnresolvedImage(f"repository name longer than {MAX_NAME} characters in {original!r}")
    implicit = False
    if tag is None and digest is None:
        tag, implicit = "latest", True
    return ImageRef(domain, path, tag, digest, implicit, original)


def is_digest(value):
    return bool(isinstance(value, str) and _DIGEST.match(value))


# ---------------------------------------------------------------- platforms
_PLAT = re.compile(r"^[a-z0-9]+/[a-z0-9_]+(?:/[a-z0-9]+)?$")
_ARCH_ALIASES = {"x86_64": "amd64", "x86-64": "amd64", "aarch64": "arm64", "armhf": "arm", "armel": "arm"}


def parse_platform(value):
    """'linux/arm64/v8' → ('linux','arm64','v8'); normalizes arch aliases and arm64's default v8."""
    if not isinstance(value, str) or not _PLAT.match(value.strip().lower()):
        raise ImgsecError("input", f"invalid platform {value!r} (expected os/arch[/variant])")
    parts = value.strip().lower().split("/")
    os_, arch = parts[0], _ARCH_ALIASES.get(parts[1], parts[1])
    variant = parts[2] if len(parts) == 3 else ""
    if arch == "arm64" and variant == "v8":
        variant = ""
    return os_, arch, variant


def platform_str(os_, arch, variant=""):
    if arch == "arm64" and variant == "v8":
        variant = ""
    return f"{os_}/{arch}" + (f"/{variant}" if variant else "")


def platform_slug(p):
    return p.replace("/", "-")
