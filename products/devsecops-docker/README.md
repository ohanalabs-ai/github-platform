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
      # attestation-mode: auto   # default — public repo: GitHub attestations; private repo: none here → docker-image-attest.yaml
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
| `docker-compose-context` | `.` | **Overrides the bake target's build context** (`<target>.context=<this>`), replacing the service's `build.context` from the compose file. In a monorepo set it to exactly that service's `build.context` (e.g. `./src/frontend`) — the default `.` makes the build look for `./Dockerfile` at the repo root |
| `docker-compose-file-name` | `docker-compose.yaml` | Compose file used by `docker buildx bake` |
| `docker-compose-target-service` | *(none)* | Bake target service name — only needed if the compose file defines more than one service |
| `image-name-suffix` | `""` | Path suffix for monorepos publishing multiple images from one repo (e.g. `api` → `ghcr.io/<owner>/<repo>/api`). Empty preserves the legacy one-image-per-repo name. On Docker Hub the suffix is joined with a dash instead, since Docker Hub only allows one path segment |
| `dockerhub-registry` | `docker.io` | Optional Docker Hub registry hostname for release mirroring |
| `dockerhub-namespace` | `${{ github.repository_owner }}` | Optional Docker Hub namespace for release mirroring |
| `dockerhub-registry-username` | *(none)* | Optional Docker Hub username, for mirroring a release build |
| `dockerhub-registry-token` | *(none)* | Optional Docker Hub token, for mirroring a release build — pass as `${{ secrets.DOCKERHUB_TOKEN }}` from the caller |
| `attestation-mode` | `auto` | How the image gets verifiable provenance **in the build**: `auto` (public repo → GitHub attestations; private repo → `none` — sign with the org's key in a following [`docker-image-attest.yaml`](#sign-with-the-orgs-key-build--scan--attest) job), `github`, `cosign` (**explicit opt-in only: keyless Sigstore writes the private repo's name, workflow and digests to the PUBLIC Rekor log**), `none` |
| `push-attestations` | `"false"` | Legacy override: `"true"` forces GitHub attestations regardless of visibility (only works where GitHub Artifact Attestations exist) |
| `slsa-build-level` | *(none)* | Target SLSA build level for provenance generation |
| `slsa-signer-workflow` | *(none)* | Reusable workflow identity used to verify artifact attestations with `gh attestation verify` |

Use `secrets: inherit` in the caller (as in the example above) rather than declaring individual secrets — this workflow reads whatever registry/signing secrets it needs from the caller's own repo/environment secrets at the names it expects.

## Outputs

| Output | Set by | Description |
|---|---|---|
| `image_ref` | PR, ref or release build | Digest-pinned reference of the image this run built: `<base>/pr/<N>@sha256:…` on a PR, `<base>@sha256:…` on a branch or tag. Empty when nothing was built (closed PR) |
| `image_digest` | PR, ref or release build | The `sha256:…` digest of that image |
| `build_identity` | ref or release build | The build job's identity for provenance: base64(JSON) of its GitHub OIDC claims (`repository`, `ref`, `sha`, `workflow_ref`, `job_workflow_ref` = this reusable, `run_id`, …) — never the token. Feed it with `image_ref` to `docker-image-attest.yaml`. Empty on PR builds or without `id-token: write` |
| `builder_id` | ref or release build | The `builder.id` the provenance will carry (`https://github.com/ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@<ref>`) |
| `image_tag`, `image_base`, `short_sha`, `effective_ref` | ref build only | Unchanged legacy outputs of the branch build |

## Compose an image scan after the build

Keep the scan a separate job in the caller that `needs` the build, so an image is scanned only
after its build succeeded, and a policy failure fails the run (shift-left):

```yaml
jobs:
  docker:
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@main
    # … with: as above
  scan:
    name: 🛡️ scan
    needs: docker
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-images-devsecops-scan.yaml@main
    permissions: { contents: read, packages: read }
    with:
      images: ${{ needs.docker.outputs.image_ref }}
      severity-threshold: CRITICAL   # accept everything below CRITICAL
      options: '{"version":1,"allow-empty":true}'   # a closed PR builds nothing → nothing to scan
      artifact-prefix: imgsec
```

Keep the caller thin — only `needs`, `uses`, `permissions` and `with`. The policy decision and the
failure live inside the scan reusable: its report job exits non-zero on `policy-fail`, so the run
goes red there (shift-left). An empty `image_ref` (closed PR) is handled by the scanner's own
`allow-empty` option, not by a caller-side `if:`.

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

## Planeo deploy stamp (scan + attest) — ONE job after any build

Owner rule (2026-10-13): **scan + attestation is what every repository adds to meet the security
posture.** [`docker-scan-attest.yaml`](../../.github/workflows/docker-scan-attest.yaml) bundles it:
`docker-image-security` (scan) → `docker-image-attest` (SLSA provenance + SBOM with the org's Vault
Transit key, no public log) → a `📋 summary` that classifies the image's proofs. Add one job after the
build — nothing else changes in the caller:

