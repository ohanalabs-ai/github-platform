# github-platform

Reusable GitHub Actions workflows for organization-wide automation. (Formerly
`shared-workflows` — this repo was renamed; update any bookmarked
`vionix-proj/shared-workflows/...` `uses:` references to `vionix-proj/github-platform/...`.)

## Products

Each reusable workflow has its own usage doc under `products/`:

- [`products/devsecops-docker/`](products/devsecops-docker/README.md) — `docker-multiarch-cicd.yaml`
- [`products/devsecops-terraform/`](products/devsecops-terraform/README.md) — `terraform-devsecops-workflow.yaml`
- [`products/devsecops-github/`](products/devsecops-github/README.md) — GitHub repo-hygiene workflows (multiple capabilities, one per file under its own `capabilities/`), e.g. `github-team-codeowners-actions.yaml`

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
      push-attestations: "false"
    secrets: inherit
```

### Inputs

- `registry` (default: `ghcr.io`)
- `target-service` (default: `gha-fix`)
- `platforms` (default: `linux/amd64,linux/arm64`)
- `docker-compose-file-name` (default: `docker-compose.yaml`)
- `dockerhub-registry` (default: `docker.io`)
- `dockerhub-namespace` (default: `${{ github.repository_owner }}`)
- `push-attestations` (default: `"false"`)
