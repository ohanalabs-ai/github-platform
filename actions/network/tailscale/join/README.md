# 🌐 tailscale/join

Secretless tailnet join: `tailscale/github-action` v4 with a Tailscale **OIDC federated identity** — the
job's GitHub OIDC token (`permissions: id-token: write`) is exchanged for an ephemeral `tag:ci` node key.
Callers pass the org **variables** `TS_FEDERATED_CLIENT_ID` / `TS_FEDERATED_AUDIENCE` (identifiers, not
secrets). Planeo creates one federated identity per GitHub org in Terraform
(planeodev/planeo-infra `clusters/platform-aws-eks-use1-prd/terraform/tailscale-ci-federation.tf`,
bound to the org's numeric id + `refs/heads/*` — pull_request runs get no node).
