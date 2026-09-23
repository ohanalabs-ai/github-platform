# actions

Composite actions (`actions/<category>/<name>/action.yaml` + the script it runs + a README) that this repo's reusable workflows are built from. Each is also runnable by hand — the script is plain bash.

| Category | Action | Used by |
|---|---|---|
| `gitops/` | [`toolchain`](gitops/toolchain/) · [`discover-units`](gitops/discover-units/) · [`render-diff`](gitops/render-diff/) · [`kustomize-tree`](gitops/kustomize-tree/) · [`argocd-diff`](gitops/argocd-diff/) · [`argocd-refresh`](gitops/argocd-refresh/) · [`group-report`](gitops/group-report/) · [`gate-summary`](gitops/gate-summary/) | [`gitops-argocd-group.yaml`](../.github/workflows/gitops-argocd-group.yaml), [`gitops-argocd-gate.yaml`](../.github/workflows/gitops-argocd-gate.yaml) — [devsecops-gitops](../products/devsecops-gitops/README.md) |

## Two homes, one target

Org composites currently live in two places: **`ohanalabs-ai/actions`** (`docker/*`, `github/*`, `cloud-native/*`, `ai/*` — the former vionix library, referenced by `docker-multiarch-cicd.yaml` and others) and **this directory**. Nothing was moved when `actions/` was created here (2026-09-22, for devsecops-gitops). The intended model, as the `github-actions-cicd` skill in `planeodev/claude-agents` states: a composite that a `github-platform` reusable workflow is built from lives **here**, reviewed and released with that workflow (callers track `@main`); `ohanalabs-ai/actions` keeps the standalone actions until each is consolidated here on its own PR. New composites go here.

## Conventions

- Emoji `name:` on the steps; every third-party `uses:` pinned to a commit SHA with a version comment; org-owned references at `@main`.
- The reusable workflows check out this repo at their own commit (`job.workflow_sha`) and call the actions as `./.gitops-platform/actions/<category>/<name>`, so a workflow on a feature branch runs that branch's actions.
- Every script has a header documenting its arguments/environment and is covered by `tests/` (`tests/gitops/run-tests.sh`) and the matching `*-selftest.yaml` workflow.
