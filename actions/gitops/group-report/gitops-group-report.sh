#!/usr/bin/env bash
# Build ONE group's report from the per-unit fragments its render/act jobs uploaded
# (gitops-argocd-group.yaml → 📋 result): the sticky PR comment / job summary
# (comment.md) and the machine-readable group.json the caller's 🚦 gate merges into
# the consolidated summary (actions/gitops/gate-summary).
#
#   gitops-group-report.sh <frags-dir> <cluster> <group> <mode> <run-url> <units-json> <out-dir>
#
# frags-dir holds, per unit <app>:
#   render-<app>.json        {app,render:ok|failed|external,kinds,new,added,changed,removed,unchanged,
#                             diff_bytes,changed_files:[…],note,render_mode,charts,attested?}
#   render-<app>-tree.md     the kustomization component tree (fenced)
#   render-<app>-mermaid.md  Mermaid graph (only when the rendered diff is non-empty or the unit is new)
#   render-<app>-diff.md     the rendered base-vs-head diff (<details>, truncated)
#   act-<app>.json / .md     the live step: {app,status,note} + its markdown
# out-dir receives comment.md and group.json.
#
# Live-column cells, one per verdict (products/devsecops-gitops/capabilities/verdicts.md):
#   diff ✅ · noop ❌ blocked · noop-allowed ⚠️ · noop-expected 📝 · noop-prune-nothing 🧹 ·
#   noop-live-equal 📝 live already equal · meta 📝 · new 🆕 · error/refresh-failed/validate-failed 💥 ·
#   validated ✅ · render-only/build-only ℹ️ · external ⏭️ · skipped-no-argocd/skipped-no-tailnet ⏭️
set -uo pipefail
frags="${1:?frags dir}"; cluster="${2:?cluster}"; group="${3:?group}"; mode="${4:?mode}"; run_url="${5:?run url}"; units="${6:?units json}"; out="${7:?out dir}"
mkdir -p "$out"
[ -d "$frags" ] || mkdir -p "$frags"

n=$(jq 'length' <<<"${units:-[]}")
title="$group · $cluster"
group_json='[]'

