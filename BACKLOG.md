# Backlog

## Good-to-have

- **Org-wide CI/CD GitHub App.** Create one GitHub App in `ohanalabs-ai`, installed on both `ohanalabs-ai` and
  `planeodev`, minting tokens inside Actions with `actions/create-github-app-token`. Its client id and private key are
  fetched from Vault through GitHub OIDC, not stored as GitHub secrets. Used for repo management at scale, and later the
  same pattern for customers' CI/CD.
  - Known limit (measured 2026-11-15, `rekorda-engram` with `packages: write`): GHCR/package APIs reject App installation
    tokens (registry manifest access denied, `GET /orgs/ohanalabs-ai/packages/container/...` returns 404). Package
    management therefore stays on the repo's `GITHUB_TOKEN` or classic-scoped tokens.
  - Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow
