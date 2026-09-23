# prerequisites

The render half needs nothing but the repository. The live half (`🔍 diff`, `♻️ refresh`) needs, in the **calling** repository:

| Kind | Name | Purpose |
|---|---|---|
| Variable | `ARGOCD_SERVER` | passed as `argocd-server`; unset → every live cell reads *skipped (no ARGOCD_SERVER)* and the run stays green |
| Variable | `VAULT_ADDR` | passed as `vault-addr`; the ArgoCD CI token (and the read-only kubeconfig after a merge) are read from Vault with the job's **GitHub OIDC token** (`hashicorp/vault-action`, method `jwt`) |
| Secret (organization, scoped to the GitOps repos) | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | a Tailscale OAuth client (tag `tag:ci`) — ArgoCD and Vault are tailnet-only; unset → *skipped (no Tailscale OAuth secrets)*. **Pass them explicitly in the caller's `secrets:` block** — `secrets: inherit` did not deliver these selected-repo organization secrets to the workflow hosted in another org (seen 2026-09-23) |
| Secret | `ARGOCD_AUTH_TOKEN` | **pre-Vault fallback only**, used when `vault-addr` is empty |
| Variable | `AWS_ROLE_ARN`, `AWS_REGION` | optional (`aws-role-arn`/`aws-region`) for a repo whose live diff needs AWS |
| Variable | `GITOPS_BLOCK_NOOP` | `false` downgrades a blocked no-op to a warning (`block-noop`) |
| Variable | `TOOLS_IMAGE_TAG` | when the caller passes its tools image (`tools-image: ghcr.io/<org>/<repo>/tools:${{ vars.TOOLS_IMAGE_TAG || 'latest' }}`) |

**Only trust roots stay in GitHub** — the Tailscale client is what gets the runner onto the tailnet and the AWS role is what renders anything AWS-side; a root cannot be fetched from the thing it unlocks. Everything else comes from Vault.

## Vault

- JWT auth mount (`vault-jwt-path`, default `github-jwt`) with `bound_audiences` = `vault-jwt-audience` (e.g. `https://github.com/planeodev`).
- One role per repository × event: `vault-role-pr` bound to `repository: <owner>/<repo>` + `event_name: pull_request` (read-only policy on the ArgoCD token), `vault-role-push` bound to the branch (planeo-infra: `gha-eks-cluster-<branch>`; customers: `gha-customers-main`) with, optionally, read on the kubeconfig path. Because the roles bind `repository` + `event_name` (not the OIDC `sub`), the `pr-environment` (`gitops`) claim does not have to be in the role.
- KV v2 records: `argocd-token-vault-path` (`<mount>/data/<path>`, key `auth_token` — an ArgoCD local account with `applications get` + `projects get`, e.g. `ci-diff`) and, for the in-cluster cross-check, `kubeconfig-vault-path` (a read-only kubeconfig). Empty kubeconfig path → the refresh says "kubectl cross-check skipped: not configured" and validates through ArgoCD only.

## Tailnet

The ephemeral CI node joins with `tags: tag:ci` and `--accept-routes`; the tailnet ACL must grant `tag:ci` the subnet router's advertised route and split DNS for the ArgoCD / Vault hostnames.

## GitHub Environments

- `pr-environment` (default `gitops`) for the live jobs on pull requests — **no required reviewers** (it exists for the OIDC `environment` claim and environment-scoped vars; a reviewer gate would pause every PR push).
- `<cluster>-<group>` (or `environment-name`) for the post-merge refresh: the job runs in it and `📋 result` records a Deployment there (`success` after validation, `inactive` when ArgoCD is not configured, `failure` otherwise), so Settings → Environments shows the latest SHA applied per group. Protection rules (required reviewers, wait timers, deployment branches) attach here.

## Permissions of the calling workflow

```yaml
permissions:
  contents: read
  pull-requests: write   # the sticky comments (mode=diff)
  id-token: write        # OIDC → Vault (and AWS)
  packages: read         # only when tools-image is a ghcr.io package
  deployments: write     # mode=refresh: the GitHub Deployment
```

## Required statuses

Require `<caller gate job> / 🚦 gate` per scope (see the product README); never the group jobs themselves.
