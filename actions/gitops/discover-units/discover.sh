#!/usr/bin/env bash
# The 🧭 discover step (actions/gitops/discover-units/action.yaml): run the CALLER's
# repo-local discovery command over the changed files and turn its units JSON into the
# matrix the render/act jobs fan out on, plus a step summary.
#
# The command is the contract between a repo and this workflow. It receives the changed
# paths (∩ the group's watch paths) as trailing arguments and must print ONE JSON object:
#
#   {"units":[{app,path,tier,local,multi_source,render_only,plugin,manifest?,feeds?,cluster?}, …],
#    "unmapped":["<changed path no Application owns>", …]}
#
# (products/devsecops-gitops/capabilities/unit-contract.md). Environment:
#   COMMAND   e.g. `bash clusters/discover-units.sh --json --cluster <c> --group <g>`
#   CHANGED   whitespace-separated changed paths (from tj-actions/changed-files)
#   CLUSTER GROUP MODE   for the summary
# Outputs ($GITHUB_OUTPUT): units (JSON array), count, has_changes (true|false), matrix
# (the units, or ONE placeholder row `(no units)` so a skipped matrix job never shows an
# unexpanded `${{ matrix.app }}` in the Checks UI).
set -euo pipefail
: "${COMMAND:?}"
CHANGED="${CHANGED:-}"; CLUSTER="${CLUSTER:-}"; GROUP="${GROUP:-}"; MODE="${MODE:-diff}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"; OUT="${GITHUB_OUTPUT:-/dev/stdout}"
# shellcheck disable=SC2086 # the command is a word list and the paths never contain spaces (by contract)
out=$(eval "$COMMAND" $CHANGED)
jq -e 'type=="object" and (.units|type=="array")' <<<"$out" >/dev/null || { echo "::error::discover command did not print {units:[…],unmapped:[…]}: ${out:0:300}"; exit 1; }
units=$(jq -c '.units' <<<"$out")
n=$(jq 'length' <<<"$units")
{
  echo "units=$units"
  echo "count=$n"
  if [ "$n" -gt 0 ]; then
    echo "has_changes=true"; echo "matrix=$units"
  else
    echo "has_changes=false"
    echo 'matrix=[{"app":"(no units)","noop":true,"tier":"-","path":"-","local":false,"multi_source":false,"render_only":false,"plugin":false}]'
  fi
} >> "$OUT"
{
  echo "## 🧭 ${GROUP:-units}${CLUSTER:+ · $CLUSTER} — $n unit(s)"
  if [ "$n" -eq 0 ]; then
    echo; echo "_Nothing in this group changed (changed files ∩ watch paths → no Application)._"
  else
    echo; echo "| Application | tier | source | render | $MODE |"; echo "|---|---|---|---|---|"
    jq -r --arg mode "$MODE" '.[] | "| `\(.app)` | \(.tier) | `\(.path)` | \(if (.local // true) then (if (.multi_source // false) then "helm template + kustomize, base-vs-head diff" else "kustomize build + base-vs-head diff" end) else "skipped (external repo)" end) | \(if ((.local // true)|not) then "skipped" elif (.multi_source // false) then "render-only (multi-source)" elif (.render_only // false) then "build-only (template)" elif $mode == "diff" then "argocd app diff" else "hard-refresh + validate" end) |"' <<<"$units"
  fi
  um=$(jq -r '.unmapped // [] | .[]' <<<"$out")
  if [ -n "$um" ]; then
    echo; echo "<details><summary>Changed paths in this group's watch list with no Application</summary>"; echo; echo '```'; echo "$um"; echo '```'; echo "</details>"
  fi
} >> "$SUMMARY"
echo "discovered $n unit(s)"
