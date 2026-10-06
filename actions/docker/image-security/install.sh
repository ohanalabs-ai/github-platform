#!/usr/bin/env bash
# Install Trivy and Syft from their GitHub release tarballs, each checked against a sha256 pinned
# in THIS file (pins and approach adopted from ohanalabs-ai/github-platform PR #35's
# actions/images/toolchain/install.sh). Trivy is deliberately NOT installed through
# aquasecurity/trivy-action or setup-trivy: their tags were compromised (GHSA-69fq-xp46-6x23).
set -euo pipefail
BIN_DIR="${BIN_DIR:-$RUNNER_TEMP/image-security-bin}"
TRIVY_VERSION=0.74.0
SYFT_VERSION=1.52.0
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "::error::unsupported arch $(uname -m)"; exit 1 ;; esac
sha() {
  case "$1-$arch" in
    trivy-amd64) echo 2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a ;;
    trivy-arm64) echo b94ce1976bbf3c15b514b605ee88be7c6d94a29be2302847ff01cb794d47aad5 ;;
    syft-amd64)  echo caeedb81fb0491615f1ebd1761e4145d41ee86dd2cc7bf80669f9f5ad9d6133d ;;
    syft-arm64)  echo c46d5e4c28e12aa4c5becfaa343ef1c7f89045b6b895f2c21d471c62db09c706 ;;
  esac
}
verified() { # tool url dest
  curl -sSfL --proto '=https' --tlsv1.2 --retry 3 --retry-all-errors --retry-delay 2 -o "$3" "$2"
  echo "$(sha "$1")  $3" | sha256sum -c --status || { echo "::error::$1 checksum mismatch for $2"; exit 1; }
}
mkdir -p "$BIN_DIR"; work="$(mktemp -d)"
a="$arch"; [ "$arch" = amd64 ] && a=64bit || a=ARM64
verified trivy "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${a}.tar.gz" "$work/trivy.tgz"
tar -xzf "$work/trivy.tgz" -C "$BIN_DIR" trivy
verified syft "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_${arch}.tar.gz" "$work/syft.tgz"
tar -xzf "$work/syft.tgz" -C "$BIN_DIR" syft
echo "$BIN_DIR" >> "$GITHUB_PATH"
"$BIN_DIR/trivy" --version | head -1; "$BIN_DIR/syft" version | grep -E '^Version' || true
