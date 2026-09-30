#!/usr/bin/env bash
# Render the STRUCTURED preview of a scripted phase — the plan manifest the caller's preview
# command wrote under $PLAN_DIR — as the markdown the Terraform plan comment has
# (reproio/terraform-j2md's shape, the one every PR of the callers already shows):
#
#   ### N to add, M to change, K to destroy, U unchanged
#   - add        one bullet per resource: `type` name
#   - change
#   - destroy
#   <details>unchanged</details>   ℹ️ not diffable   ❌ errors
#   <details><summary>Change details</summary>  one ````diff block per add/change/destroy
#     resource, headed `# <type> <name> will be created|updated|destroyed`, its unified diff
#     (or its note when the emitter has no diff) </details>
#
# The manifest (products/devsecops-scripted/README.md → "The plan manifest"): EITHER
#   $PLAN_DIR/plan.json        {"summary"?: {...}, "resources": [ <resource>, ... ]}
#   $PLAN_DIR/resources.jsonl  one <resource> JSON object per line (append-friendly for shell
#                              scripts and their subprocesses) — both may be present; they are
#                              concatenated in that order.
# <resource> = { "action": "add|change|destroy|noop|note|error", "type": "<kind of thing>",
#                "name": "<address>", "note"?: "<one line>", "diff"?: "<unified diff text>",
#                "diff_file"?: "<path, read when diff is absent>" }
# The summary counts are ALWAYS recomputed from the resources (a supplied summary is ignored
# if it disagrees). Values are the emitter's responsibility: a diff arrives here already
# redacted (key names, lengths, hashes); this script adds nothing and hides nothing.
#
# Environment:
#   PLAN_DIR             the directory holding plan.json / resources.jsonl (required)
#   OUT                  where to write the markdown (default $PLAN_DIR/plan.md); also writes
#                        the normalised manifest (recomputed summary + every resource) to
#                        $PLAN_DIR/plan.normalized.json — never over the emitter's plan.json
#   PLAN_MAX_DIFF_LINES  per-resource diff truncation (default 300)
#   PLAN_TITLE           heading level prefix for the headline (default "###")
# Exit: 0 rendered · 3 no manifest found (caller falls back to the free-text preview)
set -uo pipefail
: "${PLAN_DIR:?PLAN_DIR is required}"
OUT="${OUT:-$PLAN_DIR/plan.md}"
PLAN_MAX_DIFF_LINES="${PLAN_MAX_DIFF_LINES:-300}"
PLAN_TITLE="${PLAN_TITLE:-###}"
command -v jq >/dev/null 2>&1 || { echo "::error::plan.sh needs jq" >&2; exit 1; }

json="$PLAN_DIR/plan.json"; jsonl="$PLAN_DIR/resources.jsonl"
[ -s "$json" ] || [ -s "$jsonl" ] || exit 3

# --- normalise: one array of resources, malformed lines dropped (counted), summary recomputed
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
{
  [ -s "$json" ] && jq -c '.resources[]? // empty' "$json" 2>/dev/null
  [ -s "$jsonl" ] && jq -cR 'fromjson? // empty' "$jsonl"
} | jq -c 'select(type=="object") | .action = ((.action // "note") | ascii_downcase) | .type = (.type // "resource") | .name = (.name // "?")' > "$tmp"
bad=0
if [ -s "$jsonl" ]; then
  total_lines="$(grep -c . "$jsonl" || true)"; good_lines="$(jq -cR 'fromjson? // empty' "$jsonl" | grep -c . || true)"
  bad=$(( ${total_lines:-0} - ${good_lines:-0} )); [ "$bad" -lt 0 ] && bad=0
fi

count() { jq -c "select(.action==\"$1\")" "$tmp" | grep -c . || true; }
n_add="$(count add)"; n_chg="$(count change)"; n_del="$(count destroy)"; n_noop="$(count noop)"
n_note="$(count note)"; n_err="$(count error)"
n_other="$(jq -c 'select(.action | IN("add","change","destroy","noop","note","error") | not)' "$tmp" | grep -c . || true)"

