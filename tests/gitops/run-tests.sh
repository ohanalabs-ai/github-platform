#!/usr/bin/env bash
# Self-test of the devsecops-gitops scripts (actions/gitops/*), offline except for the
# multi-source cases that `helm template` a public chart. Run locally or from
# .github/workflows/gitops-selftest.yaml:
#
#   tests/gitops/run-tests.sh            # everything
#   ONLINE=false tests/gitops/run-tests.sh   # skip the cases that pull a chart
#
# Cases:
#   render/kustomize        base→head of a plain kustomization: +1 ~1 −0
#   render/multi-source     OCI chart bump 1.23.0 → 1.24.0 + $values + overlay: render_mode
#                           helm-template, charts[] records the bump, the diff is non-empty
#   render/fallback         a chart that cannot be templated → helm-template-partial + note,
#                           the git source still renders, exit 0
#   verdicts                argocd-diff.sh against a STUB `argocd` for every verdict —
#                           diff · noop · noop-allowed · noop-expected · noop-prune-nothing ·
#                           noop-live-equal · meta · new · error — and the 3× cache-miss retry
#                           (which must call `argocd app get … --refresh -o json`, never `-o name`)
#   report                  group-report cells (📝 live already equal …) and the gate summary
#   discover                the placeholder matrix row for 0 units
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
A="$root/actions/gitops"; F="$here/fixtures"; W="${RUNNER_TEMP:-/tmp}/gitops-selftest"; rm -rf "$W"; mkdir -p "$W"
ONLINE="${ONLINE:-true}"
export HELM_CACHE_HOME="$W/helm/cache" HELM_CONFIG_HOME="$W/helm/config" HELM_DATA_HOME="$W/helm/data"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok   $*"; }
bad()  { fail=$((fail+1)); echo "  FAIL $*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }
jqv() { jq -r "$2" "$1"; }

echo "== render/kustomize"
out="$W/rd-k"; bash "$A/render-diff/render-diff.sh" "$F/kustomize/head" "$F/kustomize/base" app "$out" >/dev/null 2>"$W/rd-k.err"
check "exit 0" "[ -f $out/summary.json ]"
check "render_mode kustomize" "[ \"\$(jqv $out/summary.json .render_mode)\" = kustomize ]"
check "+1 ~1 -0" "[ \"\$(jqv $out/summary.json '\"\\(.added) \\(.changed) \\(.removed)\"')\" = '1 1 0' ]"
check "changed object is the Deployment" "[ \"\$(jqv $out/summary.json '.objects.changed[0]')\" = deployment__demo__web ]"
out="$W/rd-new"; bash "$A/render-diff/render-diff.sh" "$F/kustomize/head" - app "$out" >/dev/null 2>&1
check "no base → new" "[ \"\$(jqv $out/summary.json .new)\" = true ] && [ \"\$(jqv $out/summary.json .base)\" = absent ]"

if [ "$ONLINE" = true ]; then
  echo "== render/multi-source (helm template, chart bump)"
  out="$W/rd-ms"
  MULTI_SOURCE=true APP_MANIFEST=argocd/vault-operator.yaml bash "$A/render-diff/render-diff.sh" "$F/multisource/head" "$F/multisource/base" overlay "$out" > "$W/rd-ms.log" 2>"$W/rd-ms.err"
  cat "$W/rd-ms.log"
  check "render_mode helm-template" "[ \"\$(jqv $out/summary.json .render_mode)\" = helm-template ]"
  check "chart bump recorded 1.23.0→1.24.0" "[ \"\$(jqv $out/summary.json '.charts[0] | \"\\(.chart) \\(.base) \\(.head)\"')\" = 'vault-operator 1.23.0 1.24.0' ]"
  check "chart objects rendered (>1 object, not just the overlay ConfigMap)" "[ \"\$(jqv $out/summary.json .total)\" -gt 1 ]"
  check "the bump + the overlay change show as a diff" "[ \"\$(jqv $out/summary.json .diff_bytes)\" -gt 0 ] && [ \"\$(jqv $out/summary.json .changed)\" -ge 2 ]"
  check "CHANGE_ME_* parameter became a placeholder" "grep -q 'ci-placeholder-aws-region' $out/head.yaml"
  check "no helm '# Source:' comments in the split objects" "! grep -rq '^# Source' $out/head-objs"

  echo "== render/fallback (chart cannot be templated)"
  out="$W/rd-broken"
  MULTI_SOURCE=true APP_MANIFEST=argocd/vault-operator.yaml bash "$A/render-diff/render-diff.sh" "$F/multisource/broken" "$F/multisource/base" overlay "$out" > "$W/rd-broken.log" 2>"$W/rd-broken.err"; rc=$?
  cat "$W/rd-broken.log"
  check "exit 0 (the unit is still rendered)" "[ $rc -eq 0 ]"
  check "render_mode helm-template-partial" "[ \"\$(jqv $out/summary.json .render_mode)\" = helm-template-partial ]"
  check "note says why" "jqv $out/summary.json .note | grep -q 'helm template failed'"
  check "overlay still rendered (1 object)" "[ \"\$(jqv $out/summary.json .total)\" = 1 ]"
else
  echo "== render/multi-source: skipped (ONLINE=false)"
fi

echo "== verdicts (stub argocd)"
stub="$W/stub-bin"; mkdir -p "$stub"
cat > "$stub/argocd" <<'EOF'
#!/usr/bin/env bash
# stub: STUB_DIFF_RC = exit code of `app diff`; STUB_CACHE_MISSES = how many diffs first fail with a cache miss
log="${STUB_LOG:?}"; echo "$*" >> "$log"
case "$1 $2" in
  "app diff")
    n=$(grep -c '^app diff' "$log")
    if [ "$n" -le "${STUB_CACHE_MISSES:-0}" ]; then echo "rpc error: code = Unknown desc = error getting cached app managed resources: cache: key is missing"; exit 20; fi
    [ "${STUB_DIFF_RC:-1}" = 1 ] && echo "===== apps/Deployment demo/web ====== (stub diff)"
    exit "${STUB_DIFF_RC:-1}" ;;
  "app get") echo '{}'; exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$stub/argocd"