```yaml
  scan-attest:
    needs: build                       # the job calling docker-multiarch-cicd.yaml
    permissions: { contents: read, packages: write, id-token: write, attestations: read, pull-requests: write }
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-scan-attest.yaml@main
    with:
      image: ${{ needs.build.outputs.image_ref }}
      build-identity: ${{ needs.build.outputs.build_identity }}
      builder-id: ${{ needs.build.outputs.builder_id }}
      tailscale-oauth-client-id: ${{ vars.TS_FEDERATED_CLIENT_ID }}   # org variables (identifiers, not secrets)
      tailscale-audience: ${{ vars.TS_FEDERATED_AUDIENCE }}
      # severity-threshold: CRITICAL    # default NONE = report-only; a failed gate = no stamp
```

**Classification** (shown in every run's summary):

| Proof | Made by | When | Ledger | Trusted by |
|---|---|---|---|---|
| 🌐 **public provenance** | the build (`docker-multiarch-cicd`, `attestation-mode: auto`) | PUBLIC repositories | public Sigstore Rekor (GitHub artifact attestation) | anyone — `gh attestation verify`; **not** Planeo admission |
| 🔏 **Planeo deploy stamp** | `docker-scan-attest` (scan + Vault attest) | push / `workflow_dispatch` on a signing ref (default `main`, `develop`) | none public (Vault Transit; a private Vionix Rekor later — INTEGRATE-32) | **Planeo admission** (`<org>-approved-build` ClusterImagePolicy) |

A public repo gets **both**; a private repo gets the deploy stamp only. Pull requests are scanned (and
PR-commented) but never stamped — the push build of the merge is. A push/dispatch on a signing ref that
ends **without** a stamp fails the summary job (the stamp was expected). Secretless: the tailnet join
uses the org's Tailscale OIDC federated identity and the Vault login GitHub OIDC (role
`gha-<org>-image-signer`); the repo needs no secret. Outputs: `stamped`, `key-ref`, `scan-status`.

## Sign with the org's key: build → scan → attest

The builder only needs registry credentials. Signing is its own reusable,
[`docker-image-attest.yaml`](../../.github/workflows/docker-image-attest.yaml) (Jira INTEGRATE-29):
cosign `--key hashivault://<org>-ci-images` (Vault Transit — the private key never leaves Vault),
**no transparency log**, a round-trip verification with the exported public key, and an independent
🛡️ verify job with no Vault access. It needs the build's `image_ref` and `build_identity`:

```yaml
permissions: { contents: write, packages: write, id-token: write, attestations: write, artifact-metadata: write, pull-requests: write }
jobs:
  docker:
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@main
    with: { docker-compose-file-name: docker-compose.yaml }   # private repo → attestation-mode auto = none
    secrets: inherit
  scan:
    needs: docker
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-image-security.yaml@main
    with: { image: "${{ needs.docker.outputs.image_ref }}" }
  attest:
    needs: [docker, scan]
    if: needs.docker.outputs.build_identity != ''        # PR builds never sign
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-image-attest.yaml@main
    permissions: { contents: read, packages: write, id-token: write }
    with:
      image: ${{ needs.docker.outputs.image_ref }}
      build-identity: ${{ needs.docker.outputs.build_identity }}
      vault-url: https://vault.platform.planeo.dev
      join-tailscale: true                                     # Vault is tailnet-only
      tailscale-oauth-client-id: ${{ vars.TS_FEDERATED_CLIENT_ID }}   # identifiers, not secrets
      tailscale-audience: ${{ vars.TS_FEDERATED_AUDIENCE }}
      # vault-role / transit-key default to gha-<org>-image-signer / <org>-ci-images
```

