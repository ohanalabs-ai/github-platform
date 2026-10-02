"""SBOM retrieval/verification/generation and optional provenance verification.

Storage forms understood (the ones docker-multiarch-cicd.yaml produces):
  * GitHub artifact attestations pushed to the registry (actions/attest-sbom,
    actions/attest-build-provenance with push-to-registry) — Sigstore bundle OCI referrers,
    artifactType application/vnd.dev.sigstore.bundle.v0.3+json, annotation
    dev.sigstore.bundle.predicateType — verified with ``gh attestation verify --bundle-from-oci``
    pinned to a signer workflow;
  * cosign attestations (``cosign attest --type spdxjson|slsaprovenance1``, keyless) — new
    Sigstore-bundle referrers or the legacy ``sha256-<hex>.att`` tag — verified with
    ``cosign verify-attestation`` pinned to a certificate identity + OIDC issuer.

Presence is established FIRST from the registry (``oras discover`` + the legacy tag), because
cosign reports "no matching attestations" both when there are none and when none verify.
So: nothing present → *not-found* (policy decides: generate with Syft or fail); present but no
configured signer verifies it → *verification-failed* (an error, never silently replaced by a
generated SBOM); auth/network/registry errors → errors (never "not found").

Scope is recorded honestly: an attestation whose subject is the index digest describes the
index (the builder's Syft run picked one platform), not necessarily the scanned platform, so
prefer-registry then ALSO generates a platform SBOM and keeps the attested one alongside.
"""
import base64
import json
import os
import re

from . import ImgsecError
from . import util

SPDX_TYPES = ("https://spdx.dev/Document/v2.3", "https://spdx.dev/Document/v2.2", "https://spdx.dev/Document")
SLSA_TYPES = ("https://slsa.dev/provenance/v1",)
BUNDLE_PREFIX = "application/vnd.dev.sigstore.bundle"
_NOT_FOUND_GH = ("no attestations found",)
_REGISTRY_TROUBLE = ("unauthorized", "denied", "forbidden", "no such host", "i/o timeout", "connection refused",
                     "connection reset", "tls handshake", "toomanyrequests", "rate limit", "service unavailable")


class Presence:
    def __init__(self):
        self.items = []  # {"form": referrer|legacy-tag, "predicate-type": str, "digest": str}

    def types(self, wanted):
        return sorted({i["predicate-type"] for i in self.items if i["predicate-type"] in wanted})

    def forms(self, ptype):
        return sorted({i["form"] for i in self.items if i["predicate-type"] == ptype})


def _walk_referrers(node, out):
    for r in (node.get("referrers") or node.get("manifests") or []):
        if not isinstance(r, dict):
            continue
        at = r.get("artifactType") or ""
        ann = r.get("annotations") or {}
        if at.startswith(BUNDLE_PREFIX):
            out.append({"form": "referrer", "predicate-type": ann.get("dev.sigstore.bundle.predicateType", "unknown"),
                        "digest": r.get("digest", "")})
        _walk_referrers(r, out)


def presence(registry, repository, digest):
    p = Presence()
    try:
        tree = registry.discover(f"{repository}@{digest}")
    except ImgsecError as e:
        if e.kind != "not-found":
            raise
        tree = {}
    _walk_referrers(tree if isinstance(tree, dict) else {}, p.items)
    legacy = registry.manifest_or_none(f"{repository}:{digest.replace(':', '-')}.att")
    if isinstance(legacy, dict):
        for layer in legacy.get("layers") or []:
            ann = (layer or {}).get("annotations") or {}
            if ann.get("predicateType"):
                p.items.append({"form": "legacy-tag", "predicate-type": ann["predicateType"], "digest": layer.get("digest", "")})
    return p


def _statement_from_line(obj):
    if isinstance(obj, dict) and "dsseEnvelope" in obj:
        obj = obj["dsseEnvelope"]
    if isinstance(obj, dict) and "payload" in obj:
        try:
            return json.loads(base64.b64decode(obj["payload"]))
        except (ValueError, TypeError):
            return None
    if isinstance(obj, dict) and "predicateType" in obj:
        return obj
    return None