# the normalised manifest (what the artifact keeps beside the markdown) — under its OWN name:
# writing it back as plan.json would make the next render read it AND the jsonl and double
# every count (rendering must be idempotent — the summary step may run after a dry render)
jq -s --argjson a "$n_add" --argjson c "$n_chg" --argjson d "$n_del" --argjson u "$n_noop" \
  '{summary: {add: $a, change: $c, destroy: $d, unchanged: $u}, resources: .}' "$tmp" > "$PLAN_DIR/plan.normalized.json"

bullets() { # bullets <action> [indent] — "<indent>- `type` name — note" (nested under "- add" etc. by default;
  # a top-level "- " inside <details>, where a 4-space indent would render as a code block)
  jq -r --arg i "${2-    }" "select(.action==\"$1\") | \$i + \"- \`\" + .type + \"\` \" + .name + (if (.note // \"\") != \"\" then \" — \" + .note else \"\" end)" "$tmp"
}
verb() { case "$1" in add) echo "will be created" ;; change) echo "will be updated" ;; destroy) echo "will be destroyed" ;; esac; }

{
  echo "${PLAN_TITLE} ${n_add} to add, ${n_chg} to change, ${n_del} to destroy, ${n_noop} unchanged"
  echo
  if [ "$n_err" -gt 0 ]; then
    echo "> ❌ **${n_err} resource(s) could not be previewed** — the apply may fail or change them blind; read their notes below."
    echo
  fi
  if [ "$n_add" -gt 0 ]; then echo "- add"; bullets add; fi
  if [ "$n_chg" -gt 0 ]; then echo "- change"; bullets change; fi
  if [ "$n_del" -gt 0 ]; then echo "- destroy"; bullets destroy; fi
  if [ "$n_add" -eq 0 ] && [ "$n_chg" -eq 0 ] && [ "$n_del" -eq 0 ]; then
    echo "- ✅ nothing to add, change or destroy — the apply is a no-op on every previewed resource"
  fi
  if [ "$n_noop" -gt 0 ]; then
    echo; echo "<details><summary>✅ unchanged (${n_noop})</summary>"; echo; bullets noop ""; echo; echo "</details>"
  fi
  if [ "$n_note" -gt 0 ] || [ "$n_other" -gt 0 ]; then
    echo; echo "- ℹ️ not diffable — the apply also does this:"; bullets note
    jq -r 'select(.action | IN("add","change","destroy","noop","note","error") | not) | "    - `" + .type + "` " + .name + " — (action `" + .action + "`)" + (if (.note // "") != "" then ": " + .note else "" end)' "$tmp"
  fi
  if [ "$n_err" -gt 0 ]; then echo; echo "- ❌ errors"; bullets error; fi
  [ "$bad" -gt 0 ] && { echo; echo "> ⚠️ ${bad} malformed line(s) in \`resources.jsonl\` were skipped."; }

  # --- change details: one fenced diff per add/change/destroy resource
  if [ $(( n_add + n_chg + n_del + n_err )) -gt 0 ]; then
    echo; echo "<details><summary>Change details</summary>"; echo
    jq -c 'select(.action | IN("add","change","destroy","error"))' "$tmp" | while IFS= read -r r; do
      action="$(jq -r .action <<<"$r")"; type="$(jq -r .type <<<"$r")"; name="$(jq -r .name <<<"$r")"
      note="$(jq -r '.note // ""' <<<"$r")"; diff_file="$(jq -r '.diff_file // ""' <<<"$r")"
      echo '````diff'
      if [ "$action" = error ]; then echo "# ${type} ${name} could not be previewed"; else echo "# ${type} ${name} $(verb "$action")"; fi
      [ -n "$note" ] && echo "# ${note}"
      body="$(jq -r '.diff // ""' <<<"$r")"
      if [ -z "$body" ] && [ -n "$diff_file" ] && [ -s "$diff_file" ]; then body="$(cat "$diff_file")"; fi
      if [ -n "$body" ]; then
        n="$(printf '%s\n' "$body" | wc -l | tr -d ' ')"
        printf '%s\n' "$body" | head -n "$PLAN_MAX_DIFF_LINES"
        [ "$n" -gt "$PLAN_MAX_DIFF_LINES" ] && echo "# … ✂️ $(( n - PLAN_MAX_DIFF_LINES )) more line(s) in the job log / artifact"
      elif [ -z "$note" ]; then
        echo "# (no diff available for this resource)"
      fi
      echo '````'; echo
    done
    echo "</details>"
  fi
} > "$OUT"
exit 0
