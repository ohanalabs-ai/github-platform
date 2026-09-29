# scripted/phase-summary

Renders the markdown [`scripted-phase.yaml`](../../../.github/workflows/scripted-phase.yaml) shows before and after the gate:

- **`mode: preview`** — the phase's identity (phase, target, ref, actor, run), a red banner when `destructive`, **the exact commands the apply will run** (setup · preview · apply · post, verbatim), the captured preview markdown, and *Next* (approve the `🚀 apply` job in the named Environment / ungated / preview-only). If the preview command failed, it says so and that the apply is blocked.
- **`mode: apply`** — the preview the approver saw (collapsed), the apply's stdout (collapsed), the post-command output.

Embedded outputs are truncated at `MAX_BYTES` (800 kB — the step summary's 1 MiB limit) with a pointer to the artifact. Pure text; `summary.sh` is runnable by hand:

```bash
MODE=preview PHASE=vault-seed TARGET=platform-aws-eks-use1-prd APPLY_CMD='bash scripts/run-phase.sh vault-seed' \
  PREVIEW_FILE=/tmp/preview.md GATED=true ENVIRONMENT=production bash actions/scripted/phase-summary/summary.sh
```
