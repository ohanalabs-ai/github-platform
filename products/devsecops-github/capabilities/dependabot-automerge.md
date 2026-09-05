# dependabot-automerge

Reusable workflow: [`dependabot-automerge.yaml`](../../../.github/workflows/dependabot-automerge.yaml) — waits for one named check on a Dependabot PR (e.g. a Terraform `plan`), posts a sticky PR comment with the dependency metadata and that check's real outcome as evidence for a human's own approve/merge decision, and **fails the workflow itself if that check did not succeed**.

**v1 is evidence + a failing check — it does not auto-approve or auto-merge.** That's a deliberate, current scope decision, not a limitation of the mechanism: see "Path to v2" below for what auto-merge would actually need.

## Why this exists, and why it's narrower than the workflow that inspired it

Inspired by Viasat/vionix's `.github/workflows/github-ghas-dependabot-reviews.yaml` (`docs/workflows/github-ghas-dependabot-reviews.md`), which automates the full Dependabot lifecycle — GHAS dependency/license review, config validation, auto-approve, auto-merge. That workflow **hard-requires GitHub Advanced Security (GHAS)** to be enabled: every job downstream of its own `ghas-status` check skips entirely if it isn't. Checked live against `planeodev/eks-cluster`: `security_and_analysis.code_security` is `"disabled"` there — porting that workflow as-is would have been a complete no-op.

Rather than ship something that silently does nothing, this workflow implements just the capability actually needed — "show evidence of whether a Dependabot PR's specific check (e.g. a Terraform plan) passed, and fail loudly if it didn't" — using `dependabot/fetch-metadata` + `fountainhead/action-wait-for-check` + a sticky PR comment (the same evidence-posting pattern `codeowners-validation`'s `codeowners-teams` job uses), with no GHAS dependency at all.

## Usage

```yaml
name: 🤖 dependabot-automerge
run-name: 🤖 Dependabot evidence for ${{ github.event.pull_request.title }}

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  dependabot-evidence:
    if: github.actor == 'dependabot[bot]'
    permissions:
      contents: read
      pull-requests: write
    uses: vionix-proj/github-platform/.github/workflows/dependabot-automerge.yaml@main
    with:
      wait-for-check-name: "terraform / 📝️ plan"
```

Always reference `@main` — this is an internal, org-owned workflow repo, so callers are expected to track the latest reviewed version rather than pin a SHA.

## Inputs

| Input | Default | Description |
|---|---|---|
| `github-actions-runner` | `ubuntu-latest` | Runner for every job |
| `wait-for-check-name` | *(required)* | Exact name of the check to wait for and report on — must match the real check name (e.g. `"terraform / 📝️ plan"`, shaped `<calling-job-id> / <nested-job-name>` for a reusable-workflow caller) |
| `wait-timeout-seconds` | `600` | How long to wait for that check before giving up |
| `allowed-semver-types` | `semver-patch,semver-minor` | Comma-separated update types this reports as "in policy" — informational only in v1; changes the comment's language, not whether anything merges |

## Jobs

- **🔍 validate-inputs** — fails fast if called from a non-Dependabot actor, or with an empty `wait-for-check-name`.
- **📋 evidence-report** — fetches Dependabot's own PR metadata (dependency name, update type), waits for `wait-for-check-name` to conclude, posts a sticky PR comment (recreated on every push) showing dependency/update-type/semver-policy/check-result, **and fails the job (`exit 1`) if the reported check's conclusion was not `success`** — so an unhealthy dependency update shows up as a red check on the PR itself, not just a comment someone might not read.

## Path to v2 (auto-approve + auto-merge) — not built yet, deliberately

Two real prerequisites, confirmed unmet or unverified live against `eks-cluster`:

1. **`allow_auto_merge` must be `true` on the repo** (confirmed `false` on `eks-cluster` at the time this was written) — `gh pr merge --auto` fails outright otherwise.
2. **The org's "Allow GitHub Actions to create and approve pull requests" policy must allow it** — unverified (checking it needs `admin:org` token scope this session didn't have). If it's off, an auto-approve step using the workflow's own `GITHUB_TOKEN` silently does nothing, which is the *safe* failure mode (the PR just waits for a human) but means auto-merge wouldn't actually engage even if wired.

If/when both are confirmed and deliberately enabled, v2 would add `hmarr/auto-approve-action` + `gh pr merge --auto` gated on the same check-passed condition this v1 already computes — the evidence-gathering logic doesn't need to change, only what happens after.

## Related

See [`../../devsecops-terraform/README.md`](../../devsecops-terraform/README.md) for the Terraform reusable workflow whose `plan` check this is designed to key off of.
