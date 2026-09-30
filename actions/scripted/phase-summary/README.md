# scripted/phase-summary

Renders the markdown [`scripted-phase.yaml`](../../../.github/workflows/scripted-phase.yaml) shows before and after the gate:

- **`mode: preview`** — the phase's identity (phase, target, ref, actor, run), a red banner when `destructive`, **the exact commands the apply will run** (setup · preview · apply · post, verbatim), the preview — **the plan manifest rendered like the Terraform plan comment** (`plan.sh`, when `plan-dir` holds a `plan.json` / `resources.jsonl`: `### N to add, M to change, K to destroy, U unchanged`, per-action resource bullets, unchanged collapsed, ℹ️ not-diffable steps, ❌ errors, then `Change details` with one ````diff per add/change/destroy resource) followed by the captured stdout as a collapsed appendix — or the captured stdout alone when there is no manifest — and *Next* (approve the `🚀 apply` job in the named Environment / ungated / preview-only). If the preview command failed, it says so and that the apply is blocked.
- **`mode: apply`** — the approved plan (open) and the preview the approver saw (collapsed), the apply's stdout (collapsed), the post-command output.

`plan.sh` is pure text too (needs `jq`): it recomputes the counts from the resources, drops and counts malformed jsonl lines, reads `diff_file` when `diff` is absent, truncates each diff at `PLAN_MAX_DIFF_LINES` (300), writes `plan.md` + `plan.normalized.json` beside the manifest (never over the emitter's `plan.json` — rendering is idempotent), and exits 3 when there is no manifest (the summary falls back to the free text). Redaction is the emitter's: the diff arrives with key names, lengths and hashes, never values. Golden fixtures: `tests/scripted/fixtures/plan-*.{jsonl,json}` → `plan-*.md`.

```bash
PLAN_DIR=/tmp/preview bash actions/scripted/phase-summary/plan.sh && cat /tmp/preview/plan.md
```

Embedded outputs are truncated at `MAX_BYTES` (800 kB — the step summary's 1 MiB limit) with a pointer to the artifact. Pure text; `summary.sh` is runnable by hand:

```bash
MODE=preview PHASE=vault-seed TARGET=platform-aws-eks-use1-prd APPLY_CMD='bash scripts/run-phase.sh vault-seed' \
  PREVIEW_FILE=/tmp/preview.md PLAN_DIR=/tmp/preview GATED=true ENVIRONMENT=production bash actions/scripted/phase-summary/summary.sh
```