def check_statement(stmt, digest, ptype):
    """The statement must name this exact digest as a subject and carry the expected predicate type."""
    if not isinstance(stmt, dict) or not str(stmt.get("_type", "")).startswith("https://in-toto.io/Statement/"):
        return "not an in-toto statement"
    if stmt.get("predicateType") != ptype:
        return f"predicate type {stmt.get('predicateType')!r} ≠ {ptype!r}"
    hexd = digest.split(":", 1)[1]
    if not any(isinstance(s, dict) and (s.get("digest") or {}).get("sha256") == hexd for s in stmt.get("subject") or []):
        return f"statement subject does not include {digest}"
    return None


class Verifier:
    """Runs gh / cosign with argument lists; tests put stubs on PATH."""

    def __init__(self, gh="gh", cosign="cosign"):
        self.gh, self.cosign = gh, cosign

    def github(self, signer, repository, digest, ptype, source=None):
        args = [self.gh, "attestation", "verify", f"oci://{repository}@{digest}", "--bundle-from-oci",
                "--predicate-type", ptype, "--signer-workflow", signer["signer-workflow"], "--format", "json"]
        if source:
            args += ["--repo", source["repository"], "--source-digest", source["revision"]]
        elif signer.get("repo"):
            args += ["--repo", signer["repo"]]
        else:
            args += ["--owner", signer["owner"]]
        if signer.get("hostname"):
            args += ["--hostname", signer["hostname"]]
        rc, out, err = util.run(args, timeout=300)
        if rc != 0:
            low = err.lower()
            if any(k in low for k in _NOT_FOUND_GH):
                return {"status": "not-found", "detail": util.tail(err, 400)}
            if any(k in low for k in _REGISTRY_TROUBLE):
                raise ImgsecError(util.classify_registry_error(err), f"gh attestation verify: {util.tail(err, 400)}")
            return {"status": "failed", "detail": util.tail(err, 600)}
        try:
            results = json.loads(out)
        except ValueError:
            return {"status": "failed", "detail": "gh attestation verify returned non-JSON output"}
        for r in results if isinstance(results, list) else []:
            vr = (r or {}).get("verificationResult") or {}
            stmt = vr.get("statement")
            problem = check_statement(stmt, digest, ptype)
            if problem:
                continue
            cert = ((vr.get("signature") or {}).get("certificate") or {})
            return {"status": "verified", "statement": stmt, "verifier": "gh attestation verify",
                    "signer": {"type": "github", "signer-workflow": signer["signer-workflow"],
                               "subject-alternative-name": cert.get("subjectAlternativeName", ""),
                               "issuer": cert.get("issuer", ""),
                               "source-repository": cert.get("sourceRepositoryURI", ""),
                               "source-digest": cert.get("sourceRepositoryDigest", "")}}
        return {"status": "failed", "detail": "verified output contained no statement for this digest/predicate"}

    def cosign_verify(self, signer, repository, digest, ptype):
        args = [self.cosign, "verify-attestation", "--type", ptype,
                "--certificate-oidc-issuer", signer["certificate-oidc-issuer"]]
        if signer.get("certificate-identity"):
            args += ["--certificate-identity", signer["certificate-identity"]]
        else:
            args += ["--certificate-identity-regexp", signer["certificate-identity-regexp"]]
        args.append(f"{repository}@{digest}")
        rc, out, err = util.run(args, timeout=300, env=dict(os.environ, COSIGN_EXPERIMENTAL="0"))
        if rc != 0:
            low = err.lower()
            if any(k in low for k in _REGISTRY_TROUBLE):
                raise ImgsecError(util.classify_registry_error(err), f"cosign verify-attestation: {util.tail(err, 400)}")
            return {"status": "failed", "detail": util.tail(err, 600)}
        cert = {}
        for line in err.splitlines():
            m = re.match(r"^(Certificate subject|Certificate issuer URL|GitHub Workflow Repository|GitHub Workflow SHA|GitHub Workflow Ref): (.*)$", line.strip())
            if m:
                cert[m.group(1)] = m.group(2).strip()
        for line in out.decode("utf-8", "replace").splitlines():
            try:
                stmt = _statement_from_line(json.loads(line))
            except ValueError:
                continue
            if check_statement(stmt, digest, ptype) is None:
                return {"status": "verified", "statement": stmt, "verifier": "cosign verify-attestation",
                        "signer": {"type": "cosign", "identity": signer.get("certificate-identity") or signer.get("certificate-identity-regexp"),
                                   "issuer": signer["certificate-oidc-issuer"],
                                   "subject-alternative-name": cert.get("Certificate subject", ""),
                                   "source-repository": cert.get("GitHub Workflow Repository", ""),
                                   "source-digest": cert.get("GitHub Workflow SHA", "")}}
        return {"status": "failed", "detail": "cosign verified signatures but no statement matched this digest/predicate"}


