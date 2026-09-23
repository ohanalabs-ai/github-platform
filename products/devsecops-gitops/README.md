# devsecops-gitops

Reusable GitOps checks for repositories that ArgoCD syncs to a live cluster: **a pull request shows exactly what a merge will apply, per ArgoCD `Application`, and a no-op cannot merge**; after the merge the same units are hard-refreshed and the merged SHA is proven live, recorded as a GitHub Deployment.

Two reusable workflows plus the composite actions they are built from:

| File | Role |
|---|---|
| [`.github/workflows/gitops-argocd-group.yaml`](../../.github/workflows/gitops-argocd-group.yaml) | ONE group of Applications on ONE cluster: `🧭 discover` → `🧩 render <app>` → `🔍 diff <app>` (mode=diff) / `♻️ refresh <app>` (mode=refresh) → `📋 result` (sticky comment, group.json, Deployment) |
| [`.github/workflows/gitops-argocd-gate.yaml`](../../.github/workflows/gitops-argocd-gate.yaml) | the gate over a caller's group jobs: results table + consolidated summary (table, one Mermaid, "Merging this PR will …"), one sticky comment per scope, fails if any group failed |
| [`actions/gitops/*`](../../actions/gitops/) | `toolchain` · `discover-units` · `render-diff` · `kustomize-tree` · `argocd-diff` · `argocd-refresh` · `group-report` · `gate-summary` — each `action.yaml` + the script it runs + a README; runnable by hand (see *Local run*) |

