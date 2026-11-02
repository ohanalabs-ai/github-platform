# devsecops-openapi

Reusable workflow: [`devsecops-openapi.yaml`](../../.github/workflows/devsecops-openapi.yaml) — **is this API contract healthy, and does the code generated from it match?** For a repo whose HTTP API is described by OpenAPI specs and whose server/client code is generated from them (Go today).

```
pull request / push
 ├─ 🔎 lint       vacuum over every spec in spec-paths — an error fails
 ├─ 🔁 drift      setup-go (go-version-file) → generate-command → fail if `git status --porcelain` is non-empty
 ├─ 💥 breaking   oasdiff: each spec at the PR base vs the PR head (skipped on push, and per new file);
 │                fails ONLY when breaking-change-mode=enforce
 └─ 🧭 report     needs: all three · ONE sticky PR comment (hidden marker, delete-and-recreate) · outputs
```

All logic is TypeScript under [`actions/openapi/`](../../actions/openapi/) run by `actions/github-script` — no npm dependencies, no Python, no bash logic; the only subprocesses are the tools (`vacuum`, `oasdiff`, `go`, `git`, `tar`). The helpers are checked out at the reusable's own commit (`job.workflow_sha`, sparse), so a caller on `@<branch>` runs that branch's code. Every job writes a step summary on every outcome (failure included) and ends with the shared `📋 run summary`; no secrets are involved.

## Use

```yaml
name: 🧭 openapi
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: write   # the sticky comment
jobs:
  openapi:
    uses: ohanalabs-ai/github-platform/.github/workflows/devsecops-openapi.yaml@main
    with:
      spec-paths: |
        api/openapi.yaml
        api/admin.yaml
      # generate-command: go generate ./...   # default; "" skips the drift job
      # go-version-file: go.mod               # repo-root relative
      # working-directory: .                  # where generate-command runs
      # breaking-change-mode: advisory        # or enforce
```

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `spec-paths` (required) | — | OpenAPI files, one **repo-root-relative** path per line (`[A-Za-z0-9._-/@+]` only; `..`/absolute are rejected) |
| `generate-command` | `go generate ./...` | Run in `working-directory` after setup-go; empty skips the drift job |
| `go-version-file` | `go.mod` | Read by `actions/setup-go` (repo-root relative) |
| `working-directory` | `.` | cwd of the generate command (the drift check itself is the whole tree) |
| `breaking-change-mode` | `advisory` | `advisory` reports breaking changes; `enforce` fails the job on one |
| `base-ref` | _(PR base)_ | Advanced, additive: compare against this ref/SHA (used by the self-test; also makes the check run on push) |
| `fail-on-findings` | `true` | Advanced, additive: `false` = findings never fail a job; the `failed` output still says what would have |

No secrets. Outputs: `breaking` (true/false — at least one oasdiff *error*-level change), `drift` (true/false), and `failed` (true when a gate would block: lint error, drift or generate failure, breaking under `enforce`).

## What each check means

- **lint** — [vacuum](https://github.com/daveshanley/vacuum) with its default ruleset; only **errors** fail (warnings are listed). It is a Go binary, not an npm package.
- **drift** — the committed generated code must equal what `generate-command` produces. Untracked and modified files both count; the reusable's own helper checkout (`.openapi-platform/`) is excluded. The stale files are listed in the summary and the comment. A generate command that exits non-zero fails the job.
- **breaking** — [oasdiff](https://github.com/oasdiff/oasdiff) `breaking`, comparing the spec at the PR base with the head. The base is a second `git worktree`, so relative `$ref`s resolve in both trees. Only oasdiff's *error* level counts as breaking (warnings/infos are listed as "other"). A spec that is new in the PR is skipped; one deleted in the PR is flagged for manual review. In `advisory` the comment says so and the job is green.
- **report** — one comment per (working-directory, spec-paths) pair, identified by a hidden marker, deleted and recreated each run so it is always newest. A token that cannot write (fork PR) only warns.

## Pinned tools

Pinned by version **and** the SHA-256 of the release archive (verified before unpacking; a mismatch fails the job). The table lives in [`actions/openapi/tools.ts`](../../actions/openapi/tools.ts) — bump it there, from the release's `checksums.txt`, together with this table.

| Tool | Version | License | linux/x64 archive SHA-256 |
|---|---|---|---|
| vacuum | 0.36.2 | MIT | `5736f27a806888f7ed89fba6bb8a3a00e5da895f1ad870f699b3018b7c8bcb0d` (`vacuum_0.36.2_linux_x86_64.tar.gz`) |
| oasdiff | 1.35.0 | Apache-2.0 | `a8023002fcb2eaa7f5758148a9303cb63d33b939886df312268bc0fc7b939140` (`oasdiff_1.35.0_linux_amd64.tar.gz`) |

Third-party actions (`actions/checkout`, `actions/setup-go`, `actions/github-script`) are pinned by commit SHA.

## Tests

- Unit: `actions/openapi/*.test.ts` (`node --test`, run by [`actions-typescript-selftest.yaml`](../../.github/workflows/actions-typescript-selftest.yaml)) — path/mode parsing, vacuum and oasdiff output parsing, porcelain parsing, the gate, the markdown, checksum verification.
- End to end: [`devsecops-openapi-selftest.yaml`](../../.github/workflows/devsecops-openapi-selftest.yaml) against `tests/openapi/` — **clean → pass**, **drift → `drift=true`, `failed=true`**, **breaking + enforce → `breaking=true`, `failed=true`**, **breaking + advisory → the job passes** with the advisory comment. The "must fail" cases run with `fail-on-findings: false` (an intentionally red job would turn the whole run red) and the verdict job asserts the `failed` output. The breaking cases compare against a fixed commit (`base-ref`): the compatible v1 of the fixtures.
