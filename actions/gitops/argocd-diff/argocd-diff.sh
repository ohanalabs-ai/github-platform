#!/usr/bin/env bash
# The 🔍 live diff of ONE unit and its VERDICT (actions/gitops/argocd-diff/action.yaml):
# `argocd app diff <app> --revision <PR head sha>` against the live cluster — the
# repo-server fetches that commit from the registered repo and renders it exactly as it
# would after merge (CMP included), then diffs it against the live state. NOT `--local …
# --server-side-generate`: that uploads a tgz over a client-streaming gRPC call, which
# grpc-web through an ALB cannot carry (checksum error against the empty SHA).
#
# Verdicts (status), in the order they are decided:
#   new                 the Application is not in ArgoCD yet (IN_ARGOCD=false) — pass; the
#                       rendered base→head diff is the whole expected change
#   meta                every file this PR changes under the unit matches META_PATTERN
#                       (default: the `.render-kustomize` CMP marker and Markdown) — nothing
#                       rendered can change; pass without a live diff
#   diff                argocd exit 1 — a live change; pass (the diff is the review artifact)
#   error               argocd exit >1 after the retries — fail
#   noop-allowed        argocd exit 0 but BLOCK_NOOP=false — pass with a warning
#   noop-expected       exit 0 and the unit's own render is +0 ~0 -0 base→head: the changed
#                       files under its path are rendered by another Application — pass
#   noop-prune-nothing  exit 0 and the render only REMOVES objects (+0 ~0 -N): none of them
#                       exists live (never created, or already gone) — pass
#   noop-live-equal     exit 0 and the render DOES change (+a ~c -r > 0, not new): the cluster
#                       already carries that state (a server-side default the PR now pins, a
#                       prior manual apply, a value ArgoCD normalises away) — pass, and the
#                       message names the rendered objects that changed and why live is empty
#   noop                exit 0, render empty AND live empty — FAIL: the PR changes nothing
#
# Cache misses: the diff reads ArgoCD's CACHED managed resources; cold after a Redis
# restart and rewritten during every reconcile, so a read can race a refresh ("cache: key
# is missing"). Up to 3 attempts — nudge a refresh (`argocd app get --refresh -o json`;
# `app get` has NO `-o name`), sleep, diff again.
#
# Environment:
#   APP UNIT_PATH DIFF_REV BASE_SHA IN_ARGOCD(true|false|unknown) RENDER_FRAG(render-<app>.json)
#   BLOCK_NOOP(true|false) META_PATTERN NEW_APP_HINT ARGOCD_SERVER ARTIFACT_NAME CLUSTER
#   FRAG_DIR DIFF_OUT RETRY_SLEEP(25) RETRIES(3)
# Writes FRAG_DIR/act-<app>.json {app,status,bytes,rc,note} + act-<app>.md; DIFF_OUT holds
# the raw argocd output; `status=<verdict>` → $GITHUB_OUTPUT; the markdown → $GITHUB_STEP_SUMMARY.
# Exit 0 always — the ENFORCE step of the workflow turns the verdict into pass/fail.
set -uo pipefail
: "${APP:?}" "${DIFF_REV:?}" "${FRAG_DIR:?}" "${DIFF_OUT:?}"
UNIT_PATH="${UNIT_PATH:-}"; BASE_SHA="${BASE_SHA:-}"; IN_ARGOCD="${IN_ARGOCD:-unknown}"; RENDER_FRAG="${RENDER_FRAG:-}"
BLOCK_NOOP="${BLOCK_NOOP:-true}"; META_PATTERN="${META_PATTERN:-(^|/)\.render-kustomize$|\.md$}"
NEW_APP_HINT="${NEW_APP_HINT:-it is created after merge (bootstrap or ApplicationSet)}"
ARGOCD_SERVER="${ARGOCD_SERVER:-}"; ARTIFACT_NAME="${ARTIFACT_NAME:-argocd-diff-$APP}"; CLUSTER="${CLUSTER:-}"
RETRY_SLEEP="${RETRY_SLEEP:-25}"; RETRIES="${RETRIES:-3}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"; OUT="${GITHUB_OUTPUT:-/dev/null}"
mkdir -p "$FRAG_DIR"; md="$FRAG_DIR/act-$APP.md"; [ -f "$md" ] || { echo "#### \`$APP\` — \`$UNIT_PATH\`"; echo; } > "$md"

# Files this PR changes under the unit that never reach a rendered manifest: a unit whose
# whole change is such files is `meta` — a live no-op by construction, not a cosmetic PR.
meta_only=0; changed=""
if [ -n "$BASE_SHA" ] && [ -n "$UNIT_PATH" ]; then
  git fetch -q --no-tags --depth=1 origin "$BASE_SHA" "$DIFF_REV" 2>/dev/null || true
  changed="$(git diff --name-only "$BASE_SHA" "$DIFF_REV" -- "$UNIT_PATH" 2>/dev/null || true)"
  if [ -n "$changed" ] && ! grep -vE "$META_PATTERN" <<<"$changed" >/dev/null; then meta_only=1; fi
fi

rc=0
if [ "$IN_ARGOCD" = "false" ]; then
  st="new"; : > "$DIFF_OUT"
elif [ "$meta_only" = 1 ]; then
  st="meta"; printf '%s\n' "$changed" > "$DIFF_OUT"
