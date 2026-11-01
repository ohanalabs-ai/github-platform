# actions/kubernetes/manifest-check — 🧪 kustomize check

"Will these manifests actually run?" — TypeScript modules run by `actions/github-script@v8` (Node 24
native type stripping, **no npm dependencies, no Python/bash logic**), used by
[`kubernetes-kustomize-devsecops.yaml`](../../../.github/workflows/kubernetes-kustomize-devsecops.yaml)
and by the `🧪 kustomize check` job of
[`gitops-argocd-group.yaml`](../../../.github/workflows/gitops-argocd-group.yaml) (the pre-condition
of the ArgoCD diff and the 🚦 gate).

| Module | Does |
|---|---|
| `install.ts` | kustomize 5.8.2 · helm 3.22.0 · kubeconform 0.8.0 · yq 4.54.1 from their releases, **sha256-pinned in the file** (`TOOLS` selects; yq always) |
| `check.ts` | the entry point: units → build → kubeconform → removed APIs → images → report; fails when `POLICY=enforce` and errors > 0 |
| `objects.ts` | YAML → objects (via `yq -o=json`), every image an object runs (containers, initContainers, ephemeralContainers, CR `image`/`*Image` fields; CRDs skipped) |
| `imageref.ts` | image reference parsing (docker.io defaulting), floating-tag and placeholder detection |
| `registry.ts` | OCI distribution v2: manifest → digest, bearer-token challenge with the auth profile, index platforms (attestations ignored) or the single image's config os/arch |
| `deprecations.ts` | apiVersions removed by Kubernetes minor (1.16 → 1.32) |
| `findings.ts` | the policy (error · warning · notice) and the markdown report |
| `comment.ts` | one sticky PR comment per `COMMENT_KEY` (hidden marker; delete + recreate) |
| `manifest-check.test.ts` | node:test self-tests — run by `actions-typescript-selftest.yaml` |

## Policy

| Finding | Level |
|---|---|
| `kustomize build` fails, kubeconform invalid, removed apiVersion | ❌ error |
| image manifest not found (`404 MANIFEST_UNKNOWN`/`NAME_UNKNOWN`; on ghcr.io only when the repository is visible to the token) | ❌ error |
| image lacks a `REQUIRED_PLATFORMS` entry (default `linux/amd64`) | ❌ error |
| image the profile cannot see (401/403/429/network) | ⚠️ warning (`FAIL_ON_UNVERIFIABLE=true` → error) |
| floating tag (`:latest`, `:main`, any letters-only tag) | ⚠️ warning (`FAIL_ON_FLOATING=true` → error) |
| tag-only reference | ℹ️ notice (`REQUIRE_DIGEST=true` → error) |
| placeholder (`CHANGE_ME…`, `${…}`) | ℹ️ not checked |
| kind with no schema (CRD not in the catalog) | counted as "no schema", not failed |

**A private image is reported as unverifiable, not missing** — registries answer an anonymous (or
under-privileged) request for a private repository with 401/403, which is indistinguishable from a
repository that does not exist. ghcr.io with the run's `GITHUB_TOKEN` (`packages: read`) sees public
packages and private ones that granted the repository access in the package settings.

**ghcr.io hides a private package behind the same 404.** A valid token WITHOUT access to another
repository's private package gets `404 MANIFEST_UNKNOWN` — not DENIED — so on a ghcr.io 404 the check
probes the repository itself (`GET /v2/<name>/tags/list`, same token): visible (200) → the tag/digest
really is **missing** (error); not visible (404 `NAME_UNKNOWN` / 401 / 403 / network) → **unverifiable**
with the hint "private package — grant the calling repository read access in the package's *Manage
Actions access* settings". Seen live on ohanalabs-ai/k8s-infra PR 22 (2026-11-01): an existing
`ghcr.io/ohanalabs-ai/vionix-engram/memories:main-a4f5fe6@sha256:cb9afa83…` failed the gate as "not found"
(https://github.com/ohanalabs-ai/k8s-infra/actions/runs/41273116311). The caller still needs
`permissions: packages: read`, and the package must grant the caller repository access, for the check to
actually verify it.

## Auth profiles

| Registry | Profile | Credential (env) |
|---|---|---|
| any | `anonymous` | — |
| `ghcr.io` | `github-token` | `GHCR_TOKEN` (the job's `github.token`) |
| `*.pkg.dev`, `gcr.io` | `gcp` | `GCP_ACCESS_TOKEN` (placeholder: an OAuth access token, e.g. from WIF) |
| `docker.io` | `dockerhub` | `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` (anonymous pulls are rate limited → 429 = warning) |

## Inputs (env)

`SOURCE` (`kustomize` | `rendered`) · `TARGETS` · `UNIT_PREFIX` / `UNIT_SKIP` (rendered artifacts) ·
`KUBERNETES_VERSION` (`1.35.0`) · `POLICY` (`enforce` | `warn`) · `REQUIRED_PLATFORMS` ·
`REQUIRE_DIGEST` · `FAIL_ON_FLOATING` · `FAIL_ON_UNVERIFIABLE` · `CHECK_IMAGES` ·
`ALL_KUSTOMIZATIONS` · `KUSTOMIZE_BUILD_ARGS` (`--enable-helm`) · `SKIP_KINDS` · `SCHEMA_LOCATIONS` ·
`KUBECONFORM_STRICT` · `TITLE` · `RUN_URL` · `OUT_DIR`. Outputs: `report`, `result-json`, `errors`, `warnings`.

## Local run

```bash
# kustomize, kubeconform, yq on PATH; github-script's ctx faked with child_process — see the selftest
node --test actions/kubernetes/manifest-check/manifest-check.test.ts
```
