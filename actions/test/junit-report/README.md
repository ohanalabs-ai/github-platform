# ✅ test/junit-report

Publish the results of **any** test run (typically a dockerized one: `docker compose run test`,
`docker run <tools-image> chainsaw test …`) from the **JUnit XML** or **TAP** files it wrote:

- **job summary**, on every outcome: verdict, a Total / Passed / Failed / Errors / Skipped / Duration
  table, the exact command (`command`), every failing case with its message and body (stack trace, diff),
  a per-suite table and a folded table of every case; "no report matched" and unreadable files are
  reported too;
- **sticky PR comment** (`pull_request` events): recreated on each run, sized to GitHub's 65 536-char
  limit by dropping passing cases first (then shortening failure output), linking back to the full
  summary;
- **check run** (opt-in): conclusion + up to 50 failure annotations, on the file/line when the report
  names one (pytest, gotestsum), else on the report file;
- **artifact** with the raw reports; **outputs** with the counts.

Generalized from the test-report steps of the old
[`docker-compose-devsecops-test-workflow.yaml`](https://github.com/ohanalabs-ai/ohana-github/blob/main/.github/workflows/docker-compose-devsecops-test-workflow.yaml)
(its python JUnit table, `test-summary/test-summary-action`, the 64 KB "failures only" truncation and the
two `marocchino/sticky-pull-request-comment` steps). Everything is TypeScript run by `actions/github-script`
— no npm dependency; the XML reader is [`../lib/xml.ts`](../lib/xml.ts).

## Formats

| `format` | Reads | Verified with |
|---|---|---|
| `junit` | `<testsuites>` or a single `<testsuite>` root, nested suites, `<failure>` / `<error>` / `<skipped>` with the text in the `message` attribute, the body (incl. CDATA) or both | Kyverno Chainsaw v0.2.15 `JUNIT-TEST`, `JUNIT-STEP`, `JUNIT-OPERATION` (real runs) + Chainsaw's own testdata, pytest, Maven surefire — [`../fixtures/junit/`](../fixtures/junit/) |
| `tap` | TAP 12/13/14: `ok` / `not ok`, `# SKIP`, `# TODO` (counted as skipped), `Bail out!` (error), YAML diagnostics (`message`, `duration_ms`) | `node --test` output — [`../fixtures/tap/`](../fixtures/tap/) |
| `auto` (default) | sniffs each file: XML → JUnit, `TAP version` / `ok` / `1..N` → TAP | |

Chainsaw: `JUNIT-TEST` gives one case per test (suite = test directory); `JUNIT-STEP` one case per step,
cleanup steps included (suite = test); `JUNIT-OPERATION` one case per operation, the operation type
(`apply`, `assert`, …) as the class. The generic `XML` format is deprecated since Chainsaw v0.2.10 — use
a `JUNIT-*` one.

## Inputs

| Input | Default | |
|---|---|---|
| `paths` | **required** | Files, globs or directories (newline/comma separated, workspace-relative, `!` excludes). A directory = `<dir>/**/*.xml` (+ `*.tap` with `auto`) |
| `format` | `auto` | `auto` \| `junit` \| `tap` |
| `title` | `✅ Test results` | Heading; also keys the sticky comment — give each report in a job its own |
| `command` | `''` | How the tests ran, shown verbatim. Never a secret |
| `comment` | `true` | Sticky PR comment on `pull_request` events (needs `pull-requests: write`; without it: a warning) |
| `comment-key` | slug of `title` | Sticky-comment identity |
| `collapse` | `true` | Fold the per-case table in the comment |
| `check-run` | `false` | Create a check run with annotations (needs `checks: write`) |
| `check-name` | `title` | |
| `fail-on-failure` | `false` | Fail the step on failed/errored cases or an unreadable report. Default: report only — the test step's own exit code gates the job |
| `fail-on-empty` | `false` | Fail when nothing matched (default: warning) |
| `artifact-name` | `test-results` | Raw-report artifact; `''` = no upload. Unique per run — add the matrix leg |
| `artifact-retention-days` | `''` | Repository default when empty |
| `github-token` | `${{ github.token }}` | |

## Outputs

`total`, `passed`, `failed`, `errors`, `skipped`, `duration` (seconds), `conclusion`
(`success` \| `failure` \| `neutral` = no test cases), `files` (matched report count), `markdown-file`
(the rendered report under `$RUNNER_TEMP`, for reuse).

## Examples

Kyverno Chainsaw in a tools container (the planeodev/planeo-infra shape):

```yaml
permissions:
  contents: read
  pull-requests: write   # sticky comment
  checks: write          # only with check-run: true
steps:
  - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
  - name: 🧪 chainsaw
    run: >-
      docker run --rm --network host -v "$PWD:$PWD" -w "$PWD" -e KUBECONFIG
      ghcr.io/kyverno/chainsaw:v0.2.15 test tests/chainsaw
      --report-format JUNIT-TEST --report-path "$PWD/reports" --report-name chainsaw
  - name: ✅ chainsaw report
    if: always()
    uses: ohanalabs-ai/github-platform/actions/test/junit-report@main
    with:
      paths: reports/chainsaw.xml
      title: 🧪 Chainsaw functional tests
      command: chainsaw test tests/chainsaw --report-format JUNIT-TEST
      check-run: "true"
      artifact-name: chainsaw-junit
```

Chainsaw appends `.xml` to `--report-name`; the same keys can live in `.chainsaw.yaml`
(`spec.report: {format: JUNIT-TEST, path: reports, name: chainsaw}`). Run the container as the runner
user (`--user "$(id -u):$(id -g)"`) or make `reports/` writable — Chainsaw writes the file mode `0600`.

A `docker-compose-tests.yaml` `test` service that writes `build/reports/junit.xml` into a bind mount:

```yaml
  - run: docker compose -f docker-compose-tests.yaml run --rm test
  - if: always()
    uses: ohanalabs-ai/github-platform/actions/test/junit-report@main
    with:
      paths: build/reports/junit.xml
      command: docker compose -f docker-compose-tests.yaml run --rm test
```

Coverage from the same run: [`../coverage-report`](../coverage-report/README.md).

## Tests

[`junit.test.ts`](junit.test.ts) (parsers, rendering, the comment-size fitting, outputs, annotations) and
[`../lib/lib.test.ts`](../lib/lib.test.ts) run in `actions-typescript-selftest.yaml`;
[`test-reports-selftest.yaml`](../../../.github/workflows/test-reports-selftest.yaml) runs the composite
end to end on the fixtures and asserts its outputs.
