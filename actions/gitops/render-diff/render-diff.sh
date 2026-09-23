#!/usr/bin/env bash
# Rendered base-vs-head diff of ONE GitOps unit — what a merge WILL change,
# independent of ArgoCD: render the unit's path in the PR head tree and in the
# PR base tree, split both renders into one file per object, normalise (sorted
# keys), and diff them.
#
#   render-diff.sh <head-tree> <base-tree|-> <unit-path> <out-dir>
#
#   <head-tree>  checkout of the PR head (usually the workspace)
#   <base-tree>  checkout of the PR base (a second checkout), or `-` for "no base"
#   <unit-path>  the unit's git source path, e.g. addons/core/cert-manager
#   <out-dir>    receives: head.yaml, diff.txt (unified, per object), summary.json
#                {new, base, added, changed, removed, unchanged, total, diff_bytes,
#                 objects:{added:[…],changed:[…],removed:[…]},
#                 render_mode: kustomize|plugin|helm-template|helm-template-partial,
#                 charts:[{chart,repo,release,base,head}], note}
#
# Environment (all optional):
#   KUSTOMIZE_BUILD_ARGS   flags after `kustomize build` (default `--enable-helm`;
#                          a repo whose overlays reference siblings above their dir
#                          passes `--enable-helm --load-restrictor LoadRestrictionsNone`)
#   KUSTOMIZE_CMD          overrides the whole build command (runs with the tree as cwd)
#   RENDER_PLUGIN=true     the unit's Application uses a Config Management Plugin:
#   RENDER_PLUGIN_SCRIPT   render with THAT script (repo-relative, e.g.
#                          addons/platform/argocd/cmp/render.sh) so the diff is
#                          structurally what ArgoCD applies. CI has no access to the
#                          live CHANGE_ME_* table, so every token found in the tree
#                          gets a deterministic placeholder (`ci-placeholder-<name>`):
#                          comparable base vs head, NOT the live values. Falls back to
#                          kustomize when the tree has no such script.
#   PLANEO_LABELS          "k=v,k=v" passed to the plugin as the Application's plugin env
#   MULTI_SOURCE=true      the Application has spec.sources[] (OCI/HTTP Helm chart(s) +
#   APP_MANIFEST           a git source carrying `$values` and/or a kustomize path):
#                          parse THAT manifest (repo-relative) in each tree, `helm
#                          template` every chart source at its targetRevision with the
#                          $values file(s) of that tree (+ helm.parameters, CHANGE_ME_*
#                          → placeholders) and build the git source's path like a
#                          single-source unit; concatenate → the same split/normalise/
#                          diff. A chart version bump therefore shows as a diff. If a
#                          chart cannot be templated (registry unreachable, unknown
#                          version…) the unit falls back to the git source only and
#                          says why (render_mode helm-template-partial + note).
#   HELM_KUBE_VERSION      --kube-version for helm template (default 1.33.0)
#   HELM_EXTRA_ARGS        extra flags for every helm template call
#
# Exit 0 on success (a non-empty diff is NOT an error), 1 if the HEAD build fails
# (a failing BASE build is reported as base "unbuildable" and treated like new).
# Needs yq (mikefarah v4), jq, diff; kustomize/helm on PATH (binaries or shims).
set -uo pipefail

head_tree="${1:?head tree}"; base_tree="${2:?base tree or -}"; unit="${3:?unit path}"; out="${4:?out dir}"
KUSTOMIZE_BUILD_ARGS="${KUSTOMIZE_BUILD_ARGS:---enable-helm}"
KUSTOMIZE_CMD="${KUSTOMIZE_CMD:-kustomize build $KUSTOMIZE_BUILD_ARGS}"
RENDER_PLUGIN="${RENDER_PLUGIN:-false}"
RENDER_PLUGIN_SCRIPT="${RENDER_PLUGIN_SCRIPT:-}"
MULTI_SOURCE="${MULTI_SOURCE:-false}"
APP_MANIFEST="${APP_MANIFEST:-}"
HELM_KUBE_VERSION="${HELM_KUBE_VERSION:-1.33.0}"
HELM_EXTRA_ARGS="${HELM_EXTRA_ARGS:-}"
mkdir -p "$out/head-objs" "$out/base-objs"
abs() { (cd "$1" 2>/dev/null && pwd); }

