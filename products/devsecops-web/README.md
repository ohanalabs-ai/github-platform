# devsecops-web

Reusable workflow: [`web-preview-review.yaml`](../../.github/workflows/web-preview-review.yaml) (`🔭 web-preview-review`). It is the human **visual LGTM** gate of a per-PR web preview: the PR's site is already deployed, at a URL, by your own GitOps or preview system, and a person must look at it before the PR is considered done.

| Job | What it does |
|---|---|
| **🔎 preview ready** | Waits until the preview **image** exists in the registry, e.g. `ghcr.io/<org>/<repo>/pr/<N>:head-<head sha>` (the [`docker-multiarch-cicd.yaml`](../devsecops-docker/README.md) head tag). With `probe-url: true` it also waits for the URL; use that only on a runner that can reach the preview, such as a tailnet node. It then builds a **"what to verify visually"** checklist from the PR's changed files and your rules file, and publishes it to the **run summary**, the `checklist` output and **one sticky PR comment** (edited in place). |
| **⏳ preview deployed** (opt-in) | With `deploy-status-context` set (e.g. `preview/deployed`), waits up to `deploy-wait-minutes` (20) until that **commit status is `success` on the PR head sha**. The GitOps side sets it once the preview runs this commit and passed its in-cluster smoke test, e.g. Argo CD Notifications after a PostSync hook. A `failure` is not final, because Argo CD retries the sync; on timeout the job names the last state and `argocd-app`. The runner never reaches the preview. Needs `statuses: read`. |
| **👀 visual review** | Runs in **your Environment** (`environment`, default `website-preview`) with `url` = the preview. The PR shows **"Deployed to website-preview → View deployment"**, and the run pauses on GitHub's **Review deployments** button. Approving means **"a visual LGTM of the preview"**. That dialog cannot show custom text, so the checklist sits on the same run page (summary) and is re-printed with the approver in this job's summary. |

## Caller

```yaml
  preview:
    name: 🔭 preview
    needs: docker # the build that pushes pr/<N>:head-<sha>
    if: github.event_name == 'pull_request' && github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    uses: ohanalabs-ai/github-platform/.github/workflows/web-preview-review.yaml@<sha> # main
    permissions: { contents: read, packages: read, pull-requests: write, statuses: read }
    with:
      url: https://landing-pr${{ github.event.pull_request.number }}.platform.planeo.dev
      image: ghcr.io/${{ github.repository }}/pr/${{ github.event.pull_request.number }}:head-${{ github.event.pull_request.head.sha }}
      environment: website-preview
      rules-file: .github/preview-checklist.json
      deploy-status-context: preview/deployed # opt-in ⏳; needs statuses: read in `permissions`
      argocd-app: landing-pr-${{ github.event.pull_request.number }}
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

`contents: read` (the rules file), `packages: read` (the image check, using `GITHUB_TOKEN`), `pull-requests: write` (the sticky comment), `statuses: read` (⏳, only with `deploy-status-context`). No secrets.

Fork PRs: gate the caller job on `head.repo.full_name == github.repository`, as above. Forks get no write token, and their previews are not deployed.

## Code

TypeScript run by `actions/github-script`, no npm dependencies, in [`actions/web/preview-review/`](../../actions/web/preview-review/):
- `checklist.ts` holds the pure glob, rules and markdown logic, tested by `checklist.test.ts` through `actions-typescript-selftest.yaml`;
- `prepare.ts` runs 🔎;
- `deploy-wait.ts` runs ⏳, with its pure logic in `deploy-status.ts`, tested by `deploy-status.test.ts`;
- `gate.ts` runs 👀.

---

# 📸 web-pr-rundown

Reusable workflow: [`web-pr-rundown.yaml`](../../.github/workflows/web-pr-rundown.yaml). It puts **screenshots and checks of a web PR in the PR itself**, so
designers, frontend/backend engineers and agents can review without opening the preview. It needs no preview URL: the job runs the PR's image
(and a baseline image) on the runner's localhost and drives them with Playwright.

| What | How |
|---|---|
| Pages | every page reachable from `/` (BFS over internal links, `max-pages`), or the `pages` list |
| Screenshots | full page at each `viewports` width (default 390 / 768 / 1440); animations frozen, every video painted as its poster (a frame depends on load timing), reveals scrolled through, and a second capture of the PR page masks whatever still moves on its own — so the same image diffs at 0 % |
| Before / after | pixel diff vs the baseline = the newest `<base-image-repo>:<base branch>-<sha7>` among the base branch's last 15 commits; per view and per top-level `<section>` (paired by id → aria-label → heading); only changed sections are cropped |
| Videos | the media URL answers; a muted `play()` really plays; `autoplay` videos play by themselves and are muted |
| Problems | console errors, failed requests (network failure or HTTP ≥ 400), broken internal links / missing anchors, the caller's deny-list over the rendered DOM (text, alt/title/aria-label/placeholder, meta, title) and every text response |
| Output | ONE sticky PR comment (images inline), the run summary, the artifact `pr-rundown-<N>` with `rundown.json` (schema `web-pr-rundown/v1`, [`rundown.ts`](../../actions/web/pr-rundown/rundown.ts)) + every screenshot |

Deny-list findings are reported as **the deny-list line number + a selector**, never the matched text; console and request text is redacted
(█) before it is written anywhere.

## Caller

```yaml
  rundown:
    needs: docker # the job that pushes the PR image
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    uses: ohanalabs-ai/github-platform/.github/workflows/web-pr-rundown.yaml@<sha> # main
    permissions: { contents: write, packages: read, pull-requests: write }
    with:
      image: ghcr.io/<org>/<repo>/pr/${{ github.event.pull_request.number }}:head-${{ github.event.pull_request.head.sha }}
      base-image-repo: ghcr.io/<org>/<repo>
      container-port: 3000
