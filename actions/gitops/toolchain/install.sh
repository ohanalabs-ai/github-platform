#!/usr/bin/env bash
# The GitOps toolchain (actions/gitops/toolchain/action.yaml): put kustomize, helm, argocd,
# kubectl and yq on PATH — either from pinned GitHub releases, or as thin shims that run
# the caller's own TOOLS image (`docker run … <image> <tool>`), so every script downstream
# just calls `kustomize`, `helm`, `argocd`, `kubectl` and never knows which.
#
# Why shims and not `docker run` in the scripts: a repo that ships a tools image wants the
# SAME kustomize/helm its deploy uses (an add-on that builds here builds in the deploy and
# in ArgoCD's repo-server); a repo without one wants pinned releases. One script, two
# toolchains. The shims mount the runner's work dir, its temp dir and /tmp at the same paths
# inside the container and run with the caller's cwd, so absolute paths, `cd <tree> &&
# kustomize build <path>`, a CMP script that copies the checkout to /tmp, a kubeconfig in
# $RUNNER_TEMP — all resolve identically inside and outside. `--network host` for argocd/
# kubectl over the tailnet.
#
# yq is always a native binary (the object split runs `yq -i` per rendered object —
# hundreds of `docker run`s would be slow) and jq comes with the runner.
#
# Environment:
#   TOOLS_IMAGE     e.g. ghcr.io/<org>/<repo>/tools:latest — when set, shims; when empty, releases
#   REGISTRY_TOKEN  token to `docker login` the image's registry (ghcr.io: the job's GITHUB_TOKEN)
#   REGISTRY_USER   login user (default: github-actions)
#   TOOLS           space-separated subset to provide (default: kustomize helm argocd kubectl)
#   KUSTOMIZE_VERSION HELM_VERSION ARGOCD_VERSION KUBECTL_VERSION YQ_VERSION   release pins
#   BIN_DIR         where binaries/shims go (default $RUNNER_TEMP/gitops-bin); prepended to $GITHUB_PATH
set -euo pipefail
TOOLS_IMAGE="${TOOLS_IMAGE:-}"; TOOLS="${TOOLS:-kustomize helm argocd kubectl}"
BIN_DIR="${BIN_DIR:-${RUNNER_TEMP:-/tmp}/gitops-bin}"; mkdir -p "$BIN_DIR"
arch=$(uname -m); case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
os=$(uname -s | tr '[:upper:]' '[:lower:]')

# helm state under $RUNNER_TEMP (shared by binaries and shims; the CMP script honours HELM_*_HOME)
helm_home="${RUNNER_TEMP:-/tmp}/gitops-helm"; mkdir -p "$helm_home/cache" "$helm_home/config" "$helm_home/data"
{
  echo "HELM_CACHE_HOME=$helm_home/cache"; echo "HELM_CONFIG_HOME=$helm_home/config"; echo "HELM_DATA_HOME=$helm_home/data"
} >> "${GITHUB_ENV:-/dev/null}"
export HELM_CACHE_HOME="$helm_home/cache" HELM_CONFIG_HOME="$helm_home/config" HELM_DATA_HOME="$helm_home/data"

# yq — always native
if [ -n "${YQ_VERSION:-}" ]; then
  curl -sSfL -o "$BIN_DIR/yq" "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_${os}_${arch}" && chmod +x "$BIN_DIR/yq"
fi

if [ -n "$TOOLS_IMAGE" ]; then
  reg="${TOOLS_IMAGE%%/*}"
  if [ -n "${REGISTRY_TOKEN:-}" ]; then echo "$REGISTRY_TOKEN" | docker login "$reg" -u "${REGISTRY_USER:-github-actions}" --password-stdin >/dev/null; fi
  docker pull -q "$TOOLS_IMAGE"
  for t in $TOOLS; do
    cat > "$BIN_DIR/$t" <<EOF
#!/usr/bin/env bash
# shim → $TOOLS_IMAGE $t (actions/gitops/toolchain)
exec docker run --rm --network host \\
  -v "\${RUNNER_WORKSPACE:-\$PWD}":"\${RUNNER_WORKSPACE:-\$PWD}" -v "\${RUNNER_TEMP:-/tmp}":"\${RUNNER_TEMP:-/tmp}" -v /tmp:/tmp \\
  -w "\$PWD" -e HOME=/tmp/gitops-home \\
  -e ARGOCD_SERVER -e ARGOCD_AUTH_TOKEN -e ARGOCD_OPTS -e KUBECONFIG \\
  -e HELM_CACHE_HOME -e HELM_CONFIG_HOME -e HELM_DATA_HOME -e HELM_REGISTRY_CONFIG -e HELM_REPOSITORY_CACHE -e HELM_REPOSITORY_CONFIG \\
  "$TOOLS_IMAGE" $t "\$@"
EOF
    chmod +x "$BIN_DIR/$t"
  done
  echo "toolchain: shims for [$TOOLS] → $TOOLS_IMAGE"
else
  for t in $TOOLS; do
    case "$t" in
      kustomize) curl -sSfL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION:?}/kustomize_v${KUSTOMIZE_VERSION}_${os}_${arch}.tar.gz" | tar xz -C "$BIN_DIR" kustomize ;;
      helm) curl -sSfL "https://get.helm.sh/helm-v${HELM_VERSION:?}-${os}-${arch}.tar.gz" | tar xz -C "$BIN_DIR" --strip-components=1 "${os}-${arch}/helm" ;;
      argocd) curl -sSfL -o "$BIN_DIR/argocd" "https://github.com/argoproj/argo-cd/releases/download/v${ARGOCD_VERSION:?}/argocd-${os}-${arch}" && chmod +x "$BIN_DIR/argocd" ;;
      kubectl) curl -sSfL -o "$BIN_DIR/kubectl" "https://dl.k8s.io/release/v${KUBECTL_VERSION:?}/bin/${os}/${arch}/kubectl" && chmod +x "$BIN_DIR/kubectl" ;;
      *) echo "::warning::unknown tool '$t' requested from the toolchain" ;;
    esac
  done
  echo "toolchain: pinned releases for [$TOOLS]"
fi
echo "$BIN_DIR" >> "${GITHUB_PATH:-/dev/null}"
export PATH="$BIN_DIR:$PATH"
for t in $TOOLS yq; do
  command -v "$t" >/dev/null 2>&1 || continue
  case "$t" in
    kustomize) kustomize version 2>/dev/null | head -1 ;; helm) helm version --short 2>/dev/null ;; argocd) argocd version --client --short 2>/dev/null ;;
    kubectl) kubectl version --client 2>/dev/null | head -1 ;; yq) yq --version ;;
  esac
done
