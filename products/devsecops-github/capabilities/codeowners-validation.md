# codeowners-validation

Reusable workflow: [`github-team-codeowners-actions.yaml`](../../../.github/workflows/github-team-codeowners-actions.yaml) — YAML-lints `.github/workflows`, fully validates `.github/CODEOWNERS` (syntax, duplicate patterns, and optionally that referenced files exist), and resolves every `@team`/`@user` CODEOWNERS references against the real GitHub org, publishing a step summary + sticky PR comment showing which exist and which don't.

This is a reviewed copy of `Viasat/vionix`'s `.github/workflows/github-team-codeowners-actions.yaml`. Unlike `terraform-devsecops-workflow.yaml`, this one had no Viasat-internal dependencies to strip — only public actions and a self-contained bash script. The only change: `github-actions-runner` now defaults to `ubuntu-latest` instead of the Viasat-internal `vionix` self-hosted label.

## Usage

```yaml
name: 🎭 codeowners
run-name: 🎭 Validate CODEOWNERS for ${{ github.event.pull_request.title }}

on:
  pull_request:
    paths:
      - ".github/CODEOWNERS"
      - ".github/workflows/**"

jobs:
  codeowners:
    uses: vionix-proj/github-platform/.github/workflows/github-team-codeowners-actions.yaml@main
    with:
      codeowners-file: .github/CODEOWNERS
      fail-on-missing-team: true
    permissions:
      contents: read
      pull-requests: write
    secrets:
      org-read-token: ${{ secrets.ORG_READ_TOKEN }}
```

Always reference `@main` — this is an internal, org-owned workflow repo, so callers are expected to track the latest reviewed version rather than pin a SHA (unlike third-party actions, which this org's own `actions-pin-version-setting-lint.yaml` requires pinning).

## Inputs

| Input | Default | Description |
|---|---|---|
| `github-actions-runner` | `ubuntu-latest` | Runner for every job |
| `yaml-lint-dir` | `.github/workflows` | Directory to yaml-lint |
| `codeowners-file` | `.github/CODEOWNERS` | Path to the CODEOWNERS file to inspect |
| `fail-on-missing-team` | `true` | Fail the check when a CODEOWNERS team/user does not exist in the org, when no CODEOWNERS file is found, or when one exists but references no owners at all. Set `false` only for a repo deliberately not requiring CODEOWNERS yet |

## Secrets

| Secret | Description |
|---|---|
| `org-read-token` | Optional token with `read:org` scope, used to verify CODEOWNERS teams exist. Falls back to the job's `GITHUB_TOKEN`, which may lack cross-org team read — unresolved teams then show as "could not verify" rather than failing. Only needed if the default `GITHUB_TOKEN` can't read team membership (e.g. the CODEOWNERS team lives in a different org than the repo). |

## Jobs

- **📑 yaml-check** — yamllint over `.github/workflows` (or `yaml-lint-dir`), commenting on the PR. Warnings-only for common style nits (line length, trailing spaces, missing final newline).
- **🔧 codeowners-check** — `mszostok/codeowners-validator`, twice: once with `files,duppatterns,syntax` (the `files` check tolerates CODEOWNERS entries for paths that don't exist yet), once with just `syntax,duppatterns`.
- **👥 codeowners-teams** — parses every `@team`/`@user` token out of CODEOWNERS, checks each against the GitHub API (`/orgs/{org}/teams/{slug}` or `/users/{name}`), and publishes a markdown table (step summary + a sticky, upserted PR comment) showing ✅ exists / ❌ missing / ⚠️ unverified for each, plus a one-line summary count. **Fails the job by default** (`fail-on-missing-team: true`) on any ❌, on no CODEOWNERS file being found at all, or on a CODEOWNERS file with zero `@owner` references — set `false` explicitly to make any of these advisory-only instead.

## Prerequisites for a calling repo

1. A `.github/CODEOWNERS` file (any of `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS` are auto-detected by the `codeowners-teams` job; `codeowners-check`'s validator action uses the standard GitHub-recognized locations).
2. `pull-requests: write` permission on the calling job, for the sticky PR comment.
3. If any CODEOWNERS team lives in a different GitHub org than the repo (or the default `GITHUB_TOKEN` otherwise can't read org team membership): an `org-read-token` secret with `read:org` scope.

## Related

See [`../../devsecops-terraform/README.md`](../../devsecops-terraform/README.md) for the sibling Terraform reusable workflow — that product's own "Required GitHub repository settings" section documents the CODEOWNERS + `require_code_owner_reviews` branch-protection setup this workflow validates.
