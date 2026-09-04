# devsecops-terraform

Reusable workflow: [`terraform-devsecops-workflow.yaml`](../../.github/workflows/terraform-devsecops-workflow.yaml) — Terraform lint/validate, an optional shift-left security scan (tfsec + terrascan), a `plan` step that comments its result directly on the PR, and an environment-gated `apply`.

This is a reviewed, genericized copy of `vionix-proj/vionix-github`'s `.github/workflows/terraform-devsecops-workflow.yaml`. See the header comment in the workflow file itself for the full list of what changed from the original and why (short version: dropped Viasat-internal Artifactory/`config-stream-decoder`/self-hosted-runner dependencies in favor of standard AWS OIDC + `hashicorp/setup-terraform`, so any repo with a `terraform/` directory can call this — no docker-compose contract required).

## Usage

```yaml
# Every workflow that calls a reusable workflow MUST have a name: prefixed
# with a distinguishing emoji and a descriptive run-name: — see
# skills/github-actions-cicd/SKILL.md in the claude-agents repo.
name: 🌎 terraform-devsecops-workflow
run-name: 🌎 Terraform plan and gated apply/destroy for the production env

on:
  pull_request:
    paths:
      - "terraform/**"
  workflow_dispatch:
    inputs:
      action:
        type: choice
        options: [plan, apply, destroy]
        default: plan

jobs:
  terraform:
    uses: vionix-proj/github-platform/.github/workflows/terraform-devsecops-workflow.yaml@main
    with:
      working-directory: terraform
      terraform-version: "1.9.8"
      backend-config: |
        bucket         = "my-terraform-state-bucket"
        key            = "my-stack/terraform.tfstate"
        region         = "us-east-1"
        dynamodb_table = "terraform-state-lock"
      var-file: ci.tfvars
      extra-args: -var="region=us-east-1"
      aws-region: us-east-1
      aws-role-arn: arn:aws:iam::123456789012:role/my-terraform-ci-role
      enable-shift-left-scan: true
      terraform-environment-name: production
      run-deploy: ${{ github.event_name == 'workflow_dispatch' && inputs.action == 'apply' }}
      run-destroy: ${{ github.event_name == 'workflow_dispatch' && inputs.action == 'destroy' }}
    permissions:
      contents: read
      id-token: write
      pull-requests: write
      actions: read
      security-events: write
```

Always reference `@main` — this is an internal, org-owned workflow repo, so callers are expected to track the latest reviewed version rather than pin a SHA (unlike third-party actions, which this org's own `actions-pin-version-setting-lint.yaml` requires pinning).

## Inputs

| Input | Default | Description |
|---|---|---|
| `github-actions-runner` | `ubuntu-latest` | Runner for every job |
| `working-directory` | `terraform` | Directory containing the Terraform root module |
| `terraform-version` | `1.9.8` | Terraform CLI version (`hashicorp/setup-terraform`) |
| `backend-config` | `""` | Backend config lines, one per line, written to a generated `backend.hcl` before `init`. Empty = local-only init (no remote backend) |
| `var-file` | `""` | Path (relative to `working-directory`) to a `.tfvars` file |
| `extra-args` | `""` | Extra space-separated flags appended to `plan`/`apply` (e.g. `-var=...`) |
| `aws-region` | `""` | AWS region for OIDC auth |
| `aws-role-arn` | `""` | IAM role ARN to assume via GitHub OIDC. Leave both this and `aws-region` empty to skip AWS auth entirely (e.g. a non-AWS backend) |
| `enable-shift-left-scan` | `false` | Run the tfsec/terrascan matrix job |
| `terrascan-config-path` | `terrascan-config.toml` | Path to terrascan's config file, only read when `enable-shift-left-scan` is true |
| `terraform-environment-name` | `default` | GitHub Environment the `deploy` job runs under — use this for required-reviewer apply gating |
| `terraform-environment-url` | `""` | URL shown on a successful deployment in the GitHub UI |
| `run-deploy` | `false` | Explicit opt-in to run the `deploy` (apply) job at all. This is a second, independent gate on top of the target Environment's own protection rules — set `true` only from a path a human explicitly triggered for an apply (e.g. a `workflow_dispatch` with an `action: apply` choice), never from a PR-triggered call |
| `run-destroy` | `false` | Explicit opt-in to run the `destroy` job at all. Same shape and reasoning as `run-deploy`. Mutually exclusive with `run-deploy` — `validate-inputs` fails fast if both are true |
| `expected-deploy-events` | `workflow_dispatch` | Comma-separated allowlist of `github.event_name` values `deploy`/`destroy` may run under — a third, independent gate on top of `run-deploy`/`run-destroy`. To deploy on merge to `main`, use a `push` (`branches: [main]`) trigger and include `push` here — **not** `pull_request`, whose `github.ref` never resolves to `refs/heads/main` and so can never satisfy a GitHub Environment's branch-restriction policy |
| `agent-validated` | `false` | Skip the target Environment's required-reviewer pause, for a caller (e.g. an agent) that already validated the plan itself. Mechanism: `deploy`/`destroy` reference the Environment `<terraform-environment-name>-unattended` instead of `<terraform-environment-name>` — same job, a different (by default unprotected) Environment name, not a duplicated job. Restricting *who* may set this true is the calling repo's own responsibility |

## Secrets

| Secret | Description |
|---|---|
| `extra-env-json` | Optional JSON object of `{ENV_VAR: value}` pairs, exported as masked env vars before `init`/`plan`/`apply`. Use this for any provider beyond AWS that your Terraform config needs credentials for — e.g. a Tailscale provider needing `TAILSCALE_OAUTH_CLIENT_ID`/`_SECRET`. Not required — AWS auth itself goes through OIDC (`id-token: write`), not a static credential. |

```yaml
    secrets:
      extra-env-json: |
        {
          "TAILSCALE_OAUTH_CLIENT_ID": "${{ secrets.TAILSCALE_OAUTH_CLIENT_ID }}",
          "TAILSCALE_OAUTH_CLIENT_SECRET": "${{ secrets.TAILSCALE_OAUTH_CLIENT_SECRET }}"
        }
```

## Jobs

- **🔍 validate-inputs** — fails fast with a clear `::error` if `aws-region`/`aws-role-arn` are inconsistently set (one provided without the other), or if `enable-shift-left-scan` is true with an empty `terrascan-config-path`. Every other job depends on this passing first.
- **🚨 lint** — `terraform fmt -check -recursive`, `terraform init -backend=false`, `terraform validate`. Runs with no AWS credentials at all.
- **🛡️️ check** *(opt-in via `enable-shift-left-scan`)* — tfsec (PR-comment) and terrascan (SARIF upload to the Security tab) in a matrix.
- **📝️ plan** — real `terraform init`/`plan` against the configured backend, rendered as a sticky PR comment and appended to the job summary.
- **🚀 deploy** — `terraform apply -auto-approve`, gated behind the named GitHub Environment (configure required reviewers there for manual approval before this job runs). Set `agent-validated: true` to point it at `<terraform-environment-name>-unattended` instead, skipping that pause.
- **🧨 destroy** *(opt-in via `run-destroy`)* — `terraform destroy -auto-approve`, gated the same way as `deploy` (same Environment, same required-reviewer pause, same `agent-validated` mechanism). Mutually exclusive with `run-deploy`.

## Prerequisites for a calling repo

1. A `terraform/` (or equivalent, via `working-directory`) directory with a valid root module.
2. If using a remote backend, the actual bucket/table already provisioned (e.g. via a one-time bootstrap stack) — this workflow does not create them.
3. If using AWS: an IAM role trusting this repo's GitHub OIDC provider (`token.actions.githubusercontent.com`), passed as `aws-role-arn`.
4. If using `enable-shift-left-scan: true` with terrascan: a `terrascan-config.toml` at the repo root.

## Known follow-up

tfsec's SARIF upload from the original Vionix workflow depended on a file produced by a now-removed Docker step and is not reproduced here — tfsec's PR-comment path works today, but its SARIF-to-Security-tab path needs its own output flag wired in a future revision. terrascan's SARIF upload is unaffected (self-contained).
