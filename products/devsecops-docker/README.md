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
      # attestation-mode: auto   # default — public repo: GitHub attestations; private repo: vault (below) or none
    secrets: inherit
```

Private repository signing with the org's **Vault Transit key** (`attestation-mode: vault`, the
`auto` default once `vault-url` + `transit-key` are set). The caller grants `id-token: write`,
names its per-branch Vault role, and passes the tailnet secrets **explicitly** (Vault is
tailnet-only; `secrets: inherit` does not cross orgs):

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  push:
    branches: [main, develop]   # the push build of the merge commit is the one that signs

jobs:
  docker-multiarch:
    uses: ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@main
    permissions: { contents: write, packages: write, id-token: write, attestations: write, artifact-metadata: write, pull-requests: write }
    with:
      docker-compose-file-name: docker-compose.yaml
      vault-url: ${{ vars.VAULT_ADDR }}                         # https://vault.platform.planeo.dev
      vault-role: gha-${{ github.event.repository.name }}-${{ github.ref_name }}   # bound to repository + ref
      transit-key: ${{ github.repository_owner }}-ci-images      # planeodev-ci-images | ohanalabs-ai-ci-images
      join-tailscale: true
    secrets:
      TS_OAUTH_CLIENT_ID: ${{ secrets.TS_OAUTH_CLIENT_ID }}
      TS_OAUTH_SECRET: ${{ secrets.TS_OAUTH_SECRET }}
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
| `attestation-mode` | `auto` | How the image gets verifiable provenance: `auto` (public repo → GitHub attestations; private repo → `vault` when `vault-url` + `transit-key` are set, else `none`), `github`, `vault`, `cosign` (**explicit opt-in only — keyless Sigstore writes the private repo's name, workflow and digests to the PUBLIC Rekor transparency log**), `none` |
| `vault-url` | `""` | Vault address for `vault` mode (tailnet-only for our orgs → also `join-tailscale`) |
| `vault-auth-path` | `github-jwt` | Vault JWT auth mount bound to GitHub's OIDC issuer |
| `vault-role` | `""` | JWT role the build job logs in as — bound to `repository` + `ref`, carrying `ci-image-signer-<org>` (convention `gha-<repo>-<branch>`) |
| `vault-jwt-audience` | `https://github.com/<owner>` | `aud` of the OIDC token; must be in the role's `bound_audiences` |
| `vault-ca-cert` | `""` | Optional base64 PEM CA bundle for a Vault behind a private CA |
| `transit-key` | `""` | Transit signing key, one per org: `planeodev-ci-images`, `ohanalabs-ai-ci-images` |
| `transit-path` | `transit` | Transit mount path |
| `vault-signing-refs` | `refs/heads/main,refs/heads/develop` | Refs whose build signs (exact or trailing-`*` prefix). `pull_request` events never sign. Tag releases sign only if you add e.g. `refs/tags/v*` **and** a Vault role bound to those refs |
| `join-tailscale` | `false` | Join the tailnet before the Vault login (needs secrets `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET`) |
| `tailscale-tags` / `tailscale-args` | `tag:ci` / `--accept-routes` | Tailnet node tags / `tailscale up` flags |
| `push-attestations` | `"false"` | Legacy override: `"true"` forces GitHub attestations regardless of visibility (only works where GitHub Artifact Attestations exist) |
| `slsa-build-level` | *(none)* | Target SLSA build level for provenance generation |
| `slsa-signer-workflow` | *(none)* | Reusable workflow identity used to verify artifact attestations with `gh attestation verify` |

Use `secrets: inherit` in the caller (as in the example above) rather than declaring individual secrets — this workflow reads whatever registry/signing secrets it needs from the caller's own repo/environment secrets at the names it expects. **Exception:** the tailnet secrets `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` (vault mode with `join-tailscale`) must be passed explicitly — `secrets: inherit` does not deliver a caller org's selected-repository secrets to a workflow hosted in another org.

## Outputs

| Output | Set by | Description |
|---|---|---|
| `image_ref` | PR, ref or release build | Digest-pinned reference of the image this run built: `<base>/pr/<N>@sha256:…` on a PR, `<base>@sha256:…` on a branch or tag. Empty when nothing was built (closed PR) |
| `image_digest` | PR, ref or release build | The `sha256:…` digest of that image |
| `image_tag`, `image_base`, `short_sha`, `effective_ref` | ref build only | Unchanged legacy outputs of the branch build |
| `signed` | ref or release build (`vault` mode) | `"true"` when the digest was signed + attested with the Vault Transit key and the round trip verified |
| `signature_key_ref` | ref or release build (`vault` mode) | `hashivault://<transit-key>`; empty when not signed |

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
- **🛡️ slsa** — verifies the build's provenance with [`ohanalabs-ai/actions/docker/slsa-report`](https://github.com/ohanalabs-ai/actions/tree/main/docker/slsa-report) (`github`/`cosign`) or, in `vault` mode, with [`actions/docker/vault-sign/verify.ts`](../../actions/docker/vault-sign/) — **no Vault access in this job**: the build's exported public key, `cosign verify` + `cosign verify-attestation --type slsaprovenance1 --policy <the org's approved-build CUE>` (the same checks the clusters' policy-controller makes). Outcomes: ✅ **verified** (`github`, `cosign` or `vault`) · ❕ **not attested — informational** (`none`, a PR / merged-PR build, or a ref outside `vault-signing-refs`) · ❌ **verification failed** (an attestation exists but does not match — the only red case).

## Prerequisites for a calling repo

1. A `docker-compose.yaml` (or the name passed via `docker-compose-file-name`) with at least one buildable service.
2. Registry credentials available to the caller — either the default `GITHUB_TOKEN` for `ghcr.io` (already permitted via `secrets: inherit`), or explicit Docker Hub credentials if mirroring there.
3. For SLSA attestation: the repo's Actions permissions must allow `id-token: write` and `attestations: write` (set in the caller's `permissions:` block, not this reusable workflow's own — a caller must grant them explicitly per GitHub's reusable-workflow permission model).

