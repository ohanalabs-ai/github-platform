#!/usr/bin/env bash
# The image-security toolchain (actions/images/toolchain/action.yaml): put pinned, VERIFIED
# releases of trivy, syft, cosign, gh, oras, kustomize and helm on PATH.
#
# Every download is checked against a sha256 pinned in THIS file (taken from each project's
# official checksum file for that exact release) before it is unpacked. Helm publishes its
# tarballs on get.helm.sh with a detached GPG signature instead: the signature is verified
# against the helm release key with a pinned fingerprint (KEYS fetched from a pinned helm commit;
# the fingerprint, not the download, is the trust anchor). Versions are not caller inputs on
# purpose — a version without its checksum would be an unverified download.
#
# Trivy is installed from its release tarball, NOT through aquasecurity/trivy-action or
# setup-trivy (their tags were compromised — GHSA-69fq-xp46-6x23).
#
# Environment:
#   TOOLS    space-separated subset of: trivy syft cosign gh oras kustomize helm
#   BIN_DIR  destination (default $RUNNER_TEMP/imgsec-bin); prepended to $GITHUB_PATH
set -euo pipefail
TOOLS="${TOOLS:-trivy syft cosign gh oras}"
BIN_DIR="${BIN_DIR:-${RUNNER_TEMP:-/tmp}/imgsec-bin}"
mkdir -p "$BIN_DIR"
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "::error::image toolchain: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
[ "$(uname -s)" = Linux ] || { echo "::error::image toolchain: Linux runners only" >&2; exit 1; }

TRIVY_VERSION=0.74.0
SYFT_VERSION=1.52.0
COSIGN_VERSION=3.1.3
GH_VERSION=2.102.0
ORAS_VERSION=1.3.4
KUSTOMIZE_VERSION=5.8.1
HELM_VERSION=3.22.0
HELM_KEYS_COMMIT=144ca65f8501953fa8b41cd1d37c7223051c85b7
HELM_KEY_FPR=208DD36ED5BB3745A16743A4C7C6FBB5B91C1155

sha() { # tool arch → pinned sha256
  case "$1-$2" in
    trivy-amd64) echo 2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a ;;
    trivy-arm64) echo b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5 ;;
    syft-amd64) echo caeedb81fb0491615f1ebd1761e4145d41ee86dd2cc7bf80669f9f5ad9d6133d ;;
    syft-arm64) echo c46d5e4c28e12aa4c5becfaa343ef1c7f89045b6b895f2c21d471c62db09c706 ;;
    cosign-amd64) echo 4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;;
    cosign-arm64) echo c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;;
    gh-amd64) echo bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;;
    gh-arm64) echo 7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;;
    oras-amd64) echo f27adb935022d94df8dc77719c322dda592c78a0d57a6f7dcdd8d900b248c454 ;;
    oras-arm64) echo 15702c6e3a4a56a8bd8ac5c17efdbcab56d9bada661ccbcf017f5b10c1d89399 ;;
    kustomize-amd64) echo 029a7f0f4e1932c52a0476cf02a0fd855c0bb85694b82c338fc648dcb53a819d ;;
    kustomize-arm64) echo 0953ea3e476f66d6ddfcd911d750f5167b9365aa9491b2326398e289fef2c142 ;;
    *) return 1 ;;
  esac
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() { # url dest
  curl -sSfL --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors --retry-delay 2 -o "$2" "$1" || {
    echo "::error::image toolchain: download failed: $1" >&2; exit 1; }
}

verified() { # tool url dest
  local want
  want=$(sha "$1" "$arch")
  fetch "$2" "$3"
  if ! echo "$want  $3" | sha256sum -c --status; then
    echo "::error::image toolchain: $1 checksum mismatch for $2 (expected $want, got $(sha256sum "$3" | cut -d' ' -f1))" >&2
    rm -f "$3"
    exit 1
  fi
}

