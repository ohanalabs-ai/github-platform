# agent-verdict — `gate.json` (`planeo.dev/gitops-gate/v1`)

**Why.** The gate's sticky comment and job summary are written for humans: tables, emoji, Mermaid, collapsed diffs.
An agent (the Planeo Principal Engineer, its DevSecOps specialist, any CI-reading agent) that parses them guesses —
and a guess about "did the live diff run?" turns into a false claim of verification, or into another round of asking
the owner. So every `🚦 gate` also emits ONE machine-readable decision: `gate.json`, artifact
**`gitops-gate-<title>`**, `workflow_call` output **`verdict`**. Implementation and schema:
[`actions/gitops/agent-verdict`](../../../actions/gitops/agent-verdict/README.md).

## Decisions

Each unit's render result and [live verdict](verdicts.md) map to exactly one `decision`:

| `decision` | from | blocks the verdict |
|---|---|---|
| `fix-render` | render `failed` (wins over any live status) | yes |
| `fix-live-error` | `error` · `refresh-failed` · `validate-failed` | yes |
| `blocked-noop` | `noop` — the PR changes nothing live and nothing explains it | yes |
| `needs-human` | a live status this contract does not know | yes |
| `review-new-app` | `new` | no — a human reviews the rendered objects |
| `merge-ok` | `diff` · `noop-live-equal` · `noop-expected` · `noop-prune-nothing` · `noop-allowed` · `meta` | no |
| `live-ok` | mode=refresh `validated` · `refreshed` | no |
| `merge-ok-render-only` | `skipped-no-argocd` · `skipped-no-tailnet` · `render-only` · `build-only` · `external` · no live step | no — and listed in `not_verified` |

Gate `verdict`: any group `failure`/`cancelled` → **`failed`** (e.g. the 🧪 kustomize check failed, so no diff ran);
else any blocking unit → **`blocked`**; else no unit → **`no-change`**; else **`pass`**.

## Rules for agents

1. Read `gate.json` first (`gh run download <run-id> -R <repo> -n gitops-gate-<title>`, or the job summary's
   `🤖 Agent decision` block); act on `next_actions` — one per blocking unit, with the job to open.
2. `not_verified` is binding: the live `argocd app diff` did **not** run for those units (no tailnet/ArgoCD for the
   caller, multi-source, external). Report them as "rendered only", never as verified.
3. `pass` / `no-change` mean **ready for human review** — agents never merge.
4. `needs-human` means the contract met a status it does not know: stop and ask, do not guess.

The gate job's own pass/fail did not change: it still fails from the group results; the verdict step is
`continue-on-error` and only reshapes what `group.json` holds (names, paths, statuses, counts — never a secret).
