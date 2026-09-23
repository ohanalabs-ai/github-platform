#!/usr/bin/env bash
# The 🧩 render step of ONE unit (actions/gitops/render-diff/action.yaml): render the
# unit in the head tree and the base tree (render-diff.sh), write the fragments the
# 📋 result job merges, the step summary, and the outputs the workflow uploads.
#
# Environment (set by the composite action):
#   APP UNIT_PATH TIER CLUSTER           the unit (from the discover matrix)
#   LOCAL MULTI_SOURCE RENDER_ONLY PLUGIN  unit flags ("true"/"false")
#   MANIFEST                             the Application manifest (multi-source render)
#   FEEDS                                ERE of repo paths that feed this unit (default ^<path>(/|$))
#   CHANGED                              the PR's changed files, whitespace-separated
#   BASE_TREE                            checkout of the PR base, or "-"
#   FRAG_DIR RD_DIR                      output dirs (fragments; render scratch)
#   RENDER_PLUGIN_SCRIPT KUSTOMIZE_BUILD_ARGS PLANEO_LABELS HELM_KUBE_VERSION → render-diff.sh
#   ATTESTATION_COMMAND                  optional: `<cmd> <unit-path>` printing "attested: N/M"
#   ARTIFACT_PREFIX                      name prefix of the rendered/rendered-diff artifacts (for the text)
#   ACTION_DIR                           where render-diff.sh / ../kustomize-tree/kustomize-tree.sh live
#
# Fragments written to FRAG_DIR (consumed by actions/gitops/group-report):
#   render-<app>.json        {app,render:ok|failed|external,kinds,new,added,changed,removed,diff_bytes,
#                             changed_files:[…],note,render_mode,charts:[…],attested?}
#   render-<app>-tree.md     the kustomization component tree (fenced)
#   render-<app>-mermaid.md  Mermaid graph (only when the rendered diff is non-empty or the unit is new)
#   render-<app>-diff.md     the rendered base-vs-head diff (<details>, truncated at 60k)
# Outputs ($GITHUB_OUTPUT): rendered=<head.yaml|''> difftxt=<diff.txt|''> result=ok|failed|external
# Exit 1 when the HEAD render fails.
set -uo pipefail
: "${APP:?}" "${UNIT_PATH:?}" "${FRAG_DIR:?}" "${RD_DIR:?}" "${ACTION_DIR:?}"
TIER="${TIER:--}"; CLUSTER="${CLUSTER:-}"; LOCAL="${LOCAL:-true}"; MULTI_SOURCE="${MULTI_SOURCE:-false}"
PLUGIN="${PLUGIN:-false}"; MANIFEST="${MANIFEST:-}"; FEEDS="${FEEDS:-}"; CHANGED="${CHANGED:-}"; BASE_TREE="${BASE_TREE:--}"
ATTESTATION_COMMAND="${ATTESTATION_COMMAND:-}"; ARTIFACT_PREFIX="${ARTIFACT_PREFIX:-rendered}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"; OUT="${GITHUB_OUTPUT:-/dev/null}"
mkdir -p "$FRAG_DIR" "$RD_DIR"
frag="$FRAG_DIR/render-$APP.json"
tree_sh="$ACTION_DIR/../kustomize-tree/kustomize-tree.sh"

if [ "$LOCAL" != "true" ]; then
  jq -n --arg a "$APP" --arg p "$UNIT_PATH" '{app:$a,render:"external",kinds:0,new:false,added:0,changed:0,removed:0,diff_bytes:0,changed_files:[],note:("source \($p) is another repository — not rendered here")}' > "$frag"
  echo "### ⏭️ render: \`$APP\` — source \`$UNIT_PATH\` is another repository; not rendered here." >> "$SUMMARY"
  { echo "rendered="; echo "difftxt="; echo "result=external"; } >> "$OUT"
  exit 0
fi

# changed files that FEED this unit (highlight + the report). `grep` exits 1 when
# nothing under the unit changed (a wiring-only re-render); with pipefail that would
# ALSO fire a `|| echo '[]'` fallback on top of jq's own `[]` — swallow grep's status.
[ -n "$FEEDS" ] || FEEDS="^${UNIT_PATH}(/|$)"
cf=$(tr ' ' '\n' <<<"$CHANGED" | { grep -E "$FEEDS" || true; } | jq -R -s -c 'split("\n") | map(select(length>0))')

