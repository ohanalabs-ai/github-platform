"""imgsec — manifest-driven container image security helpers (devsecops-images).

Stdlib + PyYAML (safe loaders only). Every external tool (kustomize, helm, oras, trivy,
syft, cosign, gh) is invoked with an argument LIST — never through a shell — and every
value that reaches a tool is validated first (image references, paths, platforms).

Entry point: ``python3 -m imgsec <command> …`` (see ``__main__.py``).
"""

SCHEMA_VERSION = 1


class ImgsecError(Exception):
    """A classified failure. ``kind`` is one of the report's error kinds:
    input · render · discovery · auth · network · not-found · registry · platform ·
    sbom · sbom-verification · provenance · scanner · internal
    (target status ``policy-fail`` is separate: a rule was violated, nothing broke)."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind
        self.message = message

    def as_dict(self):
        return {"kind": self.kind, "message": self.message}
