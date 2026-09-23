#!/usr/bin/env bash
# Consolidated 🚦 gate summary over every group's group.json (written by
# actions/gitops/group-report and uploaded as the gitops-group-* artifacts):
#   * a table groups → units → objects added/changed/removed (expected change)
#   * ONE Mermaid graph: changed files → kustomizations → Applications → group → cluster,
#     for the units whose rendered diff is non-empty or that are new
#   * a "Merging this PR will …" sentence list
#
#   gitops-gate-summary.sh <groups-dir> <out.md> [<mode>]
#
# A PR that touches no unit yields "No GitOps units changed". Exit 1 when a unit failed
# (render failed, live error/failed, or a BLOCKING `noop`) — informational; the gate job
# decides from the group jobs' results.
set -uo pipefail
dir="${1:?dir with group*.json}"; out="${2:?out.md}"; mode="${3:-diff}"
files=$(find "$dir" -name 'group*.json' 2>/dev/null | sort)
# shellcheck disable=SC2086 # file list is newline-separated paths without spaces
all=$(if [ -n "$files" ]; then jq -s '.' $files; else echo '[]'; fi)
units=$(jq -c '[.[] as $g | $g.units[] | . + {cluster:$g.cluster,group:$g.group}]' <<<"$all")
n=$(jq 'length' <<<"$units")
changed=$(jq -c '[.[] | select(.render=="ok" and (.new or .diff_bytes>0))]' <<<"$units")
nc=$(jq 'length' <<<"$changed")
failed=$(jq -c '[.[] | select(.render=="failed" or (.act_status|test("failed|error|^noop$")))]' <<<"$units")
nf=$(jq 'length' <<<"$failed")

{
  echo "## 🚦 gate — consolidated GitOps $mode"
  echo
  if [ "$n" -eq 0 ]; then
    echo "**No GitOps units changed.** Merging this PR does not alter any ArgoCD Application or cluster (docs, scripts, workflows or terraform only)."
  else
    echo "| cluster | group | Application | tier | rendered objects | expected change (base → head) | live $mode |"
    echo "|---|---|---|---|---|---|---|"
    jq -r '.[] | "| \(.cluster) | \(.group) | `\(.app)` | \(.tier) | \(if .render=="ok" then "✅ \(.kinds)\(if (.render_mode // "") | startswith("helm-template") then " · ⎈ helm" else "" end)" elif .render=="external" then "⏭️ external" elif .render=="failed" then "❌ build failed" else "❓" end) | \(if .render!="ok" then "—" elif .new then "🆕 new — \(.kinds) objects created" elif .diff_bytes==0 then "⚪ none" else "🟡 +\(.added) ~\(.changed) −\(.removed)" end) | \(.act_status) |"' <<<"$units"
    echo
    tot_add=$(jq '[.[] | .added] | add // 0' <<<"$changed"); tot_chg=$(jq '[.[] | .changed] | add // 0' <<<"$changed"); tot_rem=$(jq '[.[] | .removed] | add // 0' <<<"$changed")
    tot_new=$(jq '[.[] | select(.new) | .kinds] | add // 0' <<<"$changed")
    echo "**Totals across changed units:** +$tot_add ~$tot_chg −$tot_rem objects, $tot_new objects in new Applications, $nc of $n unit(s) change, $nf failing."
    n_pre=$(jq '[.[] | select(.act_status=="new")] | length' <<<"$units")
    if [ "$n_pre" -gt 0 ]; then
      echo
      echo "🆕 **$n_pre unit(s) are not in ArgoCD yet** (created after merge — bootstrap or ApplicationSet) — for those the rendered base → head diff IS the expected change; there is no live state to compare."
    fi
    n_eq=$(jq '[.[] | select(.act_status=="noop-live-equal")] | length' <<<"$units")
    if [ "$n_eq" -gt 0 ]; then
      echo
      echo "📝 **$n_eq unit(s) render a change the cluster already carries** (\`noop-live-equal\`): git catches up with the live state (a server-side default now pinned, a prior manual apply) — merging changes the desired state, not the cluster."
    fi
    echo
    echo "### Merging this PR will …"
    if [ "$nc" -eq 0 ]; then
      echo "- … change **nothing** in the rendered manifests of the $n touched unit(s) (a wiring/comment/whitespace change — the live no-op rule applies when ArgoCD is connected)."
    else
      jq -r '.[] | if .new then "- create Application **`\(.app)`** in `\(.cluster)` (group \(.group), tier \(.tier)): \(.kinds) objects from `\(.path)`" else "- update **`\(.app)`** in `\(.cluster)` (group \(.group), tier \(.tier)): +\(.added) added, ~\(.changed) changed, −\(.removed) removed objects (from `\(.path)`)\(if .act_status=="noop-live-equal" then " — already live, git catches up" else "" end)" end' <<<"$changed"
    fi
    if [ "$nf" -gt 0 ]; then
      echo; echo "### ❌ Failing units"
      jq -r '.[] | "- `\(.app)` (\(.cluster) / \(.group)): render=\(.render), live=\(.act_status)"' <<<"$failed"
    fi
    if [ "$nc" -gt 0 ]; then
      echo; echo "### What changes where"
      echo '```mermaid'; echo 'graph LR'
      # clusters and groups as subgraphs; apps as nodes; kustomizations and changed files feed them
      while IFS= read -r cl; do
        echo "  subgraph \"☸️ $cl\""
        while IFS= read -r g; do
          echo "    subgraph \"$g\""
          jq -r --arg c "$cl" --arg g "$g" '.[] | select(.cluster==$c and .group==$g) | "      \("n_" + ((.cluster+"_"+.app) | gsub("[^A-Za-z0-9]";"_")))((\"\(.app)\(if .new then " 🆕" else "" end)\"))"' <<<"$changed"
          echo "    end"
        done < <(jq -r --arg c "$cl" '[.[] | select(.cluster==$c) | .group] | unique | .[]' <<<"$changed")
        echo "  end"
      done < <(jq -r '[.[] | .cluster] | unique | .[]' <<<"$changed")
      # kustomization → app, changed file → kustomization
      jq -r '.[] | . as $u | ("  " + ("k_" + ($u.path | gsub("[^A-Za-z0-9]";"_"))) + "[[\"" + $u.path + "\"]] --> " + ("n_" + (($u.cluster+"_"+$u.app) | gsub("[^A-Za-z0-9]";"_")))), ($u.changed_files[]? | "  " + ("f_" + (. | gsub("[^A-Za-z0-9]";"_"))) + "[\"" + . + "\"]:::changed --> " + ("k_" + ($u.path | gsub("[^A-Za-z0-9]";"_"))))' <<<"$changed" | sort -u
      echo '  classDef changed fill:#ffe9a8,stroke:#d97706,stroke-width:2px;'
      echo '```'
    fi
  fi
} > "$out"
echo "gate summary: $n unit(s), $nc changed, $nf failing → $out"
[ "$nf" -eq 0 ]