It replaced two copies of the same flow — `planeodev/planeo-infra`'s `_gitops-group.yml`/`_gitops-group-gate.yaml` (+ `clusters/{render-diff,kustomize-tree,gitops-group-report,gitops-gate-summary}.sh`) and `planeodev/customers`' `gitops-pr-diff.yml`/`gitops-sync.yml` (+ `scripts/gitops/*.sh`) — with thin callers. Every behaviour and verdict both had is preserved; two capabilities were added here only: the [`noop-live-equal`](capabilities/verdicts.md#noop-live-equal) verdict and the [multi-source `helm template` render](capabilities/multi-source-helm-template.md).

## Capabilities

- [`unit-contract`](capabilities/unit-contract.md) — the JSON a repo's discovery command prints; the only repo-specific piece.
- [`verdicts`](capabilities/verdicts.md) — every live verdict, its emoji, whether it passes, and the no-op policy + escape hatch.
- [`multi-source-helm-template`](capabilities/multi-source-helm-template.md) — how an Application with `spec.sources[]` (OCI/HTTP chart + `$values` + git path) gets a real rendered diff.
- [`prerequisites`](capabilities/prerequisites.md) — Vault (GitHub OIDC), tailnet, AWS, repo variables/secrets, the GitHub Environments and the required-status names.

## How it reads

```
PR
 ├─ <group job>  (uses: gitops-argocd-group.yaml, mode: diff)          ← one per group, static list
 │    🧭 discover        changed files ∩ watch-paths → units (discover-command)
 │    🧩 render <app>    kustomize | render plugin | helm template (multi-source): base vs head per object
 │    🔍 diff <app>      argocd app diff --revision <PR head> → verdict (blocks a noop)
 │    📋 result          table + sticky comment gitops-<cluster>-<group> + group.json
 └─ <scope> gate         (uses: gitops-argocd-gate.yaml) — the ONE required status per scope
merge
 └─ <group job>  (mode: refresh, GitHub Environment <cluster>-<group>)
      ♻️ refresh <app>   hard-refresh → sync.revision == SHA, Synced, Healthy → kubectl cross-check
      📋 result          GitHub Deployment success | failure | inactive (ArgoCD not configured)
```

## Inputs (`gitops-argocd-group.yaml`)

| Input | Default | Meaning |
|---|---|---|
| `cluster` | *(required)* | the cluster the units belong to — titles, artifact names, the refresh environment `<cluster>-<group>` |
| `group` | *(required)* | the group (tier) name; default ArgoCD project of the environment URL |
| `mode` | *(required)* | `diff` (pull request) · `refresh` (post-merge) |
| `watch-paths` | `""` (all) | multiline path globs for `tj-actions/changed-files` — scopes the group |
| `discover-command` | *(required)* | repo-local command printing the [unit contract](capabilities/unit-contract.md); the changed paths are appended as arguments |
| `render-plugin-script` | `""` | repo-relative Config Management Plugin script for units with `plugin: true` (rendered with placeholder `CHANGE_ME_*` values) |
| `kustomize-build-args` | `--enable-helm` | flags after `kustomize build` (add `--load-restrictor LoadRestrictionsNone` when overlays reference siblings above their directory) |
| `helm-kube-version` | `1.33.0` | `--kube-version` of the multi-source `helm template` |
| `planeo-labels` | `planeo.dev/cluster=<cluster>,planeo.dev/ci=true` | passed to the render plugin as `PLANEO_LABELS` |
| `attestation-command` | `""` | optional `<cmd> <unit-path>` printing `attested: N/M` after a render (WARN column) |
| `tools-image` | `""` | image shipping kustomize/helm/argocd/kubectl (pulled with the job's `GITHUB_TOKEN` on ghcr.io) → docker shims; empty → pinned releases |
| `kustomize-version` · `helm-version` · `argocd-version` · `kubectl-version` · `yq-version` | `5.8.1` · `3.16.3` · `3.5.3` · `1.36.2` · `4.45.1` | release pins when `tools-image` is empty (yq is always native) |
| `argocd-server` | `""` | the caller's `vars.ARGOCD_SERVER`; empty → live steps report *skipped-no-argocd* |
| `argocd-project` | the group | project of the environment URL |
| `vault-addr` | `""` | the caller's `vars.VAULT_ADDR`; empty → the `ARGOCD_AUTH_TOKEN` secret is the pre-Vault fallback |
| `vault-jwt-path` · `vault-jwt-audience` | `github-jwt` · `""` | the JWT auth mount and its bound audience |
| `vault-role-pr` · `vault-role-push` | `""` | roles for `mode=diff` (pull_request) / `mode=refresh` (push — pass `gha-<repo>-${{ github.ref_name }}`) |
| `argocd-token-vault-path` · `argocd-token-vault-key` | `""` · `auth_token` | KV v2 path (`<mount>/data/<path>`) of the ArgoCD CI token |
| `kubeconfig-vault-path` · `kubeconfig-vault-key` | `""` · `kubeconfig` | read-only kubeconfig for the post-merge in-cluster cross-check; empty → "kubectl cross-check skipped: not configured" |
| `aws-role-arn` · `aws-region` | `""` | optional AWS OIDC role assumed before the live diff |
| `block-noop` | `"true"` | pass the caller's `vars.GITOPS_BLOCK_NOOP || 'true'`; `"false"` → `noop-allowed` |
| `meta-file-pattern` | `(^\|/)\.render-kustomize$\|\.md$` | files under a unit that never reach a manifest (the `meta` verdict) |
| `new-app-hint` | generic | who creates an Application that is not in ArgoCD yet |
| `new-apps-appear-after-merge` | `"false"` | `mode=refresh`: `"true"` when an ApplicationSet creates new Applications from the merge (poll for them) |
| `pr-environment` | `gitops` | GitHub Environment of the live jobs on PRs (OIDC `environment` claim) — must have **no** required reviewers |
| `environment-name` | `<cluster>-<group>` | GitHub Environment of the post-merge refresh |
| `comment-header` | `gitops-<cluster>-<group>` | sticky comment header — keep it so existing comments keep updating |
| `sticky-comment` | `true` | post the group comment (mode=diff, pull_request events) |
| `tailscale-tags` | `tag:ci` | tags of the ephemeral tailnet node |

Secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` (Tailscale OAuth client; unset → *skipped-no-tailnet*), `ARGOCD_AUTH_TOKEN` (pre-Vault fallback only). Callers use `secrets: inherit` or pass them explicitly.

Gate inputs (`gitops-argocd-gate.yaml`): `results-json` (`${{ toJson(needs) }}`, required), `title` (`GitOps`), `comment` (`true`), `mode` (`diff`).

## Example callers

**planeodev/planeo-infra** — one job per group, a tools image, the CMP plugin, Vault roles per branch:

```yaml
jobs:
  core:
    name: 🧱 core
    uses: ohanalabs-ai/github-platform/.github/workflows/gitops-argocd-group.yaml@main
    secrets: inherit
    with:
      cluster: platform-aws-eks-use1-prd
      group: core
      mode: diff
      watch-paths: |
        addons/core/**
        clusters/base/**
      discover-command: bash clusters/discover-units.sh --json --cluster platform-aws-eks-use1-prd --group core
      render-plugin-script: addons/platform/argocd/cmp/render.sh
      attestation-command: bash clusters/check-image-attestations.sh
      tools-image: ghcr.io/${{ github.repository }}/tools:${{ vars.TOOLS_IMAGE_TAG || 'latest' }}
      argocd-server: ${{ vars.ARGOCD_SERVER }}
      vault-addr: ${{ vars.VAULT_ADDR }}
      vault-jwt-audience: https://github.com/planeodev
      vault-role-pr: gha-eks-cluster-pr
      vault-role-push: gha-eks-cluster-${{ github.ref_name }}
      argocd-token-vault-path: planeo/data/clouds/aws/eks/platform/argocd/ci
      kubeconfig-vault-path: planeo/data/clusters/platform-aws-eks-use1-prd/ci/kubeconfig
      aws-role-arn: ${{ vars.AWS_ROLE_ARN }}
      aws-region: ${{ vars.AWS_REGION }}
      block-noop: ${{ vars.GITOPS_BLOCK_NOOP || 'true' }}
      new-app-hint: "`argocd-bootstrap` (clusters/<cluster>/hooks/argocd/bootstrap.sh) creates it"
  platform-gate:
    name: 🚦 platform gate
    needs: [core]
    if: always()
    uses: ohanalabs-ai/github-platform/.github/workflows/gitops-argocd-gate.yaml@main
    with: { results-json: "${{ toJson(needs) }}", title: Platform, mode: diff }
```

**planeodev/customers** — one group, pinned releases, `LoadRestrictionsNone`, ApplicationSet-created units:

```yaml
jobs:
  customers:
    name: 🧑‍🤝‍🧑 customers
    uses: ohanalabs-ai/github-platform/.github/workflows/gitops-argocd-group.yaml@main
    secrets: inherit
    with:
      cluster: platform-aws-eks-use1-prd
      group: customers
      mode: diff
      discover-command: bash scripts/gitops/discover-units.sh --json
      kustomize-build-args: --enable-helm --load-restrictor LoadRestrictionsNone
      meta-file-pattern: '\.md$'
      argocd-server: ${{ vars.ARGOCD_SERVER }}
      vault-addr: ${{ vars.VAULT_ADDR }}
      vault-jwt-audience: https://github.com/planeodev
      vault-role-pr: gha-customers-pr
      vault-role-push: gha-customers-main
      argocd-token-vault-path: planeo/data/clouds/aws/eks/platform/argocd/ci
      block-noop: ${{ vars.GITOPS_BLOCK_NOOP || 'true' }}
      new-app-hint: "the `customer-tenant-envs` ApplicationSet creates it after merge"
      new-apps-appear-after-merge: "true"
```

Always `@main` for callers (org-owned repo; callers track the latest reviewed version). The composite actions are checked out at the reusable workflow's own commit (`job.workflow_sha`), so a caller temporarily on `@feature/x` exercises that branch end to end.

## Job names and required statuses

A caller job that `uses:` a reusable workflow produces no check of its own — only the nested jobs do (`🧱 core / 🧭 discover`, `🧱 core / 🧩 render cert-manager`, `🧱 core / 🔍 diff cert-manager`, `🧱 core / 📋 result`), and those vary per PR. Require the **gate**: `<caller gate job name> / 🚦 gate`. Name every caller's gate job distinctly (`🚦 platform gate`, `🚦 demos gate`, `🚦 vault gate`, `🚦 customers gate`): GitHub keys a status by its name, so several workflows all reporting `🚦 gate` would overwrite each other and a passing scope could mask a failing one. Migrating a repo's single-workflow checks (e.g. a bare `📋 result`) to these callers **renames its required statuses** — update branch protection in the same change.

## Toolchain: `tools-image` vs pinned releases

A repo whose deploy runs from its own tools image (planeo-infra) passes it: the same kustomize/helm build here, in the deploy and in ArgoCD's repo-server. The action writes shims (`kustomize`, `helm`, `argocd`, `kubectl` → `docker run --rm --network host … <image> <tool>`) that mount the runner's work dir, temp dir and `/tmp` at identical paths and run in the caller's cwd, so scripts never know which toolchain they got. A repo without an image (customers — the infra image is a private package its token cannot pull) gets the pinned releases. `yq` is always native (the per-object split runs it hundreds of times).

## Composite actions have two homes today

`ohanalabs-ai/actions` (`docker/*`, `github/*`, `cloud-native/*`, `ai/*` — the former vionix library) and, since this product, `ohanalabs-ai/github-platform/actions/` (`gitops/*`). Nothing was moved. The intended end state is the model the `github-actions-cicd` skill describes: **`github-platform/actions/<category>/<name>/action.yaml` is the home for composites that a `github-platform` reusable workflow is built from** (reviewed with the workflow, released with it via `@main`), while `ohanalabs-ai/actions` keeps standalone actions until they are consolidated here one by one. New composites go here.

## Local run

Every script is plain bash (yq v4, jq, kustomize, helm; `argocd` for the live step). From a repo's root:

```bash
GP=~/dev/github.com/ohanalabs-ai/github-platform/actions/gitops
# which units does a change touch? (the repo's own command)
bash clusters/discover-units.sh --json --cluster platform-aws-eks-use1-prd --group platform addons/platform/kagent/values.yaml
# the expected change of one unit: base tree (a worktree of the target branch) vs this tree
git worktree add /tmp/base origin/develop
bash "$GP/render-diff/render-diff.sh" . /tmp/base addons/core/cert-manager /tmp/rd && cat /tmp/rd/diff.txt
# a multi-source Application: helm template the chart source(s) + the git source
MULTI_SOURCE=true APP_MANIFEST=clusters/platform-aws-eks-use1-prd/hooks/argocd/platform/kagent.yaml \
  bash "$GP/render-diff/render-diff.sh" . /tmp/base addons/platform/kagent /tmp/rd
# the component tree / Mermaid of a kustomization
bash "$GP/kustomize-tree/kustomize-tree.sh" addons/core/cert-manager --mermaid --changed addons/core/cert-manager/values.yaml
# the verdict logic, against the live ArgoCD (ARGOCD_SERVER/ARGOCD_AUTH_TOKEN/ARGOCD_OPTS in the env)
APP=cert-manager UNIT_PATH=addons/core/cert-manager DIFF_REV=<head sha> BASE_SHA=<base sha> IN_ARGOCD=true \
  RENDER_FRAG=/tmp/rd/summary.json FRAG_DIR=/tmp/frag DIFF_OUT=/tmp/diff.txt bash "$GP/argocd-diff/argocd-diff.sh"
```

`tests/gitops/run-tests.sh` runs every path offline (a stub `argocd`), plus a real chart bump; `.github/workflows/gitops-selftest.yaml` runs it on this repo's PRs.

## Known limits / follow-ups

- The live `argocd app diff` stays **render-only for multi-source Applications**: a single `--revision` cannot evaluate `spec.sources[]`. ArgoCD ≥ 2.11 has `--revisions <sha> --source-positions <n>`; wiring it would turn those units into real live verdicts.
- The multi-source render ignores a git source's `kustomize:` options in the Application (e.g. `commonLabels`) — same in base and head, so no diff impact.
- Rendered values (hostnames, ARNs) land in the PR comment; fine in private repos, move behind the artifact for a public mirror.
