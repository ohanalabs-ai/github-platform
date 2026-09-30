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

Built from the composite actions under [`actions/scripted/`](../../actions/scripted/): [`run-command`](../../actions/scripted/run-command/) (run on the runner or in the caller's tools image over the host network, capture stdout) and [`phase-summary`](../../actions/scripted/phase-summary/) (the markdown — and `plan.sh`, the renderer of the plan manifest below). The toolchain for runner-side commands is [`actions/gitops/toolchain`](../../actions/gitops/toolchain/).

## The plan manifest: a preview that reads like the Terraform plan comment

Free text is not a plan. The owner's review of the first `phase=vault-seed` run through this workflow (`planeodev/planeo-infra` run 36685328024, 2026-09-30): *"the summary does still NOT include the actual terraform diff of what will be included … I want to see the same diff being the list of resources like it is shown in the PRs and the actual code diff we can see."* So the preview command has a second, **structured** channel besides its stdout: the workflow exports **`PREVIEW_DIR`** (`$RUNNER_TEMP/scripted-phase/preview`, created before the preview, forwarded into the tools image — `$RUNNER_TEMP` is mounted at the same path there), and the command may write there:

| File | Shape |
|---|---|
| `$PREVIEW_DIR/plan.json` | `{ "summary"?: {...}, "resources": [ <resource>, … ] }` |
| `$PREVIEW_DIR/resources.jsonl` | one `<resource>` JSON object per line — **append-friendly**: every subprocess of the preview (a `DRY_RUN=1` hook, a per-add-on diff) appends its own lines |

Both may exist; they are concatenated. A `<resource>` is

```json
{ "action": "add | change | destroy | noop | note | error",
  "type":   "vault-kv | k8s | helm-release | namespace | pvc | image | step | …",
  "name":   "planeo/clusters/platform-aws-eks-use1-prd/render-vars",
  "note":   "1 added, 1 changed, 0 removed, 14 unchanged key(s) — a new KV version",
  "diff":   "--- … (current)\n+++ … (apply)\n@@ … @@\n-CHANGE_ME_X = <redacted len=11 sha256:0a9b8c7d>\n+CHANGE_ME_X = <redacted len=15 sha256:e1f2a3b4>",
  "diff_file": "<path read when diff is absent>" }
```

`phase-summary` renders it **exactly like the Terraform comment** ([`reproio/terraform-j2md`](https://github.com/reproio/terraform-j2md)'s shape, the one the callers' PRs already show):

```markdown
### 1 to add, 1 to change, 0 to destroy, 8 unchanged
- add
    - `vault-kv` planeo/clouds/aws/eks/product/auth-broker/session-key — MISSING — the apply mints it
- change
    - `vault-kv` planeo/clusters/platform-aws-eks-use1-prd/render-vars — 1 added, 1 changed, 0 removed, 14 unchanged key(s)
<details><summary>✅ unchanged (8)</summary> … </details>
- ℹ️ not diffable — the apply also does this: …        (action `note`)
- ❌ errors: …                                          (action `error` — a red banner on top)
<details><summary>Change details</summary>
````diff
# vault-kv planeo/clusters/platform-aws-eks-use1-prd/render-vars will be updated
--- planeo/clusters/platform-aws-eks-use1-prd/render-vars (current, v7)
+++ planeo/clusters/platform-aws-eks-use1-prd/render-vars (apply)
@@ -1,4 +1,5 @@
 CHANGE_ME_AWS_REGION = <redacted len=9 sha256:5f3c1a2b>
-CHANGE_ME_CLUSTER_NAME = <redacted len=11 sha256:0a9b8c7d>
+CHANGE_ME_CLUSTER_NAME = <redacted len=15 sha256:e1f2a3b4>
````
</details>
```

Rules:

- **The counts are recomputed from the resources** — a supplied `summary` is ignored when it disagrees. `noop` = unchanged; `note` = an imperative step the apply also runs (a wait, a restart, an import) — listed, not counted; `error` = a resource the preview could not evaluate (a `kubectl diff` that failed, a CRD not established) — listed under a red banner.
- **Redaction is the emitter's job, by construction.** The renderer prints what it is given. A diff of a Vault KV record or a Kubernetes `Secret` carries key NAMES, value lengths and a short hash (`KEY = <redacted len=N sha256:8hex>`) — enough to see *that* a value changes, never *what* it is; a value the apply generates reads `<generated at apply, N chars>`.
- **Same content everywhere.** The rendered plan (`plan.md`) heads the `## Preview` section of the step summary, the sticky PR comment and the artifact (with `plan.normalized.json`, the recomputed manifest, beside the emitter's files); the command's stdout becomes a collapsed *appendix*. The `🚀 apply` job prints the same `plan.md` at the top of its log and embeds it in its summary — the audit trail of what was approved.
- **Backwards compatible.** No manifest → today's output: the free text alone. A repo adopts the manifest one phase at a time (planeo-infra: `scripts/lib-plan.sh`, `plan_resource <action> <type> <name> [note] [diff-file]`, emitted from every `DRY_RUN=1` hook and every `kubectl diff` block of its previews).

Golden fixtures: [`tests/scripted/fixtures/plan-*.{jsonl,json}`](../../tests/scripted/fixtures/) → `plan-*.md` (`tests/scripted/run-tests.sh` → `plan/render`, `plan/summary`).

## The caller's contract: an honest preview

The **preview command is the caller's script and is READ-ONLY by contract** — the workflow cannot enforce that; the repo does (`DRY_RUN=1`, `kubectl diff --server-side`, `helm diff`, a Vault KV key-NAME comparison). Rules the callers follow:

- **Never print a secret value.** A preview names Vault paths, key NAMES, Kubernetes objects, counts and versions. A `kubectl diff` on a `Secret` shows only "N keys differ"; a manifest diff of a KV record shows `KEY = <redacted len=N sha256:8hex>`.
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
| `preview-command` | — | READ-ONLY; stdout (markdown) is the preview; a non-zero exit blocks the apply; may write the **plan manifest** to `$PREVIEW_DIR` (rendered like the Terraform plan comment — above) |
| `apply-command` | `""` | the change; empty → preview-only (no apply job) |
| `setup-command` | `""` | runs before the preview AND before the apply (`tf-init`, kubeconfig) |
| `post-command` | `""` | runs after the apply, always; its stdout ends the apply summary (a board, a verify) |
| `gated` | `true` | `true` → the apply job runs in `environment-name`; `false` → no Environment |
| `environment-name` | `production` | the gated Environment |
| `destructive` | `false` | red banner on the preview |
| `tools-image` | `""` | run every command inside this image (`docker run --network host`, checkout + `$RUNNER_TEMP` mounted at the same paths); empty → on the runner |
| `forward-env` | cloud creds, `REGION`/`STATE_BUCKET`/`LOCK_TABLE`, `VAULT_ADDR`/`VAULT_TOKEN`, `KUBECONFIG`, `PREVIEW_DIR`, `DRY_RUN` | env var NAMES forwarded into the image when set |
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
3. **Preview** — when the command wrote a plan manifest: the Terraform-comment shape first (`### N to add, M to change, K to destroy, U unchanged` → per-action resource lists → unchanged collapsed → not-diffable steps → `Change details` with one ````diff per resource, values redacted), then the command's stdout as a collapsed appendix. Without a manifest: the command's markdown as is (per-add-on `kubectl diff` counts, Vault paths + key names, the teardown inventory, …). If the command failed: the exit code and "the apply job is blocked".
4. **Next** — approve the `🚀 apply` job / runs immediately / nothing to approve.

`🚀 apply` prints the approved plan + preview at the top of its log and its summary embeds them (the plan open, the free text collapsed), then the apply's stdout and the post-command output.

## Required GitHub settings (caller repo)

- The Environment named by `environment-name` with **required reviewers** (a team). Its `deployment_branch_policy` must admit the ref you dispatch from (`null` = any branch) — a `workflow_dispatch` from `develop` with a `main`-only policy fails at the gate with zero steps run.
- Caller job `permissions`: `contents: read`, `id-token: write`, `packages: read` (tools image), `pull-requests: write` (sticky comment; harmless for a dispatch-only caller).
- The Tailscale secrets passed **explicitly** in `secrets:`.

## Boundaries

- Not for Terraform (that is `devsecops-terraform`: a real plan) nor for ArgoCD-managed manifests (that is `devsecops-gitops`: the PR shows the rendered + live diff and the merge is the deploy). This product covers what is left: the scripted phases — and the callers' plan is to keep shrinking that set (fold phases into the Terraform/GitOps flows; `planeodev/planeo-infra` `BACKLOG.md`).
- The workflow does not verify that `preview-command` is read-only; the caller's repo does (its tests assert that every phase has a preview and that the preview scripts run in `DRY_RUN`).
