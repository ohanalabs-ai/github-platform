#!/usr/bin/env bash
# Walk a kustomization recursively and print what it is made of — the
# dependency tree (indented) and/or a Mermaid `graph LR` of kustomization dirs →
# files / components / bases / Helm charts / generators / patches.
#
#   kustomize-tree.sh <path> [--mermaid] [--changed f1,f2,…] [--title T]
#
#   default      indented tree to stdout
#   --mermaid    Mermaid graph instead (fenced ```mermaid block); nodes:
#                  [["dir"]] kustomization, ["file"] resource/patch/generator file,
#                  (("helm chart@version")) helmCharts entry, >"url"] remote resource
#   --changed    comma-separated repo-relative files to highlight (classDef changed)
#   --title      graph title (subgraph label)
#
# Paths are repo-relative: runs from GITOPS_REPO_ROOT (default: the current directory —
# the caller's checkout in CI; `cd` to the repo root before running it by hand).
# Needs yq (mikefarah v4, for YAML→JSON) and jq. Cycles are cut; remote URLs are leaves.
# Shared by ohanalabs-ai/github-platform's gitops-argocd-group.yaml (actions/gitops/kustomize-tree).
set -uo pipefail
cd "${GITOPS_REPO_ROOT:-.}" || exit 1

root="${1:?kustomization path}"; shift
mermaid=false; changed=""; title=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mermaid) mermaid=true; shift ;;
    --changed) changed=",$2,"; shift 2 ;;
    --title) title="$2"; shift 2 ;;
    *) shift ;;
  esac
done
root="${root%/}"
[ -f "$root/kustomization.yaml" ] || { echo "ERROR: $root has no kustomization.yaml" >&2; exit 2; }

nodes=""; edges=""; classes=""; seen="|"
nid() { printf 'n_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }
is_changed() { case "$changed" in *",$1,"*) return 0 ;; esac; return 1; }
add_node() { nodes="$nodes  $1$2$3$4"$'\n'; }            # <id> <open> <label> <close>
mark() { if is_changed "$1"; then classes="$classes  class $(nid "$1") changed;"$'\n'; fi; }
rel() { python3 -c 'import os,sys; print(os.path.normpath(sys.argv[1]))' "$1/$2" 2>/dev/null || printf '%s' "$1/$2"; }
kjson() { yq -o=json '.' "$1" 2>/dev/null || echo '{}'; }

walk() { # <dir> <indent>
  local dir="$1" ind="$2" k="$1/kustomization.yaml"
  case "$seen" in *"|$dir|"*) return ;; esac; seen="$seen$dir|"
  local id j kind label; id=$(nid "$dir"); j=$(kjson "$k")
  kind=$(jq -r '.kind // "Kustomization"' <<<"$j")
  label="$dir"; [ "$kind" = Component ] && label="$dir (Component)"
  if $mermaid; then add_node "$id" '[["' "$label" '"]]'; if is_changed "$k"; then classes="$classes  class $id changed;"$'\n'; fi; else echo "${ind}${label}"; fi

  local sec entry tgt tid
  # resources / components / bases
  while IFS=$'\t' read -r sec entry; do
    [ -n "$entry" ] || continue
    if [[ "$entry" =~ ^(https?://|git@|github\.com/|ssh://) ]]; then
      tid=$(nid "$entry")
      if $mermaid; then add_node "$tid" '>"' "$entry" '"]'; edges="$edges  $id --> $tid"$'\n'; else echo "${ind}  ↳ $entry  [remote]"; fi
      continue
    fi
    tgt=$(rel "$dir" "$entry")
    if [ -f "$tgt/kustomization.yaml" ]; then
      if $mermaid; then edges="$edges  $id --> $(nid "$tgt")"$'\n'; else echo "${ind}  ↳ $entry/  [$sec]"; fi
      walk "$tgt" "$ind    "
    else
      tid=$(nid "$tgt")
      if $mermaid; then add_node "$tid" '["' "$tgt" '"]'; mark "$tgt"; edges="$edges  $id --> $tid"$'\n'
      else echo "${ind}  · $entry$(is_changed "$tgt" && printf '  *changed*')"; fi
    fi
  done < <(jq -r '((.resources // []) | .[] | "resources\t\(.)"), ((.components // []) | .[] | "components\t\(.)"), ((.bases // []) | .[] | "bases\t\(.)")' <<<"$j")

  # helm charts
  local name ver repo
  while IFS=$'\t' read -r name ver repo; do
    [ -n "$name" ] || continue
    tid=$(nid "$dir/helm/$name")
    if $mermaid; then add_node "$tid" '(("' "helm $name@$ver" '"))'; edges="$edges  $id --> $tid"$'\n'; else echo "${ind}  ⎈ helm $name@$ver  ($repo)"; fi
  done < <(jq -r '(.helmCharts // []) | .[] | "\(.name // "?")\t\(.version // "?")\t\(.repo // "oci")"' <<<"$j")

  # generators + patches (files)
  while IFS=$'\t' read -r sec entry; do
    [ -n "$entry" ] || continue
    tgt=$(rel "$dir" "$entry"); tid=$(nid "$tgt")
    if $mermaid; then add_node "$tid" '["' "$tgt" '"]'; mark "$tgt"; edges="$edges  $id -.->|$sec| $tid"$'\n'
    else echo "${ind}  ∘ $entry  [$sec]$(is_changed "$tgt" && printf '  *changed*')"; fi
  done < <(jq -r '((.configMapGenerator // []) | .[] | ((.files // []) + (.envs // [])) | .[] | "configMapGenerator\t\(. | sub("^[^=]*=";""))"), ((.secretGenerator // []) | .[] | ((.files // []) + (.envs // [])) | .[] | "secretGenerator\t\(. | sub("^[^=]*=";""))"), ((.patches // []) | .[] | select(.path != null) | "patch\t\(.path)"), ((.patchesStrategicMerge // []) | .[] | select(type == "string") | "patch\t\(.)")' <<<"$j")
}

if $mermaid; then
  walk "$root" "" # collects nodes/edges/classes
  echo '```mermaid'
  echo 'graph LR'
  [ -n "$title" ] && echo "  subgraph \"$title\""
  printf '%s' "$nodes" | sort -u
  [ -n "$title" ] && echo "  end"
  printf '%s' "$edges" | sort -u
  echo '  classDef changed fill:#ffe9a8,stroke:#d97706,stroke-width:2px;'
  printf '%s' "$classes" | sort -u
  echo '```'
else
  walk "$root" ""
fi
