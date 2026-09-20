# devsecops-docker

Reusable workflow: [`docker-multiarch-cicd.yaml`](../../.github/workflows/docker-multiarch-cicd.yaml) — the full multi-arch Docker CI/CD pipeline: PR build, PR-close cleanup, a build on every push to the default branch, and a tag-triggered release with SLSA provenance attestation.

## Usage

```yaml
name: docker-image-ci

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  push:
    tags:
      - 'v*'

jobs:
  docker-multiarch:
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@main
    with:
      registry: ghcr.io
      target-service: gha-fix
      platforms: linux/amd64,linux/arm64
      docker-compose-file-name: docker-compose.yaml
      dockerhub-registry: docker.io
      dockerhub-namespace: ${{ github.repository_owner }}
      # attestation-mode: auto   # default — public repo: GitHub attestations; private repo: cosign keyless
    secrets: inherit
```

Always reference `@main` — this is an internal, org-owned workflow repo, so callers are expected to track the latest reviewed version rather than pin a SHA (unlike third-party actions, which this org's own `actions-pin-version-setting-lint.yaml` requires pinning).

## Inputs

| Input | Default | Description |
|---|---|---|
| `github-actions-runner` | `ubuntu-latest` | Runner for every job |
| `github-job-timeout-minutes` | `10` | Per-job timeout; increase for slow multi-arch builds |
| `registry` | `ghcr.io` | Default registry for all builds |
| `platforms` | `linux/amd64,linux/arm64` | Platforms passed to `docker buildx bake` |
| `docker-compose-context` | `.` | Directory the compose file's build context resolves from |
| `docker-compose-file-name` | `docker-compose.yaml` | Compose file used by `docker buildx bake` |
| `docker-compose-target-service` | *(none)* | Bake target service name — only needed if the compose file defines more than one service |
| `image-name-suffix` | `""` | Path suffix for monorepos publishing multiple images from one repo (e.g. `api` → `ghcr.io/<owner>/<repo>/api`). Empty preserves the legacy one-image-per-repo name. On Docker Hub the suffix is joined with a dash instead, since Docker Hub only allows one path segment |
| `dockerhub-registry` | `docker.io` | Optional Docker Hub registry hostname for release mirroring |
| `dockerhub-namespace` | `${{ github.repository_owner }}` | Optional Docker Hub namespace for release mirroring |
| `dockerhub-registry-username` | *(none)* | Optional Docker Hub username, for mirroring a release build |
| `dockerhub-registry-token` | *(none)* | Optional Docker Hub token, for mirroring a release build — pass as `${{ secrets.DOCKERHUB_TOKEN }}` from the caller |
| `attestation-mode` | `auto` | How the image gets verifiable provenance: `auto` (public repo → GitHub attestations, private repo → cosign keyless), `github`, `cosign`, `none` |
| `push-attestations` | `"false"` | Legacy override: `"true"` forces GitHub attestations regardless of visibility (only works where GitHub Artifact Attestations exist) |
| `slsa-build-level` | *(none)* | Target SLSA build level for provenance generation |
| `slsa-signer-workflow` | *(none)* | Reusable workflow identity used to verify artifact attestations with `gh attestation verify` |

Use `secrets: inherit` in the caller (as in the example above) rather than declaring individual secrets — this workflow reads whatever registry/signing secrets it needs from the caller's own repo/environment secrets at the names it expects.

## Jobs

- **🏗️ pr-build** — builds and pushes a preview image for an open PR (e.g. `ghcr.io/<owner>/<repo>/pr/<PR-number>:<branch-sha7>`).
- **🗑️ pr-delete** — cleans up the preview image when the PR closes.
- **🧱 ref-build** — builds on every push to the default branch (floating `:main` + immutable `:main-<sha7>` tags).
- **🏷️ release** — builds and publishes a release on a `v*` tag push, optionally mirroring to Docker Hub.
- **📝 github-release** — updates the GitHub Release notes with the verified image/digest/attestation details.
- **🛡️ slsa** — verifies the build's provenance with [`ohanalabs-ai/actions/docker/slsa-report`](https://github.com/ohanalabs-ai/actions/tree/main/docker/slsa-report) and reports which mechanism attested the digest. Outcomes: ✅ **verified** (`github` or `cosign`) · ❕ **not attested — informational** (`attestation-mode: none`, or a private repo on the old GitHub-only path) · ❌ **verification failed** (an attestation exists but does not match the signer — the only red case).

## Prerequisites for a calling repo

1. A `docker-compose.yaml` (or the name passed via `docker-compose-file-name`) with at least one buildable service.
2. Registry credentials available to the caller — either the default `GITHUB_TOKEN` for `ghcr.io` (already permitted via `secrets: inherit`), or explicit Docker Hub credentials if mirroring there.
3. For SLSA attestation: the repo's Actions permissions must allow `id-token: write` and `attestations: write` (set in the caller's `permissions:` block, not this reusable workflow's own — a caller must grant them explicitly per GitHub's reusable-workflow permission model).

## Build provenance: public vs private repositories

| Caller repo | Mechanism (`attestation-mode: auto`) | Produced in the build job | Consumers verify with |
|---|---|---|---|
| **public** | GitHub Artifact Attestations | `actions/attest-build-provenance` + `attest-sbom`, pushed to GHCR | `gh attestation verify oci://<image>@<digest> --repo <owner/repo> --signer-workflow ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml` |
| **private** | cosign keyless (Sigstore) | `cosign sign` + `cosign attest --type slsaprovenance1` (+ `spdxjson` SBOM) on the digest, OIDC identity = this reusable workflow | `cosign verify --certificate-identity-regexp '^https://github.com/ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@' --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>@<digest>` |

**Why two mechanisms — and do we need to enable anything at the org?** GitHub Artifact
Attestations on a **private** repository are a **GitHub Enterprise Cloud** feature. There is
no org-level toggle: on a Team/Free org a private repo simply gets `HTTP 404` from the
attestations API — the failure in [ohanalabs-ai/vault-mcp-server run 35250882375](https://github.com/ohanalabs-ai/vault-mcp-server/actions/runs/35250882375/job/105305470285),
while the identical pipeline passes on the public [marcellodesales/mcp-brasil run 35491108003](https://github.com/marcellodesales/mcp-brasil/actions/runs/35491108003).
Nothing to flip at org level; either move to Enterprise Cloud (then set `attestation-mode: github` or `push-attestations: "true"`) or rely on cosign keyless, which this
pipeline now does automatically for private repos. Both satisfy the platform rule that
every `ohanalabs-ai` / `planeodev` image carries verifiable provenance; deployers can
`WARN`/fail on images that verify with neither command.

## Provenance note

This is the same reusable workflow already used in production today (e.g. every PR to `vionix-proj/alohomora` produces a preview image, and merges to its default branch produce `:main`/`:main-<sha7>` tags, through this exact pipeline) — this README documents an existing, already-verified workflow under the `products/` convention; it does not change its behavior.