else
  for attempt in $(seq 1 "$RETRIES"); do
    argocd app diff "$APP" --revision "$DIFF_REV" > "$DIFF_OUT" 2>&1; rc=$?
    if [ "$rc" -gt 1 ] && grep -q 'cache: key is missing' "$DIFF_OUT"; then
      echo "::notice::$APP: managed-resources cache miss (attempt $attempt/$RETRIES) — refreshing and retrying"
      argocd app get "$APP" --refresh -o json >/dev/null 2>&1 || true
      sleep "$RETRY_SLEEP"; continue
    fi
    break
  done
  case "$rc" in 0) st="noop" ;; 1) st="diff" ;; *) st="error" ;; esac
  if [ "$st" = noop ] && [ "$BLOCK_NOOP" = "false" ]; then st="noop-allowed"; fi
  rf="$RENDER_FRAG"
  if [ "$st" = noop ] && [ -n "$rf" ] && [ -f "$rf" ]; then
    if jq -e '.render == "ok" and .new == false and .added == 0 and .changed == 0 and .removed == 0' "$rf" >/dev/null 2>&1; then
      st="noop-expected"      # what this Application renders is identical base→head
    elif jq -e '.render == "ok" and .new == false and .added == 0 and .changed == 0 and .removed > 0' "$rf" >/dev/null 2>&1; then
      st="noop-prune-nothing" # the PR only REMOVES objects, and none of them exists live
    elif jq -e '.render == "ok" and .new == false and (.added + .changed + .removed) > 0' "$rf" >/dev/null 2>&1; then
      st="noop-live-equal"    # the render changes, the live state already carries it
    fi
  fi
fi
bytes=$(wc -c < "$DIFF_OUT" | tr -d ' ')
echo "status=$st" >> "$OUT"
jq -n --arg a "$APP" --arg s "$st" --argjson b "$bytes" --argjson rc "$rc" '{app:$a,status:$s,bytes:$b,rc:$rc,note:""}' > "$FRAG_DIR/act-$APP.json"
objlist() { jq -r --arg k "$1" '.objects[$k] // [] | map("`"+.+"`") | join(", ")' "$RENDER_FRAG" 2>/dev/null; }
{
  echo "\`argocd app diff $APP --revision ${DIFF_REV::7}\` against \`$ARGOCD_SERVER\` (live render of this PR's head by the repo-server, CMP included)"
  echo
  case "$st" in
    new) echo "🆕 **Not in ArgoCD yet** — \`$APP\` is not among the Applications the CI account can see, so there is no live state to diff; $NEW_APP_HINT. The rendered base-vs-head diff above is the whole expected change." ;;
    noop-allowed) echo "⚠️ **No-op:** this PR changes nothing in the live cluster for \`$APP\`. (Merge NOT blocked — \`GITOPS_BLOCK_NOOP=false\`.)" ;;
    noop-prune-nothing) echo "🧹 **Nothing to prune** — this PR only removes $(jq -r .removed "$RENDER_FRAG") object(s) from what \`$APP\` renders ($(objlist removed)), and none of them exists in the live cluster (never created — e.g. refused by a webhook — or already gone). The desired state changes; the live state has nothing to do." ;;
    noop-expected) echo "📝 **Expected no-op** — the PR changes files feeding \`$APP\` ($(jq -r '.changed_files|join(", ")' "$RENDER_FRAG" | cut -c1-300)) but what \`$APP\` renders is byte-identical base→head (🧩 render: +0 ~0 -0), so the live cluster has nothing to change for it. Those files belong to another Application (its group renders them) or are not rendered at all." ;;
    noop-live-equal)
      echo "📝 **Live already equal** — the rendered manifests DO change base→head (+$(jq -r .added "$RENDER_FRAG") ~$(jq -r .changed "$RENDER_FRAG") −$(jq -r .removed "$RENDER_FRAG") objects), yet \`argocd app diff\` is empty: the live cluster already carries this state."
      a=$(objlist added); c=$(objlist changed); r=$(objlist removed)
      [ -n "$a" ] && echo "- added in the render, already live: $a"
      [ -n "$c" ] && echo "- changed in the render, already equal live: $c"
      [ -n "$r" ] && echo "- removed in the render, already absent live: $r"
      echo "- **Why the live diff is empty:** the desired state now pins what the cluster already had — typically a field a CRD / admission default filled in server-side (the PR makes it explicit), a value applied by hand before this PR, or a difference ArgoCD normalises away (\`ignoreDifferences\`, known-types). Merging changes git, not the cluster — that is the intent here, so this is not a no-op PR." ;;
    meta) echo "📝 **Meta-only change** — this PR touches only files under \`$UNIT_PATH\` that never reach a rendered manifest ($(tr '\n' ' ' < "$DIFF_OUT")). No live diff to show; not a no-op PR." ;;
    noop)
      echo "❌ **No-op — merge blocked:** this PR changes nothing in the live cluster for \`$APP\`."
      echo "Either the change is cosmetic (comments, whitespace, reordering) or the cluster already carries it. Make the PR affect what it claims to, or drop it. Escape hatch: repo variable \`GITOPS_BLOCK_NOOP=false\`." ;;
    diff)
      echo "✅ **Live change** — what a merge will apply ($bytes bytes):"
      echo; echo '```diff'; head -c 60000 "$DIFF_OUT"
      if [ "$bytes" -gt 60000 ]; then echo; echo "… truncated — full diff in the \`$ARTIFACT_NAME\` artifact"; fi
      echo '```' ;;
    *)
      echo "💥 **Diff failed** (argocd exit $rc) — render or connection error:"
      echo; echo '```'; tail -c 20000 "$DIFF_OUT"; echo '```' ;;
  esac
} >> "$md"
cat "$md" >> "$SUMMARY"
echo "verdict: $st ($APP)"