# every CHANGE_ME_* token in the tree → "CHANGE_ME_X=ci-placeholder-x …"
placeholder_env() { # <tree>
  grep -rhoE 'CHANGE_ME_[A-Z0-9_]+' "$1" --exclude-dir=.git --exclude-dir='.gitops-*' --exclude-dir=charts 2>/dev/null | sort -u \
    | while IFS= read -r t; do lc=$(printf '%s' "${t#CHANGE_ME_}" | tr 'A-Z_' 'a-z-'); printf '%s=ci-placeholder-%s ' "$t" "$lc"; done
}
placeholder_value() { # CHANGE_ME_X → ci-placeholder-x ; anything else unchanged
  case "$1" in
    CHANGE_ME_*) printf 'ci-placeholder-%s' "$(printf '%s' "${1#CHANGE_ME_}" | tr 'A-Z_' 'a-z-')" ;;
    *) printf '%s' "$1" ;;
  esac
}

kbuild() { # <tree> <path> <outfile> → 0/1 ; kustomize (or the CMP script) of one git path
  if [ "$RENDER_PLUGIN" = true ] && [ -n "$RENDER_PLUGIN_SCRIPT" ] && [ -x "$1/$RENDER_PLUGIN_SCRIPT" ]; then
    # The CMP contract is cwd = the unit's path inside the tree, so the tree must be
    # ABSOLUTE before the `cd` — a relative tree would make the script path and
    # placeholder_env resolve inside the unit dir.
    local tree envs
    tree="$(abs "$1")"
    envs="$(placeholder_env "$tree")"
    # shellcheck disable=SC2086 # word-splitting the KEY=value list is intended
    ( cd "$tree/$2" && env $envs ARGOCD_APP_SOURCE_PATH="$2" \
        PLANEO_LABELS="${PLANEO_LABELS:-}" ARGOCD_ENV_PLANEO_LABELS="${PLANEO_LABELS:-}" \
        bash "$tree/$RENDER_PLUGIN_SCRIPT" ) > "$3" 2> "$3.err"
  else
    ( cd "$1" && eval "$KUSTOMIZE_CMD" "\"$2\"" ) > "$3" 2> "$3.err"
  fi
}