export RENDER_PLUGIN="$PLUGIN" MULTI_SOURCE APP_MANIFEST="$MANIFEST"
if ! bash "$ACTION_DIR/render-diff.sh" "$PWD" "$BASE_TREE" "$UNIT_PATH" "$RD_DIR"; then
  echo "::error title=render failed::$UNIT_PATH ($APP${CLUSTER:+ · $CLUSTER}) — see the build output below"
  echo "::group::render stderr"; cat "$RD_DIR/head.yaml.err" 2>/dev/null; echo "::endgroup::"
  { echo "### ❌ render: \`$APP\` — build FAILED"; echo '```'; cat "$RD_DIR/head.yaml.err" 2>/dev/null; echo '```'; } >> "$SUMMARY"
  jq -n --arg a "$APP" --rawfile e "$RD_DIR/head.yaml.err" --argjson cf "$cf" '{app:$a,render:"failed",kinds:0,new:false,added:0,changed:0,removed:0,diff_bytes:0,changed_files:$cf,note:($e|.[0:1500])}' > "$frag"
  { echo "rendered="; echo "difftxt="; echo "result=failed"; } >> "$OUT"
  exit 1
fi
s="$RD_DIR/summary.json"
if [ "$BASE_TREE" = "-" ]; then
  # no base checkout: report the head render only (not "new")
  jq --argjson cf "$cf" '. + {render:"ok",kinds:.total,new:false,added:0,changed:0,removed:0,diff_bytes:0,changed_files:$cf,note:"base tree unavailable — expected change not computed"}' "$s" > "$frag"
else
  jq --argjson cf "$cf" '. + {render:"ok",kinds:.total,changed_files:$cf}' "$s" > "$frag"
fi
kinds=$(jq -r '.kinds' "$frag"); new=$(jq -r '.new' "$frag"); add=$(jq -r '.added' "$frag"); chg=$(jq -r '.changed' "$frag"); rem=$(jq -r '.removed' "$frag"); db=$(jq -r '.diff_bytes' "$frag")
mode=$(jq -r '.render_mode // "kustomize"' "$frag"); note=$(jq -r '.note // ""' "$frag")
chart_line=$(jq -r '(.charts // []) | map(if .base != "" and .base != .head then "`\(.chart)` **\(.base) → \(.head)**" elif .base == "" then "`\(.chart)` \(.head) (new)" else "`\(.chart)` \(.head)" end) | join(", ")' "$frag")
bumps=$(jq -r '[(.charts // [])[] | select(.base != "" and .base != .head)] | length' "$frag")

# components tree — always (a multi-source unit's tree is its git source path)
tree_root="$UNIT_PATH"
if [ -f "$tree_root/kustomization.yaml" ]; then
  { echo '```'; GITOPS_REPO_ROOT="$PWD" bash "$tree_sh" "$tree_root" --changed "$(jq -r 'join(",")' <<<"$cf")"; echo '```'; } > "$FRAG_DIR/render-$APP-tree.md"
else
  { echo '```'; echo "$UNIT_PATH  (no kustomization.yaml — rendered from the Application manifest${MANIFEST:+ $MANIFEST})"; echo '```'; } > "$FRAG_DIR/render-$APP-tree.md"
fi
if [ "$MULTI_SOURCE" = true ] && [ -n "$chart_line" ]; then
  { echo; echo "Helm chart sources (\`helm template\` at the pinned version, values from this tree): $chart_line"; } >> "$FRAG_DIR/render-$APP-tree.md"
fi

# 🔏 build attestations of the images in this unit (WARN phase; never fails the render)
if [ -n "$ATTESTATION_COMMAND" ]; then
  att="$FRAG_DIR/render-$APP-attest.md"
  # shellcheck disable=SC2086 # the command is a word list by contract
  $ATTESTATION_COMMAND "$UNIT_PATH" > "$att" 2>/dev/null || true
  attl=$(grep -oE 'attested: [0-9]+/[0-9]+' "$att" 2>/dev/null | tail -1 | sed 's/attested: //' || true)
  if [ -n "$attl" ] && [ "${attl##*/}" != 0 ]; then
    jq --arg a "$attl" '. + {attested:$a}' "$frag" > "$frag.tmp" && mv "$frag.tmp" "$frag"
  fi
