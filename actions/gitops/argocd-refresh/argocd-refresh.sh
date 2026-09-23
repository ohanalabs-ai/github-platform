#!/usr/bin/env bash
# The ♻️ post-merge refresh + VALIDATION of ONE unit (actions/gitops/argocd-refresh/action.yaml):
# hard-refresh the Application, then PROVE the merge landed — poll `argocd app get` until
# the git SHA ArgoCD synced == WANT and the app is Synced + Healthy (TIMEOUT), then cross-
# check in-cluster with a read-only kubeconfig when one is provided (`kubectl get
# application` revision, `kubectl rollout status` for every Deployment/StatefulSet/DaemonSet
# the unit renders). ArgoCD's automated sync does the APPLY — this never applies anything.
#
# Multi-source Applications (OCI chart + git $values) have NO status.sync.revision — the git
# SHA is one entry of status.sync.revisions[] (the chart versions are the others): the wanted
# SHA is the first 40-hex entry across both fields; a single-source app keeps using .revision.
# `argocd app get` has NO `-o name` output format (json|yaml|wide|tree) — always `-o json`.
#
# Environment:
#   APP UNIT_PATH WANT(the merged sha) IN_ARGOCD(true|false|unknown) FRAG_DIR
#   NEW_APPS_APPEAR_AFTER_MERGE  "true" → an app not in ArgoCD yet is CREATED by the merge
#                                (ApplicationSet): poll until it appears; "false" → report `new`
#   NEW_APP_HINT                 text for the `new` verdict
#   KUBECONFIG_CONTENT           optional read-only kubeconfig (from Vault) → in-cluster cross-check
#   KUBECONFIG_HINT              text when no kubeconfig is configured
#   RENDERED                     the unit's head.yaml (rollouts to wait for), optional
#   MANIFEST                     the unit's Application manifest (repo-relative), optional — a
#                                fallback source of spec.destination.namespace
#   DESTINATION_NAMESPACE        explicit override of the destination namespace, optional
#   TIMEOUT(900) POLL(20)
#
# Namespace of a rendered object: `metadata.namespace` when the manifest carries one, else the
# Application's `spec.destination.namespace` (read from `argocd app get -o json`, then from
# MANIFEST), and only then `default` — a Helm subchart typically renders its objects WITHOUT a
# namespace and ArgoCD places them in the destination namespace; `${ns:-default}` looked for
# openobserve's NATS StatefulSet in `default` and failed a healthy unit (planeo-infra, 2026-09-23).
# Writes FRAG_DIR/act-<app>.json {app,status:validated|new|refresh-failed|validate-failed,revision,health,note}
# + act-<app>.md; exits non-zero unless validated (or new).
set -uo pipefail
: "${APP:?}" "${WANT:?}" "${FRAG_DIR:?}"
UNIT_PATH="${UNIT_PATH:-}"; IN_ARGOCD="${IN_ARGOCD:-unknown}"; NEW_APPS_APPEAR_AFTER_MERGE="${NEW_APPS_APPEAR_AFTER_MERGE:-false}"
NEW_APP_HINT="${NEW_APP_HINT:-it is created by the bootstrap}"; KUBECONFIG_CONTENT="${KUBECONFIG_CONTENT:-}"
KUBECONFIG_HINT="${KUBECONFIG_HINT:-kubeconfig-vault-path not configured}"; RENDERED="${RENDERED:-}"
MANIFEST="${MANIFEST:-}"; DESTINATION_NAMESPACE="${DESTINATION_NAMESPACE:-}"
TIMEOUT="${TIMEOUT:-900}"; POLL="${POLL:-20}"; SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
mkdir -p "$FRAG_DIR"; md="$FRAG_DIR/act-$APP.md"; [ -f "$md" ] || { echo "#### \`$APP\` — \`$UNIT_PATH\`"; echo; } > "$md"
st="validated"; notes=()
tmp="${RUNNER_TEMP:-/tmp}/argocd-refresh-$APP"; mkdir -p "$tmp"
git_sha='[.status.sync.revision, (.status.sync.revisions // [])[], .status.operationState.syncResult.revision, (.status.operationState.syncResult.revisions // [])[]] | map(select(type=="string" and test("^[0-9a-f]{40}$"))) | .[0] // "?"'

if [ "$IN_ARGOCD" = "false" ] && [ "$NEW_APPS_APPEAR_AFTER_MERGE" != true ]; then
  # Pre-bootstrap: nothing to refresh or validate — the merge lands in git only.
  jq -n --arg a "$APP" --arg h "$NEW_APP_HINT" '{app:$a,status:"new",revision:"",health:"",note:("not in ArgoCD yet — " + $h)}' > "$FRAG_DIR/act-$APP.json"
  echo "🆕 **Not in ArgoCD yet** — \`$APP\`: $NEW_APP_HINT; nothing to refresh or validate for this merge." >> "$md"
  cat "$md" >> "$SUMMARY"; exit 0
