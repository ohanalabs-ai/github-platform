# devsecops-scripted

Reusable workflow: [`scripted-phase.yaml`](../../.github/workflows/scripted-phase.yaml) — **preview, then approve, then apply** for the imperative automation that is neither Terraform nor ArgoCD: a repo's `workflow_dispatch` that runs a *script* against a live cluster or a Vault (`phase=vault-seed`, `phase=addons`, `phase=teardown`, a GKE demo cycle, an image mirror).

It is the Terraform `plan → gated apply` shape ([`terraform-devsecops-workflow.yaml`](../devsecops-terraform/README.md)) generalised to any command:

```
dispatch
 ├─ 🔍 preview   no Environment · same auth as the apply (cloud OIDC, tailnet, Vault) ·
 │               setup-command → preview-command (READ-ONLY) → stdout = markdown →
 │               step summary + artifact `scripted-phase-preview-<phase>[-<target>]` (+ sticky PR comment)
 │               the summary ALSO lists, verbatim, every command the apply will run
 └─ 🚀 apply     needs: preview · environment: <environment-name> (gated: true) ·
                 re-prints the approved preview at the top of its log → setup-command → apply-command → post-command
```

Why: a single job inside a gated Environment shows the reviewer only "Review deployments" and a free-form phase name. The approver has no idea what the run will do and approves blind (`planeodev/planeo-infra` run 36620677548, `phase=vault-seed`, 2026-09-29). With the split, the approval click is made on a preview in the same run — and the apply job records what was approved.