def verify_attestation(registry, verifier, signers, repository, digest, wanted_types, source=None):
    """→ {"status": verified|not-found|verification-failed, …} for one subject digest."""
    pres = presence(registry, repository, digest)
    types = pres.types(wanted_types)
    if not types:
        other = sorted({i["predicate-type"] for i in pres.items})
        return {"status": "not-found", "subject": digest, "present-other-types": other}
    failures = []
    for ptype in types:
        forms = pres.forms(ptype)
        for s in signers:
            if s["type"] == "github" and "referrer" in forms:
                r = verifier.github(s, repository, digest, ptype, source=source)
            elif s["type"] == "cosign":
                r = verifier.cosign_verify(s, repository, digest, ptype)
            else:
                continue
            if r["status"] == "verified":
                return dict(r, subject=digest, **{"predicate-type": ptype, "forms": forms})
            failures.append({"signer": s.get("signer-workflow") or s.get("certificate-identity-regexp") or s.get("certificate-identity"),
                             "predicate-type": ptype, "status": r["status"], "detail": r.get("detail", "")})
    return {"status": "verification-failed", "subject": digest, "present-types": types, "failures": failures}


def generate(repository, digest, out_path, syft="syft"):
    env = dict(os.environ, SYFT_CHECK_FOR_APP_UPDATE="false")
    rc, _, err = util.run([syft, "scan", f"registry:{repository}@{digest}", "-o", f"spdx-json={out_path}", "-q"], env=env, timeout=1800)
    if rc != 0:
        raise ImgsecError(util.classify_registry_error(err) if util.classify_registry_error(err) in ("auth", "network") else "sbom",
                          f"syft failed: {util.tail(err, 600)}")
    rc, out, _ = util.run([syft, "version", "-o", "json"], env=env, timeout=60)
    try:
        version = json.loads(out).get("version", "unknown") if rc == 0 else "unknown"
    except ValueError:
        version = "unknown"
    return {"tool": "syft", "version": version}


def sbom_for_target(target, policy, signers, registry, verifier, out_dir, syft="syft"):
    """Apply the SBOM policy to one platform target. Returns (metadata, policy_problem|None).
    Raises ImgsecError for verification failures and tool/registry errors."""
    repo, pdig, idig = target["repository"], target["digest"], target.get("index-digest")
    meta = {"policy": policy, "files": [], "attempts": []}
    verified = None
    if policy in ("prefer-registry", "require-verified"):
        subjects = [(pdig, "platform-manifest")] + ([(idig, "index")] if idig and idig != pdig else [])
        for digest, scope in subjects:
            r = verify_attestation(registry, verifier, signers, repo, digest, SPDX_TYPES)
            meta["attempts"].append({k: v for k, v in r.items() if k != "statement"} | {"scope": scope})
            if r["status"] == "verification-failed":
                raise ImgsecError("sbom-verification",
                                  f"SPDX attestation present on {digest} ({scope}) but no configured signer verified it: "
                                  + "; ".join(f"{f['signer']}: {f['status']} {f['detail'][:200]}" for f in r["failures"]))
            if r["status"] == "verified":
                verified = dict(r, scope=scope)
                break
    if verified:
        pred = verified["statement"].get("predicate")
        if not isinstance(pred, dict) or not str(pred.get("spdxVersion", "")).startswith("SPDX-"):
            raise ImgsecError("sbom-verification", f"verified attestation on {verified['subject']} does not carry an SPDX JSON document")
        name = "sbom-attested.spdx.json"
        util.write_json(os.path.join(out_dir, name), pred)
        meta["files"].append({"file": name, "source": "registry-attestation", "verified": True,
                              "scope": verified["scope"], "subject": verified["subject"],
                              "predicate-type": verified["predicate-type"], "verifier": verified["verifier"],
                              "signer": verified["signer"], "forms": verified["forms"]})
    if policy == "require-verified" and not verified:
        meta["primary"] = None
        return meta, "no verified SPDX attestation found on the platform manifest or index (sbom-policy=require-verified)"
    if policy == "generate" or not verified or verified["scope"] != "platform-manifest":
        if policy == "require-verified":
            meta["note"] = "verified SBOM is index-scoped; no platform SBOM generated under require-verified"
        else:
            name = "sbom.spdx.json"
            tool = generate(repo, pdig, os.path.join(out_dir, name), syft=syft)
            meta["files"].append({"file": name, "source": "generated", "verified": False, "scope": "platform-manifest",
                                  "subject": pdig, "generator": tool})
            if verified:
                meta["note"] = "attested SBOM is index-scoped (may describe another platform); a platform SBOM was generated alongside"
    primary = next((f for f in meta["files"] if f["scope"] == "platform-manifest"), meta["files"][0] if meta["files"] else None)
    meta["primary"] = primary["file"] if primary else None
    return meta, None