# ---- multi-source: helm template every chart source of the Application manifest
charts_json='[]' # accumulated per tree: [{tree,chart,repo,release,version,status,error}]
helm_render() { # <tree> <manifest> <source-index> <namespace> → stdout manifests; 0/1
  local tree="$1" m="$2" i="$3" ns="$4" repo chart ver rel args=() vf p f tmpv
  repo=$(yq -r ".spec.sources[$i].repoURL // \"\"" "$m"); chart=$(yq -r ".spec.sources[$i].chart" "$m")
  ver=$(yq -r ".spec.sources[$i].targetRevision // \"\"" "$m"); rel=$(yq -r ".spec.sources[$i].helm.releaseName // \"$chart\"" "$m")
  args=(template "$rel")
  case "$repo" in
    http://*|https://*) args+=("$chart" --repo "$repo") ;;
    oci://*) args+=("$repo/$chart") ;;
    *) args+=("oci://$repo/$chart") ;;
  esac
  [ -n "$ver" ] && args+=(--version "$ver")
  args+=(--namespace "$ns" --kube-version "$HELM_KUBE_VERSION")
  [ "$(yq -r ".spec.sources[$i].helm.skipCrds // false" "$m")" = true ] || args+=(--include-crds)
  # $values/<path> (any `$<ref>/<path>`): the ref is a git source of THIS repo → the tree's own file
  while IFS= read -r vf; do
    [ -n "$vf" ] || continue
    case "$vf" in
      \$*/*) p="${vf#\$*/}"; f="$tree/$p" ;;
      *) echo "note: valueFiles entry '$vf' is not \$ref-relative — skipped" >&2; continue ;;
    esac
    if [ -f "$f" ]; then args+=(-f "$f")
    elif [ "$(yq -r ".spec.sources[$i].helm.ignoreMissingValueFiles // false" "$m")" = true ]; then :
    else echo "values file $p missing in tree" >&2; return 1; fi
  done < <(yq -r ".spec.sources[$i].helm.valueFiles // [] | .[]" "$m")
  # inline values / valuesObject → temp files
  if [ "$(yq -r ".spec.sources[$i].helm.values // \"\"" "$m")" != "" ]; then
    tmpv=$(mktemp); yq -r ".spec.sources[$i].helm.values" "$m" > "$tmpv"; args+=(-f "$tmpv")
  fi
  if [ "$(yq -r ".spec.sources[$i].helm.valuesObject // \"\"" "$m")" != "" ]; then
    tmpv=$(mktemp); yq -o=yaml ".spec.sources[$i].helm.valuesObject" "$m" > "$tmpv"; args+=(-f "$tmpv")
  fi
  # parameters (`--set` wins over valueFiles, as in ArgoCD); CHANGE_ME_* → placeholder
  while IFS=$'\t' read -r pn pv ps; do
    [ -n "$pn" ] || continue
    pv="$(placeholder_value "$pv")"
    if [ "$ps" = true ]; then args+=(--set-string "$pn=$pv"); else args+=(--set "$pn=$pv"); fi
  done < <(yq -r ".spec.sources[$i].helm.parameters // [] | .[] | [.name, (.value // \"\"), (.forceString // false)] | @tsv" "$m")
  # shellcheck disable=SC2086 # HELM_EXTRA_ARGS is a flag list
  helm "${args[@]}" $HELM_EXTRA_ARGS
}

mbuild() { # <tree> <outfile> <with-charts:true|false> → 0/1 ; concatenated render of every source
  local tree="$1" outf="$2" with_charts="$3" m ns n i chart p tmp rc=0 repo ver rel st err
  m="$tree/$APP_MANIFEST"
  : > "$outf"; : > "$outf.err"
  [ -f "$m" ] || { echo "Application manifest $APP_MANIFEST not in tree" > "$outf.err"; return 1; }
  ns=$(yq -r '.spec.destination.namespace // "default"' "$m")
  n=$(yq -r '.spec.sources | length' "$m")
  for i in $(seq 0 $((n-1))); do
    chart=$(yq -r ".spec.sources[$i].chart // \"\"" "$m")
    if [ -n "$chart" ] && [ "$with_charts" = true ]; then
      repo=$(yq -r ".spec.sources[$i].repoURL // \"\"" "$m"); ver=$(yq -r ".spec.sources[$i].targetRevision // \"\"" "$m")
      rel=$(yq -r ".spec.sources[$i].helm.releaseName // \"$chart\"" "$m")
      tmp=$(mktemp)
      if helm_render "$tree" "$m" "$i" "$ns" > "$tmp" 2> "$tmp.err"; then
        st=ok; err=""
        # helm's `# Source:` comments and comment-only docs are not objects — drop them
        { echo "---"; yq 'select(.kind != null) | ... comments=""' "$tmp"; } >> "$outf"
      else
        st=failed; err="$(tail -c 600 "$tmp.err")"; rc=1
        { echo "helm template $rel ($repo/$chart@$ver) failed:"; cat "$tmp.err"; } >> "$outf.err"
      fi
      charts_json=$(jq -c --arg t "$(basename "$tree")" --arg c "$chart" --arg r "$repo" --arg rel "$rel" --arg v "$ver" --arg s "$st" --arg e "$err" \
        '. + [{tree:$t,chart:$c,repo:$r,release:$rel,version:$v,status:$s,error:$e}]' <<<"$charts_json")
      rm -f "$tmp" "$tmp.err"
    fi
    p=$(yq -r ".spec.sources[$i].path // \"\"" "$m")
    if [ -n "$p" ]; then
      tmp=$(mktemp)
      if kbuild "$tree" "$p" "$tmp"; then { echo "---"; cat "$tmp"; } >> "$outf"
      else cat "$tmp.err" >> "$outf.err"; rm -f "$tmp" "$tmp.err"; return 2; fi
      rm -f "$tmp" "$tmp.err"
    fi
  done
  return $rc
}

# split a multi-doc render into <kind>__<ns>__<name>.yml, keys sorted
split_objs() { # <render.yaml> <dir>
  local render="$1" dir="$2"
  [ -s "$render" ] || return 0
  # explicit ".yml": yq only appends one when the name has no dot, and CRD names do
  ( cd "$dir" && yq -s '((.kind // "unknown") | downcase) + "__" + (.metadata.namespace // "_cluster") + "__" + (.metadata.name // "_unnamed") + ".yml"' "$render" ) 2>/dev/null
  local f
  for f in "$dir"/*.yml; do
    [ -f "$f" ] || continue
    yq -P 'sort_keys(..)' -i "$f" 2>/dev/null || true
  done
}

new=false; base_state="ok"; render_mode="kustomize"; note=""
[ "$RENDER_PLUGIN" = true ] && [ -n "$RENDER_PLUGIN_SCRIPT" ] && [ -x "$head_tree/$RENDER_PLUGIN_SCRIPT" ] && render_mode="plugin"

if [ "$MULTI_SOURCE" = true ] && [ -n "$APP_MANIFEST" ]; then
  render_mode="helm-template"
  # HEAD (with charts); a chart failure → fall back to the git source(s) only, in BOTH trees
  mbuild "$head_tree" "$out/head.yaml" true; hrc=$?
  if [ "$hrc" -eq 2 ]; then
    echo "HEAD build failed for $unit:" >&2; cat "$out/head.yaml.err" >&2
    jq -n --arg u "$unit" --rawfile e "$out/head.yaml.err" '{unit:$u,head_build:"failed",render_mode:"helm-template",error:($e|.[0:2000])}' > "$out/summary.json"
    exit 1
  fi
  base_has_manifest=false; [ "$base_tree" != "-" ] && [ -f "$base_tree/$APP_MANIFEST" ] && base_has_manifest=true
  brc=0
  if [ "$base_has_manifest" = true ]; then mbuild "$base_tree" "$out/base.yaml" true; brc=$?; fi
  if [ "$hrc" -eq 1 ] || [ "$brc" -eq 1 ]; then
    failed=$(jq -r '[.[] | select(.status=="failed")] | map("\(.release) (\(.repo)/\(.chart)@\(.version)): \(.error | split("\n")[0])") | unique | join("; ")' <<<"$charts_json")
    note="helm template failed — chart sources left out of the rendered diff (git source only): $failed"
    render_mode="helm-template-partial"
    charts_json=$(jq -c '[.[] | select(.status!="failed")]' <<<"$charts_json")
    mbuild "$head_tree" "$out/head.yaml" false || { echo "HEAD build failed for $unit:" >&2; cat "$out/head.yaml.err" >&2
      jq -n --arg u "$unit" --rawfile e "$out/head.yaml.err" '{unit:$u,head_build:"failed",render_mode:"helm-template-partial",error:($e|.[0:2000])}' > "$out/summary.json"; exit 1; }
    [ "$base_has_manifest" = true ] && { mbuild "$base_tree" "$out/base.yaml" false; brc=$?; }
  fi
  if [ "$base_has_manifest" != true ]; then new=true; base_state="absent"
  elif [ "$brc" -ne 0 ]; then new=true; base_state="unbuildable"; echo "note: BASE build failed for $unit (treated as new):" >&2; head -5 "$out/base.yaml.err" >&2; fi
  # chart versions base → head (a bump is a diff in its own right)
  charts=$(jq -c --arg h "$(basename "$head_tree")" --arg b "$(basename "$base_tree")" '
    [group_by(.chart) | .[] | {chart: .[0].chart, repo: .[0].repo, release: .[0].release,
      head: ([.[] | select(.tree==$h) | .version] | first // ""), base: ([.[] | select(.tree==$b) | .version] | first // "")}]' <<<"$charts_json")
  if [ "$head_tree" = "$base_tree" ]; then charts='[]'; fi
else
  charts='[]'
  if ! kbuild "$head_tree" "$unit" "$out/head.yaml"; then
    echo "HEAD build failed for $unit:" >&2; cat "$out/head.yaml.err" >&2
    jq -n --arg u "$unit" --rawfile e "$out/head.yaml.err" --arg rm "$render_mode" '{unit:$u,head_build:"failed",render_mode:$rm,error:($e|.[0:2000])}' > "$out/summary.json"
    exit 1
  fi
  if [ "$base_tree" = "-" ] || [ ! -e "$base_tree/$unit/kustomization.yaml" ]; then
    new=true; base_state="absent"
  elif ! kbuild "$base_tree" "$unit" "$out/base.yaml"; then
    new=true; base_state="unbuildable"
    echo "note: BASE build failed for $unit (treated as new):" >&2; head -5 "$out/base.yaml.err" >&2
  fi
fi

split_objs "$out/head.yaml" "$out/head-objs"
[ "$new" = false ] && split_objs "$out/base.yaml" "$out/base-objs"

added=(); removed=(); changed=(); unchanged=0
for f in "$out"/head-objs/*.yml; do
  [ -f "$f" ] || continue
  b="$out/base-objs/$(basename "$f")"
  if [ ! -f "$b" ]; then added+=("$(basename "$f" .yml)")
  elif ! cmp -s "$f" "$b"; then changed+=("$(basename "$f" .yml)")
  else unchanged=$((unchanged+1)); fi
done
for f in "$out"/base-objs/*.yml; do
  [ -f "$f" ] || continue
  [ -f "$out/head-objs/$(basename "$f")" ] || removed+=("$(basename "$f" .yml)")
done

( cd "$out" && diff -ruN base-objs head-objs ) > "$out/diff.txt" 2>/dev/null || true
total=$(find "$out/head-objs" -name '*.yml' | wc -l | tr -d ' ')
bytes=$(wc -c < "$out/diff.txt" | tr -d ' ')

to_json() { printf '%s\n' "$@" | jq -R -s -c 'split("\n") | map(select(length>0))'; }
jq -n --arg u "$unit" --argjson new "$new" --arg bs "$base_state" --arg rm "$render_mode" --arg note "$note" --argjson charts "$charts" \
  --argjson added "$(to_json "${added[@]-}")" --argjson changed "$(to_json "${changed[@]-}")" --argjson removed "$(to_json "${removed[@]-}")" \
  --argjson unchanged "$unchanged" --argjson total "$total" --argjson bytes "$bytes" \
  '{unit:$u,head_build:"ok",new:$new,base:$bs,render_mode:$rm,note:$note,charts:$charts,added:($added|length),changed:($changed|length),removed:($removed|length),unchanged:$unchanged,total:$total,diff_bytes:$bytes,objects:{added:$added,changed:$changed,removed:$removed}}' \
  > "$out/summary.json"

jq -r '"\(.unit) [\(.render_mode)]: \(if .new then "NEW (base \(.base)) — " else "" end)+\(.added) ~\(.changed) -\(.removed) =\(.unchanged) (\(.total) objects, diff \(.diff_bytes) bytes)" + (if (.charts|length)>0 then " charts: " + (.charts | map("\(.chart) \(.base)→\(.head)") | join(", ")) else "" end)' "$out/summary.json"