frag() { # <name> <render json fields>
  echo "{\"app\":\"web\",\"render\":\"ok\",\"new\":false,\"changed_files\":[\"app/deployment.yaml\"],\"objects\":{\"added\":[],\"changed\":[],\"removed\":[]},$2}" > "$W/frag-$1.json"
}
frag change '"added":0,"changed":1,"removed":0,"objects":{"added":[],"changed":["deployment__demo__web"],"removed":[]}'
frag same '"added":0,"changed":0,"removed":0'
frag prune '"added":0,"changed":0,"removed":2,"objects":{"added":[],"changed":[],"removed":["configmap__demo__a","configmap__demo__b"]}'
verdict() { # <case> <diff-rc> <in-argocd> <frag> <block-noop> [misses] → status
  local c="$1"; local d="$W/v-$c"; mkdir -p "$d"
  rm -f "$d/stub.log"; : > "$d/out"
  ( cd "$root" && PATH="$stub:$PATH" STUB_LOG="$d/stub.log" STUB_DIFF_RC="$2" STUB_CACHE_MISSES="${6:-0}" \
      APP=web UNIT_PATH=tests/gitops/fixtures/kustomize/head/app DIFF_REV=0000000000000000000000000000000000000001 BASE_SHA="" \
      IN_ARGOCD="$3" RENDER_FRAG="$W/frag-$4.json" BLOCK_NOOP="$5" FRAG_DIR="$d" DIFF_OUT="$d/diff.txt" RETRY_SLEEP=0 \
      GITHUB_OUTPUT="$d/out" GITHUB_STEP_SUMMARY="$d/summary.md" bash "$A/argocd-diff/argocd-diff.sh" >/dev/null 2>&1 )
  sed -n 's/^status=//p' "$d/out"
}
check "diff"                "[ \"\$(verdict diff 1 true change true)\" = diff ]"
# render says NEW (base absent/unbuildable) but the app exists live and the live diff is empty → nothing explains it → blocked
echo '{"app":"web","render":"ok","new":true,"added":3,"changed":0,"removed":0,"objects":{"added":["a","b","c"],"changed":[],"removed":[]}}' > "$W/frag-newlive.json"
check "noop (blocked) — render new, live empty" "[ \"\$(verdict noop 0 true newlive true)\" = noop ]"
check "noop-allowed"        "[ \"\$(verdict allowed 0 true change false)\" = noop-allowed ]"
# a render of +0 ~0 -0 with an empty live diff is EXPECTED, not a blocking noop:
check "noop-expected (render +0 ~0 -0 → expected)" "[ \"\$(verdict expected 0 true same true)\" = noop-expected ]"
# …so the blocking `noop` needs a render fragment that is missing/unreadable (nothing to explain the empty live diff)
: > "$W/frag-none.json"
check "noop (blocked) — no usable render fragment" "[ \"\$(verdict noop2 0 true none true)\" = noop ]"
check "noop-prune-nothing"  "[ \"\$(verdict prune 0 true prune true)\" = noop-prune-nothing ]"
check "noop-live-equal (render +0 ~1 -0, live empty)" "[ \"\$(verdict liveeq 0 true change true)\" = noop-live-equal ]"
check "noop-live-equal names the changed object" "grep -q 'deployment__demo__web' $W/v-liveeq/act-web.md && grep -q 'Live already equal' $W/v-liveeq/act-web.md"
check "new (not in ArgoCD)" "[ \"\$(verdict new 0 false change true)\" = new ]"
check "error (exit 20, no cache miss)" "[ \"\$(verdict error 20 true change true)\" = error ]"
check "cache-miss retry → diff after 2 misses" "[ \"\$(verdict retry 1 true change true 2)\" = diff ]"
check "retry refreshed with 'app get --refresh -o json' twice" "[ \"\$(grep -c 'app get web --refresh -o json' $W/v-retry/stub.log)\" = 2 ]"
check "never 'app get … -o name'" "! grep -q 'app get.*-o name' $W/v-retry/stub.log"
check "3 misses → error" "[ \"\$(verdict retry3 1 true change true 3)\" = error ]"
# meta: a unit whose only changed files are docs — needs git; use this repo's own history if available
if git -C "$root" rev-parse HEAD >/dev/null 2>&1; then
  d="$W/v-meta"; mkdir -p "$d"; : > "$d/out"
  ( cd "$root" && PATH="$stub:$PATH" STUB_LOG="$d/stub.log" APP=web UNIT_PATH=tests/gitops/fixtures DIFF_REV="$(git rev-parse HEAD)" BASE_SHA="$(git rev-parse HEAD)" \
      IN_ARGOCD=true RENDER_FRAG="$W/frag-same.json" BLOCK_NOOP=true FRAG_DIR="$d" DIFF_OUT="$d/diff.txt" META_PATTERN='.*' RETRY_SLEEP=0 \
      GITHUB_OUTPUT="$d/out" GITHUB_STEP_SUMMARY="$d/summary.md" bash "$A/argocd-diff/argocd-diff.sh" >/dev/null 2>&1 )
  # same sha both sides → no changed files → not meta → falls through to the stub (rc 1 → diff)
  check "meta needs changed files (same sha → diff)" "[ \"\$(sed -n 's/^status=//p' $d/out)\" = diff ]"
