#!/usr/bin/env bash
set -euo pipefail

# Ariadne installer — downloads the latest release binary for the current platform.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/simonrueba/ariadne/main/scripts/install.sh | bash
#
# Options (via env vars):
#   ARIADNE_VERSION   specific version tag (default: latest)
#   ARIADNE_INSTALL   install directory      (default: ~/.local/bin)

REPO="simonrueba/ariadne"
INSTALL_DIR="${ARIADNE_INSTALL:-$HOME/.local/bin}"

# ── Detect platform ──────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)      echo "error: unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)             echo "error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ARTIFACT="ariadne-${PLATFORM}-${ARCH}"

# ── Resolve version ──────────────────────────────────────────────────

if [ -n "${ARIADNE_VERSION:-}" ]; then
  TAG="$ARIADNE_VERSION"
else
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  if [ -z "$TAG" ]; then
    echo "error: could not determine latest release" >&2
    exit 1
  fi
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${ARTIFACT}"

# ── Download and install ─────────────────────────────────────────────

echo "Installing ariadne ${TAG} (${PLATFORM}-${ARCH})..."

mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "${INSTALL_DIR}/ariadne"
chmod +x "${INSTALL_DIR}/ariadne"

# ── Verify ───────────────────────────────────────────────────────────

if "${INSTALL_DIR}/ariadne" status >/dev/null 2>&1 || true; then
  echo "Installed ariadne to ${INSTALL_DIR}/ariadne"
else
  echo "Installed ariadne to ${INSTALL_DIR}/ariadne"
fi

# ── PATH hint ────────────────────────────────────────────────────────

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "Add to your PATH if not already present:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