fi
if [ "$IN_ARGOCD" = "false" ]; then echo "$APP not visible yet — created after the merge (ApplicationSet); polling until it appears"; fi
if ! argocd app get "$APP" --hard-refresh -o json >/dev/null 2>&1; then
  if [ "$IN_ARGOCD" = "false" ]; then notes+=("hard-refresh: app not (yet) visible"); else st="refresh-failed"; notes+=("hard-refresh failed"); fi
fi
# 1. ArgoCD: poll until the synced revision is THIS commit and the app is Synced + Healthy
deadline=$(( $(date +%s) + TIMEOUT )); rev="?"; health="?"; sync="?"
while [ "$(date +%s)" -lt "$deadline" ]; do
  argocd app get "$APP" -o json > "$tmp/app.json" 2>/dev/null || { sleep "$POLL"; continue; }
  rev=$(jq -r "$git_sha" "$tmp/app.json")
  health=$(jq -r '.status.health.status // "?"' "$tmp/app.json"); sync=$(jq -r '.status.sync.status // "?"' "$tmp/app.json")
  phase=$(jq -r '.status.operationState.phase // "-"' "$tmp/app.json")
  if [ "$rev" = "$WANT" ] && [ "$health" = Healthy ] && [ "$sync" = Synced ]; then break; fi
  echo "waiting: revision=${rev::7} (want ${WANT::7}) sync=$sync health=$health op=$phase"; sleep "$POLL"
done
if [ "$rev" != "$WANT" ] || [ "$health" != Healthy ] || [ "$sync" != Synced ]; then st="validate-failed"; notes+=("ArgoCD: revision ${rev::7} (want ${WANT::7}), sync $sync, health $health after $((TIMEOUT/60)) min"); fi
echo "- ArgoCD: revision \`${rev::7}\` (want \`${WANT::7}\`), sync **$sync**, health **$health**" >> "$md"
# the namespace a namespace-less rendered object lands in: the Application's destination
dest_ns="$DESTINATION_NAMESPACE"
[ -n "$dest_ns" ] || [ ! -s "$tmp/app.json" ] || dest_ns=$(jq -r '.spec.destination.namespace // ""' "$tmp/app.json" 2>/dev/null || true)
[ -n "$dest_ns" ] || [ -z "$MANIFEST" ] || [ ! -f "$MANIFEST" ] || dest_ns=$(yq -r '.spec.destination.namespace // ""' "$MANIFEST" 2>/dev/null || true)
[ -n "$dest_ns" ] || dest_ns=default
# 2. in-cluster cross-check with a read-only kubeconfig
if [ -n "$KUBECONFIG_CONTENT" ]; then
  export KUBECONFIG="$tmp/kubeconfig"; umask 077; printf '%s' "$KUBECONFIG_CONTENT" > "$KUBECONFIG"
  krev=$(kubectl get application -n argocd "$APP" -o json 2>/dev/null | jq -r '[.status.sync.revision, (.status.sync.revisions // [])[]] | map(select(type=="string" and test("^[0-9a-f]{40}$"))) | .[0] // "?"' 2>/dev/null || echo "?")
  echo "- kubectl: Application \`$APP\` sync.revision \`${krev::7}\`" >> "$md"
  [ "$krev" = "$WANT" ] || { st="validate-failed"; notes+=("kubectl sees revision ${krev::7}"); }
  if [ -n "$RENDERED" ] && [ -f "$RENDERED" ]; then
    while IFS='|' read -r kind ns name; do
      [ -n "$name" ] || continue
      ns="${ns:-$dest_ns}" # a namespace-less object (Helm subcharts) lands in the destination namespace
      if kubectl -n "$ns" rollout status "$kind/$name" --timeout=300s >/dev/null 2>&1; then echo "- ✅ rollout \`$ns/$kind/$name\`" >> "$md"
      else echo "- ❌ rollout \`$ns/$kind/$name\` not complete" >> "$md"; st="validate-failed"; notes+=("rollout $ns/$kind/$name"); fi
    done < <(yq -N 'select(.kind=="Deployment" or .kind=="StatefulSet" or .kind=="DaemonSet") | .kind + "|" + (.metadata.namespace // "") + "|" + .metadata.name' "$RENDERED" 2>/dev/null)
  fi
else
  echo "- ⏭️ kubectl cross-check skipped: not configured ($KUBECONFIG_HINT)" >> "$md"
fi
jq -n --arg a "$APP" --arg s "$st" --arg r "${rev::7}" --arg h "$health" --arg n "$(IFS='; '; echo "${notes[*]-}")" '{app:$a,status:$s,revision:$r,health:$h,note:$n}' > "$FRAG_DIR/act-$APP.json"
if [ "$st" = validated ]; then echo "✅ **validated** — \`${WANT::7}\` is live and Healthy" >> "$md"; else echo "❌ **$st** — $(IFS='; '; echo "${notes[*]-}")" >> "$md"; fi
cat "$md" >> "$SUMMARY"
[ "$st" = validated ]