Built from the composite actions under [`actions/scripted/`](../../actions/scripted/): [`run-command`](../../actions/scripted/run-command/) (run on the runner or in the caller's tools image over the host network, capture stdout) and [`phase-summary`](../../actions/scripted/phase-summary/) (the markdown). The toolchain for runner-side commands is [`actions/gitops/toolchain`](../../actions/gitops/toolchain/).

## The caller's contract: an honest preview

The **preview command is the caller's script and is READ-ONLY by contract** — the workflow cannot enforce that; the repo does (`DRY_RUN=1`, `kubectl diff --server-side`, `helm diff`, a Vault KV key-NAME comparison). Rules the callers follow:

- **Never print a secret value.** A preview names Vault paths, key NAMES, Kubernetes objects, counts and versions. A `kubectl diff` on a `Secret` shows only "N keys differ".
- **Say so when a phase cannot be previewed faithfully** (an imperative sequence with waits/restarts, a test suite): print the inputs and the exact commands — the summary lists them anyway — rather than a fake diff.
- **A failing preview blocks the apply** (`needs: preview`; the summary says why). Use that: a preflight the apply would fail is a preview failure.
- **Read-only / test phases set `gated: false`** (no Environment — nothing to approve); a phase that is *only* a read (a status board) sets an empty `apply-command` (preview-only).

## Usage (planeodev/planeo-infra `addons.yml`)

```yaml
name: 🧩 addons
run-name: "🧩 addons phase=${{ inputs.phase }}"
on:
  workflow_dispatch:
    inputs:
      phase: { type: choice, options: [cilium, addons, both, verify, test, connectivity, vault-seed, argocd-bootstrap, ci-credentials, teardown] }
permissions:
  contents: read
  id-token: write      # OIDC → AWS role + Vault
  packages: read       # the tools image
  pull-requests: write # sticky comment on pull_request events (unused by a dispatch)
jobs:
  phase:
    uses: ohanalabs-ai/github-platform/.github/workflows/scripted-phase.yaml@main
    secrets:
      TS_OAUTH_CLIENT_ID: ${{ secrets.TS_OAUTH_CLIENT_ID }}   # explicit — `secrets: inherit` does not cross orgs
      TS_OAUTH_SECRET: ${{ secrets.TS_OAUTH_SECRET }}
    with:
      phase: ${{ inputs.phase }}
      target: platform-aws-eks-use1-prd
      tools-image: ghcr.io/${{ github.repository }}/tools:${{ vars.TOOLS_IMAGE_TAG || 'latest' }}
      env: |
        REGION=${{ vars.AWS_REGION }}
        STATE_BUCKET=${{ vars.STATE_BUCKET }}
        LOCK_TABLE=${{ vars.LOCK_TABLE }}
      setup-command: bash scripts/tf-init.sh && bash scripts/kubeconfig.sh
      preview-command: bash scripts/preview-phase.sh ${{ inputs.phase }}
      apply-command: bash scripts/run-phase.sh ${{ inputs.phase }}
      gated: ${{ !contains(fromJSON('["verify","test","connectivity"]'), inputs.phase) }}
      destructive: ${{ inputs.phase == 'teardown' }}
      environment-name: production
      aws-role-arn: ${{ vars.AWS_ROLE_ARN }}
      aws-region: ${{ vars.AWS_REGION }}
      join-tailscale: true
      vault-addr: ${{ vars.VAULT_ADDR }}
      vault-role: gha-eks-cluster-${{ github.ref_name }}
      vault-jwt-audience: https://github.com/planeodev
      vault-export-token: ${{ !contains(fromJSON('["vault-seed","addons","both"]'), inputs.phase) }}
```

A GKE caller (no tools image, runner-side kubectl) passes `gcp-workload-identity-provider` / `gcp-service-account` / `gcp-project-id` + `gke-cluster` / `gke-location` and `toolchain: kustomize` instead of the AWS/tailnet/Vault inputs.

Always reference `@main` (org-owned reusable; third-party actions inside are SHA-pinned).

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `phase` | — | label: what the dispatch chose (summaries, artifact name, run-name) |
| `target` | `""` | label: the cluster / target |
| `preview-command` | — | READ-ONLY; stdout (markdown) is the preview; a non-zero exit blocks the apply |
| `apply-command` | `""` | the change; empty → preview-only (no apply job) |
| `setup-command` | `""` | runs before the preview AND before the apply (`tf-init`, kubeconfig) |
| `post-command` | `""` | runs after the apply, always; its stdout ends the apply summary (a board, a verify) |
| `gated` | `true` | `true` → the apply job runs in `environment-name`; `false` → no Environment |
| `environment-name` | `production` | the gated Environment |
| `destructive` | `false` | red banner on the preview |
| `tools-image` | `""` | run every command inside this image (`docker run --network host`, checkout + `$RUNNER_TEMP` mounted at the same paths); empty → on the runner |
| `forward-env` | cloud creds, `REGION`/`STATE_BUCKET`/`LOCK_TABLE`, `VAULT_ADDR`/`VAULT_TOKEN`, `KUBECONFIG`, `DRY_RUN` | env var NAMES forwarded into the image when set |
| `env` | `""` | non-secret `KEY=VALUE` lines exported in both jobs |
| `toolchain` | `""` | runner-side tools from pinned releases (`kustomize helm argocd kubectl`); ignored with `tools-image` |
| `kustomize-version` · `helm-version` · `argocd-version` · `kubectl-version` | `5.5.0` · `3.16.3` · `3.5.3` · `1.36.2` | the pins for `toolchain` |
| `aws-role-arn` · `aws-region` | `""` | GitHub OIDC → IAM role |
| `gcp-workload-identity-provider` · `gcp-service-account` · `gcp-project-id` | `""` | GitHub OIDC → Workload Identity Federation (+ `gcloud` with the GKE auth plugin) |
| `gke-cluster` · `gke-location` | `""` | with GCP auth: `gcloud container clusters get-credentials --dns-endpoint` into `$KUBECONFIG` |
| `join-tailscale` · `tailscale-tags` · `tailscale-args` | `false` · `tag:ci` · `--accept-routes` | join the tailnet first (private API, Vault) — needs the two secrets, fails loudly without |
| `vault-addr` · `vault-jwt-path` · `vault-role` · `vault-jwt-audience` · `vault-secrets` | `""` · `github-jwt` · `""` · `""` · `""` | `hashicorp/vault-action` login (method jwt) in both jobs; `vault-secrets` exports records as masked env |
| `vault-export-token` | `true` | export the login token as `VAULT_TOKEN`; `false` for a phase whose scripts must resolve a different token (planeo-infra's Vault seeds use the operator root token — a CI token in `VAULT_TOKEN` wins the precedence and every seed 403s) |
| `sticky-comment` | `true` | on `pull_request` events, post/refresh a sticky comment with the preview |
| `runner` | `ubuntu-latest` | |

Secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` (only read with `join-tailscale`). Output: `preview-exit-code`.

## What the approver sees

`🔍 preview`'s summary (also the artifact and the PR comment):

1. **identity** — phase, target, ref, event, requested-by, run; the gate row (`🔒 waits for a reviewer of production` / `🔓 ungated` / `preview-only`); a 🟥 banner when destructive.
2. **What the apply will run** — `setup`, `preview`, `apply`, `post`, verbatim.
3. **Preview** — the command's markdown (per-add-on `kubectl diff` counts, Vault paths + key names, the teardown inventory, …). If the command failed: the exit code and "the apply job is blocked".
4. **Next** — approve the `🚀 apply` job / runs immediately / nothing to approve.

`🚀 apply` prints the approved preview at the top of its log and its summary embeds it (collapsed), then the apply's stdout and the post-command output.

## Required GitHub settings (caller repo)

- The Environment named by `environment-name` with **required reviewers** (a team). Its `deployment_branch_policy` must admit the ref you dispatch from (`null` = any branch) — a `workflow_dispatch` from `develop` with a `main`-only policy fails at the gate with zero steps run.
- Caller job `permissions`: `contents: read`, `id-token: write`, `packages: read` (tools image), `pull-requests: write` (sticky comment; harmless for a dispatch-only caller).
- The Tailscale secrets passed **explicitly** in `secrets:`.

## Boundaries

- Not for Terraform (that is `devsecops-terraform`: a real plan) nor for ArgoCD-managed manifests (that is `devsecops-gitops`: the PR shows the rendered + live diff and the merge is the deploy). This product covers what is left: the scripted phases — and the callers' plan is to keep shrinking that set (fold phases into the Terraform/GitOps flows; `planeodev/planeo-infra` `BACKLOG.md`).
- The workflow does not verify that `preview-command` is read-only; the caller's repo does (its tests assert that every phase has a preview and that the preview scripts run in `DRY_RUN`).
