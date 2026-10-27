# tracking-issue

Composite [`actions/github/tracking-issue`](../../../actions/github/tracking-issue/action.yaml) (TypeScript via
`actions/github-script`, no npm dependencies): keeps **one** GitHub issue per scheduled check, so a nightly that
fails five nights in a row produces one issue with five comments — not five issues.

| Run outcome (`needs.<job>.result`) | No open issue for `key` | Open issue for `key` |
|---|---|---|
| `failure` | open one (title, label, `body`, run URL) | comment "still failing" + `body` |
| `success` | nothing | comment "green again" and close (`close-on-success: true`, default) |
| `cancelled` / `skipped` | nothing | nothing |

Identity is a hidden marker `<!-- github-platform/tracking-issue:<key> -->` in the issue body. A closed issue is
history: the next failure opens a new one (a regression is a new incident). Every run writes a job summary of what it
did, including "nothing to do" and API errors (which only warn — reporting never fails the job).

```yaml
  track:
    needs: [nightly]
    if: always() && github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions: { issues: write }
    steps:
      - uses: ohanalabs-ai/github-platform/actions/github/tracking-issue@main
        with:
          key: kagent-nightly
          title: "Nightly kagent fork verifier is failing"
          label: nightly-verify
          outcome: ${{ needs.nightly.result }}
          body: "Open the run summary for the per-test table."
```

Self-test: `actions/github/tracking-issue/issue.test.ts` (run by `actions-typescript-selftest.yaml`).
First caller: `planeodev/planeo-infra` `.github/workflows/kagent-nightly-verify.yml`.
