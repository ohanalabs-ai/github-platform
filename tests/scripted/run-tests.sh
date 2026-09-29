#!/usr/bin/env bash
# Self-test of the devsecops-scripted scripts (actions/scripted/*), offline — no docker, no
# cluster. Run locally or from .github/workflows/scripted-selftest.yaml:
#
#   tests/scripted/run-tests.sh
#
# Cases:
#   run-command/capture      stdout is captured to CAPTURE_FILE and echoed; stderr is NOT captured;
#                            exit-code/capture-file/lines land in GITHUB_OUTPUT; the step fails on rc≠0
#   run-command/allow        ALLOW_FAILURE=true → rc reported, step exits 0
#   run-command/forward      FORWARD_ENV names that are unset are skipped (no `-e NAME` for them)
#                            — checked through the log line, without docker
#   summary/preview          header, the red banner, the verbatim commands, the embedded preview,
#                            the gate sentence for gated / ungated / preview-only, the failure note
#   summary/apply            approved preview + apply output + post output; truncation note
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
A="$root/actions/scripted"; W="${RUNNER_TEMP:-/tmp}/scripted-selftest"; rm -rf "$W"; mkdir -p "$W"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok   $*"; }
bad()  { fail=$((fail+1)); echo "  FAIL $*"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [$2]"; fi; }

echo "== run-command/capture"
out="$W/cap.out"; go="$W/go1"; : > "$go"
COMMAND='echo "# hello"; echo "chatter" >&2; exit 0' TITLE=preview CAPTURE_FILE="$out" GITHUB_OUTPUT="$go" RUNNER_TEMP="$W" \
  bash "$A/run-command/run.sh" >"$W/cap.log" 2>"$W/cap.err"; rc=$?
check "exit 0" "[ $rc -eq 0 ]"
check "stdout captured" "[ \"\$(cat $out)\" = '# hello' ]"
check "stderr not captured" "! grep -q chatter $out"
check "stderr in the log" "grep -q chatter $W/cap.err"
check "outputs: exit-code=0" "grep -q '^exit-code=0$' $go"
check "outputs: lines=1" "grep -q '^lines=1$' $go"
check "outputs: capture-file" "grep -q \"^capture-file=$out\$\" $go"

echo "== run-command/failure propagates"
go="$W/go2"; : > "$go"
COMMAND='echo partial; exit 3' TITLE=apply CAPTURE_FILE="$W/fail.out" GITHUB_OUTPUT="$go" RUNNER_TEMP="$W" \
  bash "$A/run-command/run.sh" >/dev/null 2>&1; rc=$?
check "step exits with the command's rc (3)" "[ $rc -eq 3 ]"
check "exit-code=3 recorded" "grep -q '^exit-code=3$' $go"
check "partial stdout still captured" "[ \"\$(cat $W/fail.out)\" = partial ]"

echo "== run-command/allow"
go="$W/go3"; : > "$go"
COMMAND='exit 2' TITLE=preview ALLOW_FAILURE=true CAPTURE_FILE="$W/allow.out" GITHUB_OUTPUT="$go" RUNNER_TEMP="$W" \
  bash "$A/run-command/run.sh" >/dev/null 2>&1; rc=$?
check "ALLOW_FAILURE → step exits 0" "[ $rc -eq 0 ]"
check "exit-code=2 recorded" "grep -q '^exit-code=2$' $go"

echo "== run-command/forward (static: unset names skipped)"
# Exercise the forwarding filter without docker: the loop that builds `-e NAME` is the
# contract — set one name, leave one unset, check the script's own log line.
fw="$W/fw.sh"
sed -n '/^  env_args=()/,/^  done$/p' "$A/run-command/run.sh" > "$fw"
FORWARD_ENV="SET_ONE UNSET_ONE" SET_ONE=x bash -c "$(cat "$fw"); printf '%s\n' \"\${env_args[@]}\"" > "$W/fw.out" 2>/dev/null
check "set name forwarded" "grep -qx 'SET_ONE' $W/fw.out"
check "unset name skipped" "! grep -q 'UNSET_ONE' $W/fw.out"

echo "== summary/preview"
printf '## vault-seed\n| path | keys |\n|---|---|\n| a/b | k1, k2 |\n' > "$W/preview.md"
MODE=preview PHASE=vault-seed TARGET=platform SETUP_CMD='bash scripts/tf-init.sh' PREVIEW_CMD='bash scripts/preview-phase.sh vault-seed' \
  APPLY_CMD='bash scripts/run-phase.sh vault-seed' GATED=true ENVIRONMENT=production DESTRUCTIVE=false \
  PREVIEW_FILE="$W/preview.md" PREVIEW_RC=0 RUN_URL=https://x/r/1 REF=develop ACTOR=me EVENT=workflow_dispatch \
  OUT="$W/s1.md" bash "$A/phase-summary/summary.sh"
check "header names phase · target" "grep -q '^# 🔍 vault-seed · platform — preview' $W/s1.md"
check "no red banner" "! grep -q 'DESTRUCTIVE PHASE' $W/s1.md"
check "gate row names the Environment" "grep -q 'waits for a reviewer of the Environment \`production\`' $W/s1.md"
check "commands verbatim: setup" "grep -q '| \`setup\` | \`bash scripts/tf-init.sh\` |' $W/s1.md"
check "commands verbatim: apply" "grep -q '| \`apply\` | \`bash scripts/run-phase.sh vault-seed\` |' $W/s1.md"
check "preview embedded" "grep -q '| a/b | k1, k2 |' $W/s1.md"
check "next: approve sentence" "grep -q 'approve the \`🚀 apply\` job' $W/s1.md"

MODE=preview PHASE=teardown APPLY_CMD='bash scripts/teardown-k8s.sh' GATED=true DESTRUCTIVE=true PREVIEW_FILE="$W/preview.md" \
  PREVIEW_RC=1 OUT="$W/s2.md" bash "$A/phase-summary/summary.sh"
check "red banner when destructive" "grep -q 'DESTRUCTIVE PHASE' $W/s2.md"
check "failure note when preview rc≠0" "grep -q 'exited \*\*1\*\* — the apply job is blocked' $W/s2.md"

MODE=preview PHASE=verify APPLY_CMD='bash scripts/verify.sh' GATED=false PREVIEW_FILE=/nonexistent OUT="$W/s3.md" bash "$A/phase-summary/summary.sh"
check "ungated gate row" "grep -q '🔓 ungated' $W/s3.md"
check "missing preview → note" "grep -q 'printed nothing on stdout' $W/s3.md"

MODE=preview PHASE=report APPLY_CMD='' PREVIEW_FILE="$W/preview.md" OUT="$W/s4.md" bash "$A/phase-summary/summary.sh"
check "preview-only gate row" "grep -q 'preview-only — there is no apply step' $W/s4.md"
check "no apply row" "! grep -q '| \`apply\` |' $W/s4.md"

echo "== summary/apply"
printf 'applied 3 objects\n' > "$W/apply.out"; printf '### board\nall green\n' > "$W/post.out"
MODE=apply PHASE=addons TARGET=platform APPLY_CMD='bash scripts/run-phase.sh addons' PREVIEW_FILE="$W/preview.md" \
  APPLY_FILE="$W/apply.out" APPLY_RC=0 POST_FILE="$W/post.out" OUT="$W/s5.md" bash "$A/phase-summary/summary.sh"
check "apply header" "grep -q '^# 🚀 addons · platform — apply' $W/s5.md"
check "approved preview embedded" "grep -q '| a/b | k1, k2 |' $W/s5.md"
check "apply output embedded" "grep -q 'applied 3 objects' $W/s5.md"
check "post output embedded" "grep -q 'all green' $W/s5.md"
head -c 5000 /dev/zero | tr '\0' 'x' > "$W/big.out"
MODE=apply PHASE=addons APPLY_CMD=x PREVIEW_FILE="$W/preview.md" APPLY_FILE="$W/big.out" MAX_BYTES=1000 OUT="$W/s6.md" bash "$A/phase-summary/summary.sh"
check "truncation note" "grep -q 'truncated at 1000 bytes (5000 total)' $W/s6.md"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