## Build provenance: public vs private repositories

| Caller repo | Mechanism (`attestation-mode: auto`) | Produced in the build job | Consumers verify with |
|---|---|---|---|
| **public** | GitHub Artifact Attestations | `actions/attest-build-provenance` + `attest-sbom`, pushed to GHCR | `gh attestation verify oci://<image>@<digest> --repo <owner/repo> --signer-workflow ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml` |
| **private** + `vault-url`/`transit-key` | **Vault Transit** (our key, `vault`) | in 🧱 ref-build / 🏷️ release only, never on `pull_request`: `hashicorp/vault-action` (JWT, role bound to repo + ref) → `cosign sign --recursive` + `cosign attest --type slsaprovenance1` (+ `spdxjson`) with `--key hashivault://<org>-ci-images`, **no transparency log**; then a round-trip verify with the exported public key | `cosign verify --key <org>.pub --insecure-ignore-tlog=true <image>@<digest>` and `cosign verify-attestation --key <org>.pub --insecure-ignore-tlog=true --type slsaprovenance1 <image>@<digest>` (the org's public key: `cosign public-key --key hashivault://<org>-ci-images`, or the copy pinned in the cluster) |
| **private**, no Vault inputs | none (❕) | — | — |
| any, `attestation-mode: cosign` (opt-in) | cosign keyless (Sigstore) — **writes to the public Rekor log** | `cosign sign` + `cosign attest --type slsaprovenance1` (+ `spdxjson` SBOM) on the digest, OIDC identity = this reusable workflow | `cosign verify --certificate-identity-regexp '^https://github.com/ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@' --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>@<digest>` |

### The `vault` provenance (what admission checks)

[`actions/docker/vault-sign/provenance.ts`](../../actions/docker/vault-sign/provenance.ts) builds the SLSA v1 predicate
(GitHub's buildType `https://actions.github.io/buildtypes/workflow/v1`) from the job's **OIDC token
claims** — the same claims Vault validated before it allowed the sign:

| Field | Value | Source |
|---|---|---|
| `runDetails.builder.id` | `https://github.com/ohanalabs-ai/github-platform/.github/workflows/docker-multiarch-cicd.yaml@<ref the caller pinned>` | claim `job_workflow_ref` — the **reusable** workflow. Not `GITHUB_WORKFLOW_REF` / `github.workflow_ref`: inside a reusable those are the **caller's** workflow (the bug the keyless jq predicate had — planeo-infra SLSA self-assessment E-S5) |
| `buildDefinition.externalParameters.workflow` | `{repository: https://github.com/<owner>/<repo>, ref: refs/heads/<branch>, path: .github/workflows/<caller>.yaml}` | claims `repository`, `ref`, `workflow_ref` (an object, as the admission CUE expects — not a string) |
| `resolvedDependencies[0]` | `git+https://github.com/<owner>/<repo>@<ref>` + `gitCommit` | claims `ref`, `sha` |

The planeo-infra `ClusterImagePolicy` `<org>-approved-build` CUE asserts exactly these fields
(`repository` in the org, `ref` main|develop, `path` a workflow file, `builder.id` this reusable);
the build and the 🛡️ slsa job evaluate the same CUE with `cosign verify-attestation --policy`.
Signatures and attestations use the classic `sha256-<digest>.sig` / `.att` tags (cosign v3 needs
`--use-signing-config=false --new-bundle-format=false` for that and to keep Rekor out — chosen by
cosign major version).

**Why two mechanisms — and do we need to enable anything at the org?** GitHub Artifact
Attestations on a **private** repository are a **GitHub Enterprise Cloud** feature. There is
no org-level toggle: on a Team/Free org a private repo simply gets `HTTP 404` from the
attestations API — the failure in [ohanalabs-ai/vault-mcp-server run 35250882375](https://github.com/ohanalabs-ai/vault-mcp-server/actions/runs/35250882375/job/105305470285),
while the identical pipeline passes on the public [marcellodesales/mcp-brasil run 35491108003](https://github.com/marcellodesales/mcp-brasil/actions/runs/35491108003).
Nothing to flip at org level; either move to Enterprise Cloud (then set `attestation-mode: github` or `push-attestations: "true"`) or sign with the org's Vault Transit key (`vault`), which `auto` picks for a private repo that passes `vault-url` + `transit-key`. Keyless cosign is no longer automatic: it would publish private repository identities to the public Rekor log. Both satisfy the platform rule that
every `ohanalabs-ai` / `planeodev` image carries verifiable provenance; deployers can
`WARN`/fail on images that verify with neither command.

## Provenance note

This is the same reusable workflow already used in production today (e.g. every PR to `vionix-proj/alohomora` produces a preview image, and merges to its default branch produce `:main`/`:main-<sha7>` tags, through this exact pipeline) — this README documents an existing, already-verified workflow under the `products/` convention; it does not change its behavior.
