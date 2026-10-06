#!/usr/bin/env bash
# Copa (project-copacetic) OS-package patch of ONE built image, then a re-scan of the result.
# Copa only patches OS packages (apk/apt/rpm) inside the image from a Trivy OS report — it never
# touches the Dockerfile or language dependencies (those are Dependabot's / the synchronizer's
# commit). Never fails the job: the outcome is recorded in copa-result.json and the decision is
# made by `sync.py decide`.
#
# env: IMAGE (repo@sha256:… or repo:tag), SERVICE, BUILDKIT_ADDR, OUT_DIR
set -uo pipefail
out="${OUT_DIR:-pr-security-sync}/copa/${SERVICE}"; mkdir -p "$out"
result() { # status [patched] [after-json]
  jq -n --arg service "$SERVICE" --arg image "$IMAGE" --arg status "$1" --arg patched "${2:-}" \
        --argjson after "${3:-null}" '{service:$service, image:$image, status:$status, patched:$patched, after:$after}' \
        > "$out/copa-result.json"
  echo "copa $SERVICE: $1 ${2:-}"
  exit 0
}
repo="${IMAGE%@*}"; repo="${repo%:*}"
[[ "$IMAGE" == *@sha256:* ]] && repo="${IMAGE%@*}"
digest="$(docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest}}' | jq -r .digest)" \
  || result "error: cannot resolve $IMAGE"
short="${digest#sha256:}"; short="${short:0:12}"
src="$repo:src-$short"; patched_tag="src-$short-patched"
# Copa reads the image through BuildKit by tag: give the exact digest a tag first.
docker buildx imagetools create -t "$src" "$repo@$digest" >/dev/null 2>"$out/tag.log" \
  || result "error: cannot tag $repo@$digest ($(tail -1 "$out/tag.log"))"
trivy image --quiet --pkg-types os --ignore-unfixed --format json --output "$out/os.json" "$src" \
  || result "error: trivy OS scan failed"
n="$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$out/os.json")"
[ "$n" -gt 0 ] || result "nothing to patch (no fixable OS vulnerability)"
if ! copa patch --image "$src" --report "$out/os.json" --tag "$patched_tag" \
       --addr "$BUILDKIT_ADDR" --timeout 15m > "$out/copa.log" 2>&1; then
  result "copa failed: $(grep -iE 'error|unsupported|EOL|not found' "$out/copa.log" | tail -1 | cut -c1-160)"
fi
docker push --quiet "$repo:$patched_tag" >/dev/null 2>"$out/push.log" \
  || result "error: push failed ($(tail -1 "$out/push.log"))" "$repo:$patched_tag"
trivy image --quiet --scanners vuln --format json --output "$out/after.json" "$repo:$patched_tag" \
  || result "patched; re-scan failed" "$repo:$patched_tag"
after="$(jq -c '[.Results[]?.Vulnerabilities[]?.Severity] | {CRITICAL: map(select(.=="CRITICAL"))|length,
          HIGH: map(select(.=="HIGH"))|length, MEDIUM: map(select(.=="MEDIUM"))|length, LOW: map(select(.=="LOW"))|length}' "$out/after.json")"
result "patched" "$repo:$patched_tag" "$after"