{
  echo "## 🗂️ GitOps $mode: \`$title\` — $n unit(s)"
  echo
  if [ "$n" -eq 0 ]; then
    echo "_Nothing in this group changed — no Application renders from the files this change touches._"
  else
    echo "| Application | tier | rendered objects | **expected change** (base → head) | $mode | run |"
    echo "|---|---|---|---|---|---|"
    while IFS= read -r app; do
      r="$frags/render-$app.json"; a="$frags/act-$app.json"
      tier=$(jq -r --arg a "$app" '.[] | select(.app==$a) | .tier' <<<"$units")
      upath=$(jq -r --arg a "$app" '.[] | select(.app==$a) | .path' <<<"$units")
      if [ -f "$r" ]; then
        rs=$(jq -r '.render' "$r"); kinds=$(jq -r '.kinds // 0' "$r")
        new=$(jq -r '.new // false' "$r"); add=$(jq -r '.added // 0' "$r"); chg=$(jq -r '.changed // 0' "$r"); rem=$(jq -r '.removed // 0' "$r"); db=$(jq -r '.diff_bytes // 0' "$r")
        cf=$(jq -c '.changed_files // []' "$r"); att=$(jq -r '.attested // ""' "$r"); rmode=$(jq -r '.render_mode // "kustomize"' "$r")
        bump=$(jq -r '[(.charts // [])[] | select(.base != "" and .base != .head) | "\(.chart) \(.base)→\(.head)"] | join(", ")' "$r")
      else rs="?"; kinds="?"; new=false; add=0; chg=0; rem=0; db=0; cf='[]'; att=""; rmode=""; bump=""; fi
      if [ -f "$a" ]; then as=$(jq -r '.status' "$a"); else as="—"; fi
      # 🔏 org-image attestations (WARN phase; only when the unit renders org images and an attestation command is configured)
      case "$rs" in
        ok) rcell="✅ $kinds${att:+ · 🔏 attested $att}"; case "$rmode" in helm-template) rcell="$rcell · ⎈ helm" ;; helm-template-partial) rcell="$rcell · ⚠️ helm partial" ;; esac ;;
        external) rcell="⏭️ external" ;; failed) rcell="❌ build failed" ;; *) rcell="❓" ;;
      esac
      if [ "$rs" = ok ]; then
        if [ "$new" = true ]; then ecell="🆕 new Application — $kinds objects will be created"
        elif [ "$db" -eq 0 ]; then ecell="⚪ no rendered change"
        else ecell="🟡 +$add ~$chg −$rem objects${bump:+ · ⎈ $bump}"; fi
      else ecell="—"; fi
      case "$as" in
        diff) acell="✅ live diff" ;; noop) acell="❌ live no-op (blocked)" ;; noop-allowed) acell="⚠️ live no-op (allowed)" ;;
        noop-expected) acell="📝 expected no-op" ;; noop-prune-nothing) acell="🧹 nothing to prune" ;; noop-live-equal) acell="📝 live already equal" ;;
        meta) acell="📝 meta-only (docs)" ;;
        new) acell="🆕 not in ArgoCD yet (created after merge)" ;;
        error|refresh-failed|validate-failed) acell="💥 failed" ;; refreshed|validated) acell="✅ $as" ;;
        skipped-no-argocd) acell="⏭️ skipped (no ARGOCD_SERVER)" ;; skipped-no-tailnet) acell="⏭️ skipped (no Tailscale OAuth secrets)" ;;
        render-only) acell="ℹ️ render-only (multi-source)" ;; build-only) acell="ℹ️ build-only" ;; external) acell="⏭️ external" ;; —) acell="—" ;; *) acell="❓ $as" ;;
      esac
      echo "| \`$app\` | $tier | $rcell | $ecell | $acell | [run]($run_url) |"
      group_json=$(jq -c --arg app "$app" --arg tier "$tier" --arg path "$upath" --arg rs "$rs" --argjson kinds "${kinds/\?/0}" --argjson new "$new" \
        --argjson add "$add" --argjson chg "$chg" --argjson rem "$rem" --argjson db "$db" --arg as "$as" --argjson cf "$cf" --arg rm "$rmode" \
        '. + [{app:$app,tier:$tier,path:$path,render:$rs,render_mode:$rm,kinds:$kinds,new:$new,added:$add,changed:$chg,removed:$rem,diff_bytes:$db,act_status:$as,changed_files:$cf}]' <<<"$group_json")
    done < <(jq -r '.[].app' <<<"$units")
    echo
    while IFS= read -r app; do
      echo "<details><summary>🧩 <code>$app</code> — components, expected change, live ${mode}</summary>"; echo
      if [ -f "$frags/render-$app-tree.md" ]; then echo "**Components**"; echo; cat "$frags/render-$app-tree.md"; echo; fi
      if [ -f "$frags/render-$app-mermaid.md" ]; then cat "$frags/render-$app-mermaid.md"; echo; fi
      if [ -f "$frags/render-$app-diff.md" ]; then cat "$frags/render-$app-diff.md"; echo; fi
      if [ -f "$frags/act-$app.md" ]; then echo "**Live $mode**"; echo; cat "$frags/act-$app.md"; echo; fi
      echo "</details>"; echo
    done < <(jq -r '.[].app' <<<"$units")
  fi
  echo
  echo "<sub>expected change = rendered base vs head (kustomize, or <code>helm template</code> for multi-source Applications); live $mode = ArgoCD when <code>ARGOCD_SERVER</code> is set · header <code>gitops-$cluster-$group</code> · <a href=\"https://github.com/ohanalabs-ai/github-platform/tree/main/products/devsecops-gitops\">devsecops-gitops</a></sub>"
} > "$out/comment.md"

jq -n --arg c "$cluster" --arg g "$group" --arg m "$mode" --argjson u "$group_json" '{cluster:$c,group:$g,mode:$m,units:$u}' > "$out/group.json"
echo "wrote $out/comment.md and $out/group.json ($n units)"
