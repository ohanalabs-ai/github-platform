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
| image manifest not found (`404 MANIFEST_UNKNOWN`/`NAME_UNKNOWN`) | ❌ error |
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
`KUBECONFORM_STRICT` · `TITLE` · `RUN_URL` · `OUT_DIR`. Outputs: `report`, `result`, `errors`, `warnings`.

## Local run

```bash
# kustomize, kubeconform, yq on PATH; github-script's ctx faked with child_process — see the selftest
node --test actions/kubernetes/manifest-check/manifest-check.test.ts
```
