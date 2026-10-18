# ☂️ test/coverage-report

Publish **code coverage** written by any test run (typically a dockerized one) from **Cobertura**,
**JaCoCo**, **LCOV** or **Go coverprofile** files:

- **job summary**, on every outcome: a coverage badge, then per report a Package / Line rate / Branch
  rate / Complexity / Health table with a **Summary** row; an **Overall** line across several reports;
  "no report matched" and unreadable files are reported too;
- **sticky PR comment** (`pull_request` events) — the old workflow's "☂️ Code Coverage Results";
- **check run** (opt-in): failure when below the low threshold;
- **artifact** with the raw files; **outputs** with the rates.

Generalized from the coverage steps of the old
[`docker-compose-devsecops-test-workflow.yaml`](https://github.com/ohanalabs-ai/ohana-github/blob/main/.github/workflows/docker-compose-devsecops-test-workflow.yaml),
which ran `irongut/CodeCoverageSummary` (Cobertura only) with `thresholds: "70 85"`, `fail_below_min`,
`badge`, `indicators` and a collapsed sticky comment. Same thresholds and health semantics here, in
TypeScript run by `actions/github-script` — no npm dependency, no container.

## Formats

| `format` | Reads | Groups | Fixture |
|---|---|---|---|
| `cobertura` | coverage.py / pytest-cov, istanbul `cobertura`, coverlet, gcovr, gocover-cobertura | `<package>`; counts from the class `<line>`s (branches from `condition-coverage`), the root's `lines-*` / `branches-*` as totals; falls back to the `*-rate` attributes | [`cobertura-coveragepy.xml`](../fixtures/coverage/cobertura-coveragepy.xml) |
| `jacoco` | JaCoCo XML (DOCTYPE, nested `<group>`s) | `<package>` `LINE` / `BRANCH` / `COMPLEXITY` counters | [`jacoco.xml`](../fixtures/coverage/jacoco.xml) |
| `lcov` | istanbul/nyc/c8/jest `lcov`, gcov/lcov, `cargo llvm-cov --lcov` | source directory (common prefix stripped); `LF`/`LH`/`BRF`/`BRH`, else counted from `DA`/`BRDA` | [`lcov.info`](../fixtures/coverage/lcov.info) |
| `go` | `go test -coverprofile` (any mode; merged duplicate blocks keep the max count) | package directory; **statements**, no branches | [`go-cover.out`](../fixtures/coverage/go-cover.out) |
| `auto` (default) | sniffs each file | | |

A report with line data but no branch data (coverage.py without `--branch`, Go) shows `—`, not 0%.

## Inputs

| Input | Default | |
|---|---|---|
| `paths` | **required** | Files, globs or directories (newline/comma separated, workspace-relative, `!` excludes). A directory = `<dir>/**/*.{xml,info,lcov,out}` with `auto` |
| `format` | `auto` | `auto` \| `cobertura` \| `jacoco` \| `lcov` \| `go` |
| `title` | `☂️ Code coverage` | Heading; also keys the sticky comment |
| `command` | `''` | How the coverage was collected, shown verbatim. Never a secret |
| `thresholds` | `70 85` | `"<low> <high>"`: ❌ below low · ➖ between · ✅ at/above high |
| `fail-below-min` | `false` | Fail the step when the overall line rate is below `low` |
| `fail-on-empty` | `false` | Fail when nothing matched (default: warning) |
| `badge` | `true` | shields.io badge (the image URL carries only the percentage) |
| `comment` | `true` | Sticky PR comment on `pull_request` events (needs `pull-requests: write`) |
| `comment-key` | slug of `title` | |
| `collapse` | `true` | Fold each report's table in the comment |
| `check-run` | `false` | Create a check run (needs `checks: write`) |
| `check-name` | `title` | |
| `artifact-name` | `coverage-results` | Raw-file artifact; `''` = no upload. Unique per run |
| `artifact-retention-days` | `''` | |
| `github-token` | `${{ github.token }}` | |

## Outputs

`line-rate` / `branch-rate` (percentages with two decimals; `''` when absent), `lines-covered`,
`lines-valid`, `branches-covered`, `branches-valid`, `health` (`healthy` \| `warning` \| `unhealthy` \|
`unknown`), `below-min` (`true`/`false`), `files`, `markdown-file`.

## Example

```yaml
  - run: docker compose -f docker-compose-tests.yaml run --rm test   # writes build/reports/coverage.xml
  - name: ☂️ coverage
    if: always()
    uses: ohanalabs-ai/github-platform/actions/test/coverage-report@main
    with:
      paths: build/reports/coverage.xml
      thresholds: "70 85"
      fail-below-min: "true"
```

Paths inside the report (Cobertura `<source>`, LCOV `SF:`) are shown as written — a container path
(`/app/src/...`) is fine for the summary. Sonar-style path rewriting stays with the SonarQube step.

## Tests

[`coverage.test.ts`](coverage.test.ts) (every parser, thresholds, badge, rendering, outputs) runs in
`actions-typescript-selftest.yaml`; [`test-reports-selftest.yaml`](../../../.github/workflows/test-reports-selftest.yaml)
runs the composite end to end on [`../fixtures/coverage/`](../fixtures/coverage/) and asserts its outputs.