fi

echo "== report + gate"
R="$W/report"; mkdir -p "$R/frags" "$R/out" "$R/groups"
units='[{"app":"a","path":"x/a","tier":"t"},{"app":"b","path":"x/b","tier":"t"},{"app":"c","path":"x/c","tier":"t"},{"app":"d","path":"x/d","tier":"t"}]'
mkfrag() { echo "{\"app\":\"$1\",\"render\":\"ok\",\"kinds\":5,\"new\":false,\"added\":$2,\"changed\":$3,\"removed\":$4,\"diff_bytes\":$5,\"changed_files\":[\"x/$1/f.yaml\"],\"render_mode\":\"${7:-kustomize}\",\"charts\":${8:-[]}}" > "$R/frags/render-$1.json"; echo "{\"app\":\"$1\",\"status\":\"$6\",\"note\":\"\"}" > "$R/frags/act-$1.json"; echo "live $1" > "$R/frags/act-$1.md"; }
mkfrag a 0 1 0 100 noop-live-equal
mkfrag b 1 0 0 50 diff
mkfrag c 0 0 0 0 noop-expected
mkfrag d 0 1 0 80 render-only helm-template '[{"chart":"kagent","base":"0.9.12","head":"0.9.13"}]'
bash "$A/group-report/gitops-group-report.sh" "$R/frags" cl grp diff https://run "$units" "$R/out" >/dev/null
check "cell: 📝 live already equal" "grep -q '| \`a\` | t | ✅ 5 | 🟡 +0 ~1 −0 objects | 📝 live already equal |' $R/out/comment.md"
check "cell: ✅ live diff" "grep -q '| \`b\` | .* | ✅ live diff |' $R/out/comment.md"
check "cell: 📝 expected no-op" "grep -q '📝 expected no-op' $R/out/comment.md"
check "cell: ⎈ helm + chart bump + render-only (multi-source)" "grep -q '✅ 5 · ⎈ helm | 🟡 +0 ~1 −0 objects · ⎈ kagent 0.9.12→0.9.13 | ℹ️ render-only (multi-source) |' $R/out/comment.md"
check "group.json has 4 units" "[ \"\$(jq '.units|length' $R/out/group.json)\" = 4 ]"
cp "$R/out/group.json" "$R/groups/group-cl-grp.json"
bash "$A/gate-summary/gitops-gate-summary.sh" "$R/groups" "$R/gate.md" diff >/dev/null; rc=$?
check "gate exit 0 (noop-live-equal is not a failure)" "[ $rc -eq 0 ]"
check "gate explains noop-live-equal" "grep -q 'already live, git catches up' $R/gate.md && grep -q 'render a change the cluster already carries' $R/gate.md"
mkfrag e 0 0 0 0 noop; units2='[{"app":"e","path":"x/e","tier":"t"}]'
bash "$A/group-report/gitops-group-report.sh" "$R/frags" cl grp2 diff https://run "$units2" "$R/out2" >/dev/null
check "cell: ❌ live no-op (blocked)" "grep -q '❌ live no-op (blocked)' $R/out2/comment.md"
mkdir -p "$R/groups2"; cp "$R/out2/group.json" "$R/groups2/group-cl-grp2.json"
bash "$A/gate-summary/gitops-gate-summary.sh" "$R/groups2" "$R/gate2.md" diff >/dev/null; rc=$?
check "gate exit 1 on a blocking noop" "[ $rc -eq 1 ]"

