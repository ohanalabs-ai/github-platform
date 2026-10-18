# devsecops-test

**Test results and code coverage for any dockerized test run**: the rewrite, under `github-platform`, of
the old Vionix
[`docker-compose-devsecops-test-workflow.yaml`](https://github.com/ohanalabs-ai/ohana-github/blob/main/.github/workflows/docker-compose-devsecops-test-workflow.yaml).

| Piece | Status |
|---|---|
| [`actions/test/junit-report`](../../actions/test/junit-report/README.md): JUnit XML / TAP → summary, sticky PR comment, check run + annotations, artifact, outputs | ✅ shipped |
| [`actions/test/coverage-report`](../../actions/test/coverage-report/README.md): Cobertura / JaCoCo / LCOV / Go → badge + Line/Branch/Complexity/Health table, thresholds, sticky PR comment, check run, artifact, outputs | ✅ shipped |
| `.github/workflows/docker-compose-test.yaml`: the reusable workflow that runs a caller's `docker-compose-tests.yaml` phase services and then the two composites | ⏭️ next ([below](#next-the-reusable-workflow)) |

First consumer: Kyverno Chainsaw in planeodev/planeo-infra (`--report-format JUNIT-TEST`).

## What the old workflow did (and where each part went)

| Old workflow | Here |
|---|---|
| `🧹 lint` job: `docker compose -f <lint-file> build/run lint \| tee lint-report.txt`, the output in a console block in the summary, optional problem matchers from `Viasat/vionix/problem-matchers` | next: the reusable workflow's lint phase (a lint tool that writes JUnit, e.g. eslint `-f junit`, can use `junit-report` today) |
| `✅️ test-code` job: `docker compose -f <test-file> build test` + `run test`, the service writing `test-report.xml` / `test-coverage.xml` into the checkout (bind mount via `CURRENT_DIR` in `.env`) | the caller's test step + `junit-report` / `coverage-report` |
| xmllint counts of `//testsuite/@errors\|failures\|skipped\|tests\|time` and `//coverage/@line-rate` | outputs of both composites (from every case, not just the first `<testsuite>`) |
| `irongut/CodeCoverageSummary` (Cobertura; `thresholds: "70 85"`, `fail_below_min`, badge, indicators) + "☂️ Code Coverage Results" sticky comment, collapsed | `coverage-report` (same thresholds, health and badge; plus JaCoCo / LCOV / Go) |
| `test-summary/test-summary-action` + an inline python JUnit → markdown table (✅/❌ per case, totals, overall status) | `junit-report` (also errors/skips, failure messages, suites, durations) |
| inline python that drops passing cases until the JUnit fits a 64 KB comment, "Some test case results were removed to fit to this comment" | `junit-report`'s comment sizing (passing cases dropped first, then failure output shortened) |
| two `marocchino/sticky-pull-request-comment` steps (`recreate: true`, `collapse-pr-comments`) | the built-in sticky comment (delete + recreate, `collapse`) |
| `upload-artifact` `test-results.xml` / `coverage-results.xml` / `native-coverage-results` | each composite's `artifact-name` (a native report is just another `upload-artifact`) |
| `📊️ report` job: SonarQube scan of the coverage file (path rewrite `/viasat/platform/cloud` → workspace, `SONAR_TOKEN`) | **not ported** — a separate scan concern with its own secret; a SonarQube composite can consume the uploaded artifact later |

## The `docker-compose-tests.yaml` contract

The old workflow's interface, kept for the reusable workflow: one compose file per repo
(`docker-compose-tests.yaml`; the old default names were `docker-compose-check-code.yaml` for lint), one
**service per DevSecOps phase** (`lint`, `test`, …), each built and run with `docker compose run`. A
phase writes its reports into a **bind mount of the checkout**, so they land in the workspace where the
composites read them:

```yaml
# docker-compose-tests.yaml (in the caller's repo)
services:
  test:
    build: { context: ., target: test }
    volumes:
      - ${CURRENT_DIR:-.}/build/reports:/app/build/reports   # → build/reports/junit.xml, coverage.xml
```

## Next: the reusable workflow

`docker-compose-test.yaml` (workflow_call), the shape the old workflow had, rebuilt on these composites:
inputs `compose-file` (default `docker-compose-tests.yaml`), `working-directory`, `phases` (default
`lint test`), `test-report-paths` / `coverage-report-paths` (+ `*-format`), `coverage-thresholds`,
`coverage-fail-below-min`, `runner`; per phase a job that checks out the caller, runs
`docker compose -f <file> build <phase>` and `run --rm <phase>` with `CURRENT_DIR=$GITHUB_WORKSPACE`,
then `junit-report` / `coverage-report` with `if: always()`, and a final `📋 run summary`
(`actions/github/run-summary`). Lint output and problem matchers move into a TypeScript step (no bash
`tee`/`awk`).
