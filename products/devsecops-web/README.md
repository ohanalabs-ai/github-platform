# devsecops-web

Reusable workflow: [`web-preview-review.yaml`](../../.github/workflows/web-preview-review.yaml) (`🔭 web-preview-review`). It is the human **visual LGTM** gate of a per-PR web preview: the PR's site is already deployed, at a URL, by your own GitOps or preview system, and a person must look at it before the PR is considered done.

| Job | What it does |
|---|---|
| **🔎 preview ready** | Waits until the preview **image** exists in the registry, e.g. `ghcr.io/<org>/<repo>/pr/<N>:head-<head sha>` (the [`docker-multiarch-cicd.yaml`](../devsecops-docker/README.md) head tag). With `probe-url: true` it also waits for the URL; use that only on a runner that can reach the preview, such as a tailnet node. It then builds a **"what to verify visually"** checklist from the PR's changed files and your rules file, and publishes it to the **run summary**, the `checklist` output and **one sticky PR comment** (edited in place). |
| **👀 visual review** | Runs in **your Environment** (`environment`, default `website-preview`) with `url` = the preview. The PR shows **"Deployed to website-preview → View deployment"**, and the run pauses on GitHub's **Review deployments** button. Approving means **"a visual LGTM of the preview"**. That dialog cannot show custom text, so the checklist sits on the same run page (summary) and is re-printed with the approver in this job's summary. |

## Caller

```yaml
  preview:
    name: 🔭 preview
    needs: docker # the build that pushes pr/<N>:head-<sha>
    if: github.event_name == 'pull_request' && github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    uses: ohanalabs-ai/github-platform/.github/workflows/web-preview-review.yaml@<sha> # main
    permissions: { contents: read, packages: read, pull-requests: write }
    with:
      url: https://landing-pr${{ github.event.pull_request.number }}.platform.planeo.dev
      image: ghcr.io/${{ github.repository }}/pr/${{ github.event.pull_request.number }}:head-${{ github.event.pull_request.head.sha }}
      environment: website-preview
      rules-file: .github/preview-checklist.json
```

The check names are `<caller job id> / 🔎 preview ready` and `<caller job id> / 👀 visual review`, e.g. `preview / 👀 visual review`. To make the LGTM **required for merge**, add that name to the branch protection's required status checks. That is a repo-admin step, not this workflow.

## Rules file (in the caller repo)

```json
{
  "title": "Visual LGTM of the website preview",
  "rules": [
    { "name": "Film + hero media", "globs": ["public/film/**"], "items": ["the hero loop plays", "the teaser card opens the film"] }
  ],
  "generic": ["mobile / iOS Safari", "dark + light", "no CSP errors in the console"]
}
```

- Globs: `**` matches any depth, `*` matches within one path segment, `?` matches one character.
- Every rule with at least one matching changed file adds a section, with up to 8 of the matched files.
- `generic` always applies.
- A missing file gives the generic list only, with a warning.

## The Environment (once, by a repo admin; not created by this workflow)

Settings → Environments → **New environment**:

1. **Name:** the `environment` input (`website-preview`). Use **one fixed name**, never a per-PR name: protection rules attach to a name.
2. **Description:** "visual LGTM of the preview".
3. **Required reviewers:** the owner, or better a team, so a membership change does not touch the Environment.
4. **Deployment branches and tags: "No restriction"** (`deployment_branch_policy: null`). A `pull_request` run's ref is `refs/pull/<N>/merge`. Any branch rule (protected branches only, or a `main` pattern) rejects the job before a runner starts, with zero steps and no error that says why. See [devsecops-terraform → Environment](../devsecops-terraform/README.md).

Equivalent API call (an admin token; reviewer ids from `gh api users/<login> --jq .id` or `orgs/<org>/teams/<slug> --jq .id`):

```
gh api -X PUT repos/<owner>/<repo>/environments/website-preview \
  -F 'reviewers[][type]=User' -F 'reviewers[][id]=<user id>' -F 'deployment_branch_policy=null'
```

## Permissions

`contents: read` (the rules file), `packages: read` (the image check, using `GITHUB_TOKEN`), `pull-requests: write` (the sticky comment). No secrets.

Fork PRs: gate the caller job on `head.repo.full_name == github.repository`, as above. Forks get no write token, and their previews are not deployed.

## Code

TypeScript run by `actions/github-script`, no npm dependencies, in [`actions/web/preview-review/`](../../actions/web/preview-review/):
- `checklist.ts` holds the pure glob, rules and markdown logic, tested by `checklist.test.ts` through `actions-typescript-selftest.yaml`;
- `prepare.ts` runs 🔎;
- `gate.ts` runs 👀.
