# github-platform

Reusable GitHub Actions workflows for organization-wide automation. (Formerly
`shared-workflows` — this repo was renamed; update any bookmarked
`vionix-proj/shared-workflows/...` `uses:` references to `vionix-proj/github-platform/...`.)

## Products

Each reusable workflow has its own usage doc under `products/`:

- [`products/devsecops-docker/`](products/devsecops-docker/README.md) — `docker-multiarch-cicd.yaml`
- [`products/devsecops-terraform/`](products/devsecops-terraform/README.md) — `terraform-devsecops-workflow.yaml`
- [`products/devsecops-github/`](products/devsecops-github/README.md) — GitHub repo-hygiene workflows (multiple capabilities, one per file under its own `capabilities/`), e.g. `github-team-codeowners-actions.yaml`
- [`products/devsecops-gitops/`](products/devsecops-gitops/README.md) — `gitops-argocd-group.yaml` + `gitops-argocd-gate.yaml`: per-ArgoCD-Application rendered diff (kustomize / render plugin / `helm template` for multi-source apps), live `argocd app diff` verdicts (a no-op cannot merge), sticky PR comments, post-merge validation + GitHub Deployments; built from the composite actions under [`actions/gitops/`](actions/README.md)
- [`products/devsecops-kubernetes/`](products/devsecops-kubernetes/README.md) — `kubernetes-kustomize-devsecops.yaml`: **will these manifests actually run?** — `kustomize build --enable-helm`, kubeconform (Kubernetes + CRD catalog), removed APIs, and **image availability** (manifest + digest + required platform, auth profiles anonymous / ghcr `GITHUB_TOKEN` / GCP); also the `🧪 kustomize check` job of `gitops-argocd-group.yaml`, the pre-condition of the ArgoCD gate; built from [`actions/kubernetes/manifest-check/`](actions/kubernetes/manifest-check/README.md)
- [`products/devsecops-scripted/`](products/devsecops-scripted/README.md) — `scripted-phase.yaml`: **preview, then approve, then apply** for a scripted phase (a repo's `workflow_dispatch` that runs a script against a live cluster/Vault): a `🔍 preview` job with no Environment whose read-only output (step summary + artifact + sticky PR comment — a plan manifest rendered like the Terraform plan comment: `N to add, M to change, K to destroy`, one redacted diff per resource) is what the reviewer approves, then a `🚀 apply` job in the gated Environment that re-prints the approved preview and runs the command; built from [`actions/scripted/`](actions/README.md)

Composite actions this repo's workflows are built from live under [`actions/`](actions/README.md) (`actions/<category>/<name>/action.yaml`); the older standalone library is `ohanalabs-ai/actions` — see that README for the consolidation target.

## Reusable workflow: `docker-multiarch-cicd`

This workflow preserves the original multi-job Docker pipeline (PR build, PR cleanup, publish-on-merge, and tag release) while exposing top-level environment values as `workflow_call` inputs.

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
    uses: vionix-proj/github-platform/.github/workflows/docker-multiarch-cicd.yaml@main
    with:
      registry: ghcr.io
      target-service: gha-fix
      platforms: linux/amd64,linux/arm64
      docker-compose-file-name: docker-compose.yaml
      dockerhub-registry: docker.io
      dockerhub-namespace: ${{ github.repository_owner }}
      # attestation-mode: auto  # public repo → GitHub attestations, private repo → vault (with vault-url + transit-key) else none (see products/devsecops-docker)
    secrets: inherit
```

### Inputs

- `registry` (default: `ghcr.io`)
- `target-service` (default: `gha-fix`)
- `platforms` (default: `linux/amd64,linux/arm64`)
- `docker-compose-file-name` (default: `docker-compose.yaml`)
- `dockerhub-registry` (default: `docker.io`)
- `dockerhub-namespace` (default: `${{ github.repository_owner }}`)
- `attestation-mode` (default: `auto`) — public repo → GitHub attestations; private repo → `vault` (our Vault Transit key via `vault-url` + `vault-role` + `transit-key`, no Rekor) else `none`; `github` / `vault` / `cosign` (keyless — explicit opt-in, writes to the PUBLIC Rekor log) / `none` to force
- `push-attestations` (default: `"false"`) — legacy override forcing GitHub attestations
