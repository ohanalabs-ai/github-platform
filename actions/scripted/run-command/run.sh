#!/usr/bin/env bash
# Run ONE shell command for the scripted-phase reusable workflow
# (actions/scripted/run-command/action.yaml) — either on the runner, or inside the
# caller's TOOLS IMAGE with `docker run --network host` so the command sees the runner's
# tailnet route + DNS and the cloud credentials the job already holds. The repo checkout
# and $RUNNER_TEMP are mounted at the SAME paths inside the container (like the
# actions/gitops/toolchain shims), so a kubeconfig written to $RUNNER_TEMP by a `setup`
# command is the one a later `preview`/`apply` container reads, and relative paths in the
# command resolve identically inside and outside.
#
# stdout is CAPTURED to $CAPTURE_FILE (and echoed to the log); stderr goes to the log only.
# The convention the reusable workflow builds on: a preview command writes MARKDOWN to
# stdout (that becomes the step summary / the artifact the approver reads) and its chatter
# to stderr. The command's exit code is the step's, unless ALLOW_FAILURE=true.
#
# Environment:
#   COMMAND        the shell command (run with `bash -c`); required
#   TOOLS_IMAGE    e.g. ghcr.io/<org>/<repo>/tools:latest — when set, run inside it; empty → on the runner
#   REGISTRY_TOKEN token to `docker login` the image's registry (ghcr.io: the job's GITHUB_TOKEN)
#   REGISTRY_USER  login user (default github-actions)
#   FORWARD_ENV    space-separated env var NAMES forwarded into the container when SET in the
#                  job env (unset names are skipped, values are never printed) — the cloud
#                  credentials, REGION/STATE_BUCKET/…, VAULT_ADDR/VAULT_TOKEN, KUBECONFIG
#   CAPTURE_FILE   where stdout is captured (default $RUNNER_TEMP/scripted-phase/<TITLE>.out)
#   TITLE          label for the log group and the default capture file name (default command)
#   ALLOW_FAILURE  "true" → a non-zero exit is reported (output `exit-code`) but does not fail the step
#   GITHUB_OUTPUT  written: exit-code, capture-file, lines
set -uo pipefail
: "${COMMAND:?COMMAND is required}"
TITLE="${TITLE:-command}"
TOOLS_IMAGE="${TOOLS_IMAGE:-}"
FORWARD_ENV="${FORWARD_ENV:-}"
CAPTURE_FILE="${CAPTURE_FILE:-${RUNNER_TEMP:-/tmp}/scripted-phase/${TITLE//[^A-Za-z0-9_.-]/_}.out}"
mkdir -p "$(dirname "$CAPTURE_FILE")"
: > "$CAPTURE_FILE"

if [ -n "$TOOLS_IMAGE" ]; then
  reg="${TOOLS_IMAGE%%/*}"
  if [ -n "${REGISTRY_TOKEN:-}" ] && [ ! -f "${RUNNER_TEMP:-/tmp}/scripted-phase/.logged-in-$reg" ]; then
    echo "$REGISTRY_TOKEN" | docker login "$reg" -u "${REGISTRY_USER:-github-actions}" --password-stdin >/dev/null
    touch "${RUNNER_TEMP:-/tmp}/scripted-phase/.logged-in-$reg"
  fi
  if ! docker image inspect "$TOOLS_IMAGE" >/dev/null 2>&1; then
    if ! docker pull -q "$TOOLS_IMAGE" >/dev/null; then
      echo "::error::run-command: cannot pull the tools image $TOOLS_IMAGE" >&2; exit 1
    fi
  fi
  env_args=()
  for v in $FORWARD_ENV; do
    # forward only what is set — `-e NAME` (no value on the command line) reads it from our env
    if [ -n "${!v+x}" ]; then env_args+=(-e "$v"); fi
  done
  echo "run-command: $TITLE → $TOOLS_IMAGE (forwarding: $(printf '%s ' "${env_args[@]}" | sed 's/-e //g'))" >&2
  run() {
    docker run --rm --network host \
      -v "$PWD":"$PWD" -v "${RUNNER_TEMP:-/tmp}":"${RUNNER_TEMP:-/tmp}" -w "$PWD" \
      "${env_args[@]}" "$TOOLS_IMAGE" bash -c "$COMMAND"
  }
else
  echo "run-command: $TITLE → on the runner" >&2
  run() { bash -c "$COMMAND"; }
fi

echo "::group::▶ $TITLE"
run > >(tee "$CAPTURE_FILE"); rc=$?
wait "$!" 2>/dev/null || true
echo "::endgroup::"

lines="$(wc -l <"$CAPTURE_FILE" | tr -d ' ')"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "exit-code=$rc"; echo "capture-file=$CAPTURE_FILE"; echo "lines=$lines"; } >> "$GITHUB_OUTPUT"
fi
echo "run-command: $TITLE exited $rc ($lines line(s) captured → $CAPTURE_FILE)" >&2
if [ "$rc" -ne 0 ] && [ "${ALLOW_FAILURE:-false}" != "true" ]; then exit "$rc"; fi
exit 0