fi

# Mermaid — only when something changes (or the Application is new)
if { [ "$new" = true ] || [ "$db" -gt 0 ]; } && [ -f "$tree_root/kustomization.yaml" ]; then
  GITOPS_REPO_ROOT="$PWD" bash "$tree_sh" "$tree_root" --mermaid --title "$APP${CLUSTER:+ · $CLUSTER} ($TIER)" --changed "$(jq -r 'join(",")' <<<"$cf")" > "$FRAG_DIR/render-$APP-mermaid.md"
fi

# rendered diff — collapsed, truncated at 60k (the artifact has it all)
{
  if [ "$new" = true ]; then
    echo "<details><summary>🆕 new Application — $kinds objects will be created (base: $(jq -r '.base' "$frag"))</summary>"; echo; echo '```'
    jq -r '.objects.added[]' "$frag"; echo '```'; echo "</details>"
  elif [ "$db" -eq 0 ]; then
    echo "⚪ **No rendered change**: head renders exactly what base renders ($kinds objects). If ArgoCD is connected the live diff below decides; a no-op is blocked."
  else
    echo "<details><summary>🟡 rendered diff — +$add added, ~$chg changed, −$rem removed objects ($db bytes; artifact <code>${ARTIFACT_PREFIX}-diff-$APP</code>)</summary>"; echo
    echo "Objects: added \`$(jq -r '.objects.added | join("`, `")' "$frag")\` · changed \`$(jq -r '.objects.changed | join("`, `")' "$frag")\` · removed \`$(jq -r '.objects.removed | join("`, `")' "$frag")\`"; echo
    echo '```diff'; head -c 60000 "$RD_DIR/diff.txt"
    if [ "$db" -gt 60000 ]; then echo; echo "… truncated — full diff in the artifact"; fi
    echo '```'; echo "</details>"
  fi
  if [ "$MULTI_SOURCE" = true ]; then
    case "$mode" in
      helm-template)
        msg="⎈ **Multi-source render**: the chart source(s) were rendered with \`helm template\` at their pinned version (values from this tree, \`CHANGE_ME_*\` parameters as placeholders) and concatenated with the git source — the diff above covers the chart output too."
        if [ "$bumps" -gt 0 ]; then msg="$msg **Chart version bump:** $chart_line."; fi
        echo; echo "$msg" ;;
      helm-template-partial) echo; echo "⚠️ **Multi-source render is partial**: $note. The diff above covers the git source only." ;;
    esac
  fi
} > "$FRAG_DIR/render-$APP-diff.md"

{
  echo "### ✅ render: \`$APP\` (${CLUSTER:+$CLUSTER / }$TIER) — $kinds objects [$mode]"
  if [ "$new" = true ]; then echo "- 🆕 **new Application** — $kinds objects will be created"; elif [ "$db" -eq 0 ]; then echo "- ⚪ no rendered change vs base"; else echo "- 🟡 expected change: **+$add ~$chg −$rem** objects"; fi
  echo "- changed files feeding this unit: $(jq -r 'if length==0 then "_none under the unit path (wiring/base change)_" else map("`"+.+"`") | join(", ") end' <<<"$cf")"
  if [ "$mode" = plugin ]; then echo "- 🔌 rendered with the render plugin script \`$RENDER_PLUGIN_SCRIPT\` and **placeholder** \`CHANGE_ME_*\` values (the live values are not available to CI); the structure is comparable, the values are not"; fi
  if [ -n "$chart_line" ]; then echo "- ⎈ chart sources: $chart_line"; fi
  [ -n "$note" ] && echo "- ⚠️ $note"
  echo; echo "**Components**"; echo; cat "$FRAG_DIR/render-$APP-tree.md"; echo
  [ -f "$FRAG_DIR/render-$APP-mermaid.md" ] && cat "$FRAG_DIR/render-$APP-mermaid.md"
  echo; cat "$FRAG_DIR/render-$APP-diff.md"
} >> "$SUMMARY"
{ echo "rendered=$RD_DIR/head.yaml"; echo "difftxt=$RD_DIR/diff.txt"; echo "result=ok"; } >> "$OUT"