def provenance_for_target(target, mode, signers, registry, verifier, expected):
    """options.provenance: verify → a verified SLSA v1 provenance must exist; verify-source → and its
    signed source repository/revision must equal images[].expected-source. Returns (meta, problem)."""
    if mode == "off":
        return {"status": "skipped"}, None
    repo, pdig, idig = target["repository"], target["digest"], target.get("index-digest")
    src = expected if mode == "verify-source" else None
    attempts = []
    for digest, scope in [(pdig, "platform-manifest")] + ([(idig, "index")] if idig and idig != pdig else []):
        r = verify_attestation(registry, verifier, signers, repo, digest, SLSA_TYPES, source=src)
        attempts.append({k: v for k, v in r.items() if k != "statement"} | {"scope": scope})
        if r["status"] == "verification-failed":
            raise ImgsecError("provenance", f"SLSA provenance present on {digest} but not verified: "
                                            + "; ".join(f"{f['signer']}: {f['detail'][:200]}" for f in r["failures"]))
        if r["status"] == "verified":
            meta = {"status": "verified", "scope": scope, "subject": digest, "signer": r["signer"], "attempts": attempts,
                    "source-match": None}
            if src:
                ok, why = source_matches(r, src)
                meta["source-match"] = ok
                if not ok:
                    return meta, f"provenance source mismatch: {why}"
            return meta, None
    return {"status": "not-found", "attempts": attempts}, "no SLSA v1 provenance attestation found (options.provenance=" + mode + ")"


def source_matches(result, expected):
    """Compare the SIGNED source identity (certificate extensions) — and the predicate's
    resolvedDependencies — with the expected repository/revision."""
    signer = result.get("signer") or {}
    want_repo, want_rev = expected["repository"].lower(), expected["revision"]
    cert_repo = signer.get("source-repository", "").lower().rstrip("/")
    cert_rev = signer.get("source-digest", "")
    if cert_repo and not (cert_repo == want_repo or cert_repo.endswith("/" + want_repo)):
        return False, f"signed source repository {cert_repo} ≠ {want_repo}"
    if cert_rev and cert_rev != want_rev:
        return False, f"signed source revision {cert_rev} ≠ {want_rev}"
    pred = (result.get("statement") or {}).get("predicate") or {}
    deps = ((pred.get("buildDefinition") or {}).get("resolvedDependencies") or [])
    commits = [((d or {}).get("digest") or {}).get("gitCommit") for d in deps if isinstance(d, dict)]
    commits = [c for c in commits if c]
    if commits and want_rev not in commits:
        return False, f"provenance resolvedDependencies gitCommit {commits} does not include {want_rev}"
    if not cert_rev and not commits:
        return False, "provenance carries no source revision to compare"
    return True, "source repository/revision match"