for t in $TOOLS; do
  case "$t" in
    trivy)
      a=$([ "$arch" = amd64 ] && echo 64bit || echo ARM64)
      verified trivy "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${a}.tar.gz" "$work/trivy.tgz"
      tar -xzf "$work/trivy.tgz" -C "$BIN_DIR" trivy ;;
    syft)
      verified syft "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_${arch}.tar.gz" "$work/syft.tgz"
      tar -xzf "$work/syft.tgz" -C "$BIN_DIR" syft ;;
    cosign)
      verified cosign "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${arch}" "$work/cosign"
      install -m 0755 "$work/cosign" "$BIN_DIR/cosign" ;;
    gh)
      verified gh "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" "$work/gh.tgz"
      tar -xzf "$work/gh.tgz" -C "$work" "gh_${GH_VERSION}_linux_${arch}/bin/gh"
      install -m 0755 "$work/gh_${GH_VERSION}_linux_${arch}/bin/gh" "$BIN_DIR/gh" ;;
    oras)
      verified oras "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_${arch}.tar.gz" "$work/oras.tgz"
      tar -xzf "$work/oras.tgz" -C "$BIN_DIR" oras ;;
    kustomize)
      verified kustomize "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv${KUSTOMIZE_VERSION}/kustomize_v${KUSTOMIZE_VERSION}_linux_${arch}.tar.gz" "$work/kustomize.tgz"
      tar -xzf "$work/kustomize.tgz" -C "$BIN_DIR" kustomize ;;
    helm)
      command -v gpg >/dev/null || { echo "::error::image toolchain: gpg is required to verify helm" >&2; exit 1; }
      fetch "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${arch}.tar.gz" "$work/helm.tgz"
      fetch "https://github.com/helm/helm/releases/download/v${HELM_VERSION}/helm-v${HELM_VERSION}-linux-${arch}.tar.gz.asc" "$work/helm.tgz.asc"
      fetch "https://raw.githubusercontent.com/helm/helm/${HELM_KEYS_COMMIT}/KEYS" "$work/KEYS"
      export GNUPGHOME="$work/gnupg"
      mkdir -m 0700 "$GNUPGHOME"
      gpg --batch --quiet --import "$work/KEYS" 2>/dev/null
      status=$(gpg --batch --status-fd 1 --verify "$work/helm.tgz.asc" "$work/helm.tgz" 2>/dev/null || true)
      if ! grep -q "^\[GNUPG:\] VALIDSIG ${HELM_KEY_FPR} " <<<"$status"; then
        echo "::error::image toolchain: helm v${HELM_VERSION} tarball is not validly signed by ${HELM_KEY_FPR}" >&2
        exit 1
      fi
      tar -xzf "$work/helm.tgz" -C "$work" "linux-${arch}/helm"
      install -m 0755 "$work/linux-${arch}/helm" "$BIN_DIR/helm"
      echo "helm tarball sha256 (GPG-verified): $(sha256sum "$work/helm.tgz" | cut -d' ' -f1)" ;;
    *) echo "::error::image toolchain: unknown tool '$t'" >&2; exit 1 ;;
  esac
done

python3 -c 'import yaml' 2>/dev/null || {
  echo "::error::image toolchain: python3 with PyYAML is required (preinstalled on GitHub-hosted Ubuntu runners; apt install python3-yaml elsewhere)" >&2
  exit 1; }

echo "$BIN_DIR" >> "${GITHUB_PATH:-/dev/null}"
export PATH="$BIN_DIR:$PATH"
for t in $TOOLS; do
  case "$t" in
    trivy) trivy --version 2>/dev/null | sed -n '1p' ;;
    syft) echo "syft $(syft version 2>/dev/null | awk '/^Version:/{print $2}')" ;;
    cosign) echo "cosign $(cosign version 2>/dev/null | awk '/^GitVersion:/{print $2}')" ;;
    gh) gh --version | sed -n '1p' ;;
    oras) oras version | sed -n '1p' ;;
    kustomize) echo "kustomize $(kustomize version)" ;;
    helm) helm version --short ;;
  esac
done