```

Run it on `closed` too (`types: [opened, synchronize, reopened, closed]`): the `🧹 prune` job deletes the PR's screenshots branch.

## Where the images live

The REST API cannot attach an image to a comment. The screenshots are committed to a per-PR orphan branch **`pr-rundown-<N>`**
(`assets-branch-prefix`) as one **parentless** commit, force-rewritten on every run and deleted when the PR closes: the repo never keeps their
history, and two PRs never write the same ref. The comment links `https://github.com/<owner>/<repo>/blob/pr-rundown-<N>/shots/…?raw=true`, which
renders for anyone who can read the repo, private repos included. If the repo protects branches by a wildcard rule that matches
`pr-rundown-*`, exempt that pattern (the workflow's token must be able to force-push it).

## Failing the job

`fail-on` (default `denylist,video`) chooses which findings fail the job; the comment always shows every finding. Add `links`, `console` or
`requests` to make those blocking, or pass `''` to report only.

## Code

- `actions/web/pr-rundown/rundown.ts`: the pure part (schema + validation, deny-list parse/scan/redact, section pairing, branch/URL layout,
  failure policy, the comment). Tests: `rundown.test.ts` (node:test, run by `actions-typescript-selftest.yaml`).
- `resolve.ts` (wait for the image, find the baseline), `run.ts` (start both images, run the capture), `publish.ts` (screenshots branch + sticky
  comment + summary), `prune.ts` (on close): TypeScript via `actions/github-script`, no npm dependencies.
- `capture/capture.ts`: the capture tool. It runs **inside** `mcr.microsoft.com/playwright` (pinned by digest in the workflow) with `playwright`
  as its only dependency, locked in `capture/package-lock.json` at the image's exact version (the tools-image pattern). Bump both together.
- Run it locally against any two servers:
  `docker run --rm --network host -v $PWD/actions/web/pr-rundown:/a -v $PWD/out:/out -w /a/capture -e HEAD_URL=http://127.0.0.1:3300 -e BASE_URL=http://127.0.0.1:3301 -e OUT=/out <playwright image> sh -c 'npm ci && node capture.ts'`.
