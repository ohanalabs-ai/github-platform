# upstream-release-watch

**Workflow:** [`.github/workflows/upstream-release-watch.yaml`](../../../.github/workflows/upstream-release-watch.yaml) ·
**Logic:** [`actions/github/release-watch/watch.ts`](../../../actions/github/release-watch/watch.ts) (TypeScript via `actions/github-script`, no npm deps; `watch.test.ts` runs in `actions-typescript-selftest.yaml`)

"Has upstream shipped what we are blocked on?" — answered on a schedule, so nobody polls release
pages by hand. The caller owns a **watch list**; the reusable reads each entry's GitHub Releases
(`repos.listReleases`, up to 300), keeps the **GA** ones whose tag matches, evaluates the entry's
conditions against the newest few releases **newer than the caller's current pin**, and reports.

## Caller

```yaml
name: 🔭 upstream release watch
run-name: 🔭 upstream release watch — R1 blockers
on:
  schedule: [{ cron: "0 9 * * 1" }]   # weekly
  workflow_dispatch: {}
permissions: { contents: read, issues: write }
jobs:
  watch:
    permissions: { contents: read, issues: write }
    uses: ohanalabs-ai/github-platform/.github/workflows/upstream-release-watch.yaml@main
    with:
      watch-file: .github/upstream-watch.yaml
```

| Input | Default | |
|---|---|---|
| `watch-file` | `.github/upstream-watch.yaml` | the list in the caller repo — `.yaml`/`.yml` parsed with `yq`, `.json` as JSON |
| `create-issues` | `true` | open/update one issue per met entry; `false` = summary only |
| `fail-on-error` | `true` | fail when an entry could not be evaluated (API error, bad regex). Met/waiting never fail |
| `runs-on` | `ubuntu-latest` | |

Outputs: `results` (JSON, one object per entry) and `met` (JSON `[{name, version, url}]`).

## Watch list

```yaml
target: "1.37"                     # {target} placeholder + default issue title
label: eks-1.37                    # label on the issues (created if missing; default upstream-watch)
titleTemplate: "R1 unblocked: {name} {version} supports Kubernetes {target}"
entries:
  - name: external-secrets         # unique; also the issue's dedupe key
    repo: external-secrets/external-secrets
    current: 2.7.0                 # the pin you run — only NEWER releases are evaluated
    tagPattern: '^v\d'             # ignore other tag families (helm-chart-*)
    includePrerelease: false       # default; GitHub's flag OR a semver suffix (-alpha13) = pre-release
    match: all                     # all (default) | any
    maxCandidates: 3               # newest releases evaluated (default 3)
    titleTemplate: "…"             # per-entry issue title (optional)
    note: "free text shown in the summary and the issue"
    conditions:
      - minVersion: 2.13.0                          # semver ≥
      - notesMatch: 'Kubernetes {target}'           # regex (i, m) on the release body
      - fileMatch:                                  # regex (m) on a file
          path: docs/introduction/stability-support.md
          pattern: '^\|\s*{minor}\s*\|[^|\n]*{target}'
          # repo: other/repo   (default: the entry's repo)
          # ref: main          (default: "{tag}" — the release's tag)
```

Placeholders `{version}` `{minor}` `{tag}` `{target}` are substituted **regex-escaped** in patterns
(raw in `ref` and titles). The version is the first `x.y[.z][-pre]` in the tag (`v1.20.2`,
`argo-cd-10.10.3`, `policy-controller-0.10.8`), and releases are ordered by semver, not by publish
date (a `v1.20.4` patch published after `v1.21.2` is not "latest").

## Notification

For every **met** entry the reusable keeps exactly one issue in the caller repo, found by the hidden
marker `<!-- upstream-release-watch:<name> -->` among issues carrying the label:

- none → **opened** (label created if missing);
- open → **updated** when the title/body changed (the body carries no run URL, so a stable finding does not churn);
- closed → **left alone** — closing it is the human acknowledgement; it is never reopened.

Waiting entries never touch issues. Delivery is GitHub's normal new-issue notification to the repo's
watchers; there is no Slack or Jira write from CI.

## Run summary

Always published: the 🔭 table (✅ met / ⏳ waiting / ❌ error, current pin, latest GA, the release that
met it, per-condition evidence, the issue action) plus the 📋 step-outcome table (`if: always()`, with
an inline fallback if the helpers checkout itself failed). An invalid watch list fails with its own
summary section naming the problem.