echo "== discover"
D="$W/discover"; mkdir -p "$D"; : > "$D/out"
# a fake repo-local discovery command: prints the JSON in $FAKE_UNITS, echoes its args to stderr
printf '#!/usr/bin/env bash\necho "args: $*" >&2; printf "%%s" "$FAKE_UNITS"\n' > "$D/fake-discover.sh"; chmod +x "$D/fake-discover.sh"
FAKE_UNITS='{"units":[],"unmapped":["README.md"]}' COMMAND="bash $D/fake-discover.sh --json" CHANGED="README.md" GROUP=g CLUSTER=c MODE=diff GITHUB_OUTPUT="$D/out" GITHUB_STEP_SUMMARY="$D/s.md" bash "$A/discover-units/discover.sh" >/dev/null 2>"$D/err"
check "0 units → has_changes=false + placeholder matrix" "grep -q '^has_changes=false' $D/out && grep -q '\"app\":\"(no units)\",\"noop\":true' $D/out"
check "changed files reach the command as trailing args" "grep -q 'args: --json README.md' $D/err"
FAKE_UNITS='{"units":[{"app":"a","path":"x","tier":"t","local":true,"multi_source":false,"render_only":false,"plugin":false}],"unmapped":[]}' COMMAND="bash $D/fake-discover.sh --json" CHANGED="x/f" GITHUB_OUTPUT="$D/out2" GITHUB_STEP_SUMMARY="$D/s2.md" bash "$A/discover-units/discover.sh" >/dev/null 2>&1
check "1 unit → matrix = units" "grep -q '^has_changes=true' $D/out2 && grep -q '^count=1' $D/out2"
FAKE_UNITS='not json' COMMAND="bash $D/fake-discover.sh" CHANGED="" GITHUB_OUTPUT="$D/out3" GITHUB_STEP_SUMMARY="$D/s3.md" bash "$A/discover-units/discover.sh" >/dev/null 2>&1; rc=$?
check "a command that prints no JSON fails the step" "[ $rc -ne 0 ]"

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