**Why the provenance names the BUILD workflow.** The clusters' admission CUE (planeo-infra
`clusters/base/hooks/policy/clusterimagepolicy-<org>.yaml`) asserts `builder.id` =
`docker-multiarch-cicd.yaml@…`. The attest job runs as a different reusable, so its own OIDC
`job_workflow_ref` is never the builder: the build job captures its identity (`build_identity`) and
the attest job **binds** it to its own token — same repository, commit, ref and run — before writing
it into the predicate. A caller cannot feed a foreign identity in. The org-wide Vault role
(`gha-<org>-image-signer`, planeo-infra #399) binds the org's numeric id, the branch and the event,
**not** `job_workflow_ref`, so this reusable is allowed to sign.

**Vendor images** (not built by us — INTEGRATE-31, future): scan → attest with `mode: vuln`
(`vuln-predicate-artifact` + `vuln-predicate-path` from the scan job, `transit-key: <org>-image-scan`,
`cosign-repository` when we cannot push next to the image).

| `docker-image-attest.yaml` input | Default | |
|---|---|---|
| `image` | — | `<registry>/<repo>@sha256:…` (the builder's `image_ref`) |
| `mode` | `provenance` | `provenance` (signature + SLSA v1 + SPDX SBOM) · `vuln` (a scan result) |
| `build-identity` | `""` | the builder's `build_identity` (mode provenance) |
| `vault-url` / `vault-role` / `transit-key` | — / `gha-<owner>-image-signer` / `<owner>-ci-images` | Vault login + key |
| `join-tailscale` + `tailscale-oauth-client-id` + `tailscale-audience` | `false` | secretless tailnet join (org variables `TS_FEDERATED_*`) |
| `signing-refs` | `refs/heads/main,refs/heads/develop` | refs whose runs may sign; `pull_request` never signs |
| outputs | | `signed`, `key-ref`, `public-key-b64`, `builder-id` |

## Signing canary — prove an org's chain, or sign any digest

[`vionix-signing-canary.yaml`](../../.github/workflows/vionix-signing-canary.yaml) is the on-demand
end-to-end test of the chain above, and a "sign anything" request:

| mode | what it does | proves |
|---|---|---|
| `image` | builds a throwaway image from the caller's `canary/vionix-signing/` (one `FROM scratch` file) with the **real** builder → scan (report-only) → attest (provenance + SBOM, the org's Transit key, no tlog) → **re-verifies with only the exported public key + the approved-build CUE** | tailnet join (Tailscale OIDC federated identity) → Vault login (`gha-<org>-image-signer`) → Transit signing → admission-equivalent verification, with no Vault and no cluster in the verify step |
| `digest` | signs a canonical statement `{subject{name,digest}, signer{repository,ref,sha,run_id,workflow}, key, signed_at}` with the org's Transit key and verifies it locally with the public half ([`sign-digest`](../../actions/secrets/vault/sign-digest/)) | "sign anything": any `sha256:` (an image, a file, a release) — outputs `statement-b64`, `signature` (`vault:v<N>:…`), `public-key-b64` |

The `📋 summary` job always renders every stage (pass/fail + facts). Signing needs a **branch run on
`main`/`develop` by `workflow_dispatch` or `push`** — what the org-wide Vault role accepts (a
`schedule` run cannot sign, and the builder's ref build does not run on `schedule`, so the canary is
dispatched, not scheduled). Callers live in each org:

| org | caller | dispatch |
|---|---|---|
| ohanalabs-ai | [`vionix-signing-canary-ohanalabs-ai.yaml`](../../.github/workflows/vionix-signing-canary-ohanalabs-ai.yaml) (this repo) | `gh workflow run vionix-signing-canary-ohanalabs-ai.yaml -R ohanalabs-ai/github-platform --ref main` |
| planeodev | `planeodev/planeo-infra` `.github/workflows/vionix-signing-canary.yml` | `gh workflow run vionix-signing-canary.yml -R planeodev/planeo-infra --ref develop` |

Sign a digest: `gh workflow run <caller> -R <repo> --ref <main|develop> -f mode=digest -f subject-digest=sha256:<64 hex> -f subject-name=<what it is>`.

## Build provenance: public vs private repositories

| Caller repo | Mechanism (`attestation-mode: auto`) | Produced in the build job | Consumers verify with |
|---|---|---|---|
| **public** | GitHub Artifact Attestations | `actions/attest-build-provenance` + `attest-sbom`, pushed to GHCR | `gh attestation verify oci://<image>@<digest> --repo <owner/repo> --signer-workflow ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml` |
| **private** | `none` in the build → the org's Vault Transit key in [`docker-image-attest.yaml`](#sign-with-the-orgs-key-build--scan--attest) | `cosign sign` + `cosign attest --type slsaprovenance1` (+ `spdxjson`), no Rekor, builder identity from `build_identity` | `cosign verify --key <org>.pub --insecure-ignore-tlog=true <image>@<digest>` + `cosign verify-attestation --type slsaprovenance1` (what the clusters' policy-controller does) |
| private, `attestation-mode: cosign` (opt-in) | cosign keyless (Sigstore, **public Rekor**) | `cosign sign` + `cosign attest` with this workflow's OIDC identity | `cosign verify --certificate-identity-regexp '^https://github.com/ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@' --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>@<digest>` |

**Why two mechanisms — and do we need to enable anything at the org?** GitHub Artifact
Attestations on a **private** repository are a **GitHub Enterprise Cloud** feature. There is
no org-level toggle: on a Team/Free org a private repo simply gets `HTTP 404` from the
attestations API — the failure in [ohanalabs-ai/vault-mcp-server run 35250882375](https://github.com/ohanalabs-ai/vault-mcp-server/actions/runs/35250882375/job/105305470285),
while the identical pipeline passes on the public [marcellodesales/mcp-brasil run 35491108003](https://github.com/marcellodesales/mcp-brasil/actions/runs/35491108003).
Nothing to flip at org level; either move to Enterprise Cloud (then set `attestation-mode: github` or `push-attestations: "true"`) or sign with the org's own key in
`docker-image-attest.yaml` (the private-repo default since INTEGRATE-29; keyless cosign stays an explicit opt-in because it publishes to the public Rekor log). Both satisfy the platform rule that
every `ohanalabs-ai` / `planeodev` image carries verifiable provenance; deployers can
`WARN`/fail on images that verify with neither command.

## Provenance note

This is the same reusable workflow already used in production today (e.g. every PR to `vionix-proj/alohomora` produces a preview image, and merges to its default branch produce `:main`/`:main-<sha7>` tags, through this exact pipeline) — this README documents an existing, already-verified workflow under the `products/` convention; it does not change its behavior.
