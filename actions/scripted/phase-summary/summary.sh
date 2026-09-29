#!/usr/bin/env bash
# Compose the markdown the scripted-phase reusable workflow shows the approver
# (actions/scripted/phase-summary/action.yaml): the phase's identity, what the apply WILL run
# (every command, verbatim), the captured preview, and what happens next (the gate). The
# same script renders the apply job's summary (MODE=apply): the approved preview first, then
# the apply/post output. Pure text — no cluster, no network.
#
# Environment:
#   MODE            preview | apply
#   PHASE, TARGET   labels (TARGET may be empty)
#   SETUP_CMD, PREVIEW_CMD, APPLY_CMD, POST_CMD   the commands, verbatim (may be empty)
#   GATED           true|false — the apply job waits on an Environment's reviewer
#   ENVIRONMENT     the Environment name (when GATED)
#   DESTRUCTIVE     true|false — red banner
#   PREVIEW_FILE    the captured preview markdown (may be missing/empty)
#   PREVIEW_RC      the preview command's exit code (default 0)
#   APPLY_FILE, APPLY_RC, POST_FILE   (MODE=apply)
#   MAX_BYTES       truncate embedded outputs at this size (default 800000; the artifact keeps the whole file)
#   RUN_URL, REF, ACTOR, EVENT   for the header
#   OUT             where to write (default stdout)
set -uo pipefail
MODE="${MODE:-preview}"; PHASE="${PHASE:-?}"; TARGET="${TARGET:-}"
GATED="${GATED:-true}"; ENVIRONMENT="${ENVIRONMENT:-production}"; DESTRUCTIVE="${DESTRUCTIVE:-false}"
PREVIEW_FILE="${PREVIEW_FILE:-}"; PREVIEW_RC="${PREVIEW_RC:-0}"
APPLY_FILE="${APPLY_FILE:-}"; APPLY_RC="${APPLY_RC:-0}"; POST_FILE="${POST_FILE:-}"
MAX_BYTES="${MAX_BYTES:-800000}"
OUT="${OUT:-/dev/stdout}"

label="$PHASE"; [ -n "$TARGET" ] && label="$PHASE · $TARGET"

# embed <file> <empty-note> — the file's content, truncated to MAX_BYTES with a note
embed() {
  local f="$1" note="$2" size
  if [ -z "$f" ] || [ ! -s "$f" ]; then echo "_${note}_"; return; fi
  size="$(wc -c <"$f" | tr -d ' ')"
  if [ "$size" -gt "$MAX_BYTES" ]; then
    head -c "$MAX_BYTES" "$f"; echo; echo
    echo "> ✂️ truncated at ${MAX_BYTES} bytes (${size} total) — the full output is in the run's \`scripted-phase-preview\` artifact / job log."
  else
    cat "$f"
  fi
}
cmd_row() { # cmd_row <step> <command>
  [ -n "$2" ] || return 0
  printf '| `%s` | `%s` |\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ' | sed 's/`/\\`/g')"
}

{
  if [ "$MODE" = preview ]; then
    echo "# 🔍 ${label} — preview (nothing was changed)"
  else
    echo "# 🚀 ${label} — apply"
  fi
  echo
  if [ "$DESTRUCTIVE" = true ]; then
    echo "> 🟥 **DESTRUCTIVE PHASE.** What is listed below is removed by the apply. Read the inventory; there is no undo."
    echo
  fi
  echo "| | |"; echo "|---|---|"
  echo "| phase | \`${PHASE}\` |"
  [ -n "$TARGET" ] && echo "| target | \`${TARGET}\` |"
  [ -n "${REF:-}" ] && echo "| ref | \`${REF}\` |"
  [ -n "${EVENT:-}" ] && echo "| event | \`${EVENT}\` |"
  [ -n "${ACTOR:-}" ] && echo "| requested by | \`${ACTOR}\` |"
  [ -n "${RUN_URL:-}" ] && echo "| run | ${RUN_URL} |"
  if [ -z "${APPLY_CMD:-}" ]; then
    echo "| gate | preview-only — there is no apply step |"
  elif [ "$GATED" = true ]; then
    echo "| gate | 🔒 the \`🚀 apply\` job waits for a reviewer of the Environment \`${ENVIRONMENT}\` |"
  else
    echo "| gate | 🔓 ungated — the \`🚀 apply\` job runs right after the preview (read-only / test phase) |"
  fi
  echo
  echo "## What the apply will run"
  echo
  echo "| step | command |"; echo "|---|---|"
  cmd_row setup "${SETUP_CMD:-}"
  cmd_row preview "${PREVIEW_CMD:-}"
  cmd_row apply "${APPLY_CMD:-}"
  cmd_row post "${POST_CMD:-}"
  echo
  if [ "$MODE" = preview ]; then
    echo "## Preview"
    echo
    if [ "$PREVIEW_RC" != 0 ]; then
      echo "> ❌ the preview command exited **${PREVIEW_RC}** — the apply job is blocked (it \`needs\` this job). What it printed:"
      echo
    fi
    embed "$PREVIEW_FILE" "the preview command printed nothing on stdout"
    echo
    echo "## Next"
    echo
    if [ -z "${APPLY_CMD:-}" ]; then
      echo "- Preview-only phase: nothing to approve, nothing runs after this."
    elif [ "$GATED" = true ]; then
      echo "- Read the preview above, then approve the \`🚀 apply\` job (**Review deployments** → \`${ENVIRONMENT}\`). It re-prints this preview at the top of its log and runs the \`apply\` command exactly as listed."
      echo "- Reject if the preview is not what you expected — nothing has been changed yet."
    else
      echo "- \`🚀 apply\` runs immediately (ungated phase)."
    fi
  else
    echo "## Preview this apply was approved on"
    echo
    echo "<details><summary>🔍 preview (as shown to the approver)</summary>"; echo
    embed "$PREVIEW_FILE" "no preview was captured"
    echo; echo "</details>"; echo
    echo "## Apply output"
    echo
    if [ "$APPLY_RC" != 0 ]; then echo "> ❌ the apply command exited **${APPLY_RC}**"; echo; fi
    echo "<details><summary>🚀 apply log (stdout)</summary>"; echo
    echo '```'; embed "$APPLY_FILE" "(nothing on stdout)"; echo '```'
    echo "</details>"
    if [ -n "$POST_FILE" ] && [ -s "$POST_FILE" ]; then
      echo; echo "## After the apply"; echo
      embed "$POST_FILE" ""
    fi
  fi
} > "$OUT"
