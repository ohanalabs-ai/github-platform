# devsecops-vault — sign and rotate with a Vault, from any GitHub repository

Two reusable workflows that let a GitHub Actions job use a HashiCorp Vault **with nothing but its own
GitHub OIDC token** — no Vault token, no AppRole secret, no long-lived credential in GitHub:

| Workflow | Ask | Returns |
|---|---|---|
| [`vault-sign.yaml`](../../.github/workflows/vault-sign.yaml) 🔏 | "sign digest **D** (or image **I@sha256:D**) with key **K** at Vault **V**" | `signature` (`vault:vN:…`), `key-version`, `public-key`, `signed-ref`, `meter-event` |
| [`vault-rotate-secret.yaml`](../../.github/workflows/vault-rotate-secret.yaml) 🔄 | "rotate field **F** of record **P** at Vault **V**, then tell system **S**" | `version`, `previous-version`, `meter-event` |

It generalizes the vionix `vionix-vault-rotate-secrets.yaml` (`hashicorp/vault-action` · `method: jwt` ·
`path: git-jwt` · a role · a base64 CA · `vault read`/`vault write`), and is how Planeo offers its Vault
to GitHub callers — design and threat model:
[planeodev/planeo-infra `docs/vault/github-actions-access.md`](https://github.com/planeodev/planeo-infra/blob/develop/docs/vault/github-actions-access.md)
(Jira INTEGRATE-30). Logic: [`actions/vault/`](../../actions/vault/README.md).

## What the Vault side must have

```hcl
# a JWT auth mount trusting GitHub's issuer (Planeo: one mount per tenant, auth/github/<tenant>)
vault write auth/github/acme/config \
  oidc_discovery_url=https://token.actions.githubusercontent.com \
  bound_issuer=https://token.actions.githubusercontent.com

# a role per repository × ref (or environment) — bind the NUMERIC ids (renames/resurrected names can't match)
vault write auth/github/acme/role/acme-prd-app-main role_type=jwt \
  bound_audiences=https://vault.planeo.dev/acme \
  bound_claims_type=string \
  bound_claims='{"repository_owner_id":"1234567","repository_id":"7654321","ref":"refs/heads/main","event_name":["push","workflow_dispatch"]}' \
  user_claim=repository_id \
  claim_mappings='{"repository":"repository","ref":"ref","workflow_ref":"workflow_ref","run_id":"run_id"}' \
  token_policies=customers-acme-prd-signer token_ttl=15m token_max_ttl=15m

# a per-tenant-env transit mount + a non-exportable key; the signer policy grants <mount>/sign/<key>/* (update) + <mount>/keys/<key> (read) only
vault secrets enable -path=transit-customers/acme-prd transit
vault write transit-customers/acme-prd/keys/images type=ecdsa-p256 exportable=false allow_plaintext_backup=false
```

## Calling it

```yaml
name: 🐳 build and sign
run-name: "🐳 build and sign · ${{ github.ref_name }}"
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write
  packages: write
jobs:
  build:
    # … pushes ghcr.io/acme/app and outputs its digest
  sign:
    needs: build
    uses: ohanalabs-ai/github-platform/.github/workflows/vault-sign.yaml@main
    with:
      vault-url: https://vault.planeo.dev
      vault-auth-path: github/acme
      vault-role: acme-prd-app-main
      vault-audience: https://vault.planeo.dev/acme
      transit-path: transit-customers/acme-prd
      key: images
      mode: cosign
      image: ghcr.io/acme/app@${{ needs.build.outputs.digest }}
      registry: ghcr.io
    secrets:
      registry-password: ${{ secrets.GITHUB_TOKEN }}

  # sign a release artifact's digest instead of an image
  sign-tarball:
    uses: ohanalabs-ai/github-platform/.github/workflows/vault-sign.yaml@main
    with:
      vault-url: https://vault.planeo.dev
      vault-auth-path: github/acme
      vault-role: acme-prd-app-main
      vault-audience: https://vault.planeo.dev/acme
      transit-path: transit-customers/acme-prd
      key: artifacts
      digest: sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

```yaml
name: 🔄 rotate the app token
run-name: "🔄 rotate app token · ${{ github.event_name }}"
on:
  schedule: [{ cron: "0 0 * * *" }]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  rotate:
    uses: ohanalabs-ai/github-platform/.github/workflows/vault-rotate-secret.yaml@main
    with:
      vault-url: https://vault.planeo.dev
      vault-auth-path: github/acme
      vault-role: acme-prd-rotator-main   # bound to ref main + event_name schedule/workflow_dispatch
      vault-audience: https://vault.planeo.dev/acme
      kv-mount: planeo
      secret-path: customers/acme-prd/app/api-token
      field: token
      dispatch-repository: acme/app        # the app reloads; it reads the new value with its own role
    secrets:
      dispatch-token: ${{ secrets.ACME_DISPATCH_TOKEN }}
```

A Vault reachable only over a tailnet (Planeo's own repos today): `join-tailscale: true` +
`tailscale-oauth-client-id` / `tailscale-oauth-secret`. A Vault with a privately-issued certificate:
`ca-certificate: <base64 PEM>` (a publicly trusted one — ACM, Let's Encrypt — needs nothing).

## Security notes for callers

- **Bind the role to `repository_id` + `repository_owner_id` + `ref` (or `environment`) + `event_name`.**
  `pull_request_target` and `workflow_run` runs carry the **base** branch's `ref` with a token that can be
  minted while running untrusted code — a role bound on `ref` alone accepts them. Fork `pull_request`
  runs get no OIDC token at all.
- **Use an audience unique to the Vault/tenant** (`vault-audience`), not GitHub's default
  `https://github.com/<owner>`, so a token minted for one relying party is useless at another.
- To require the signing to happen *through this reusable* (not an ad-hoc step in the caller), bind
  `job_workflow_ref` to `ohanalabs-ai/github-platform/.github/workflows/vault-sign.yaml@refs/heads/main`.
- The `meter-event` output is a CloudEvents usage record (`dev.planeo.vault.sign|rotate`) for a metering
  pipeline (e.g. OpenMeter); the workflows only emit it.

## Tests

- `actions-typescript-selftest.yaml` — `node --test actions/vault/vault.test.ts` (fake Vault, no network).
- `vault-selftest.yaml` — a dev-mode Vault service container + real GitHub OIDC tokens: sign + verify,
  two CAS rotations, and a role bound to another repository refusing this job's token.
