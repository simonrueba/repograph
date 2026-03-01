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
  # Use the releases/latest redirect to get the tag without parsing JSON.
  # Falls back to API + grep if the redirect doesn't work.
  TAG=$(curl -fsSI "https://github.com/${REPO}/releases/latest" 2>/dev/null \
    | grep -i '^location:' | head -1 | sed 's|.*/tag/||; s/[[:space:]]//g')
  if [ -z "$TAG" ]; then
    TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  fi
  if [ -z "$TAG" ]; then
    echo "error: could not determine latest release." >&2
    echo "  Check https://github.com/${REPO}/releases or set ARIADNE_VERSION manually." >&2
    exit 1
  fi
fi

BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

# ── Download ─────────────────────────────────────────────────────────

echo "Installing ariadne ${TAG} (${PLATFORM}-${ARCH})..."

TMPDIR_INSTALL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

curl -fsSL "${BASE_URL}/${ARTIFACT}" -o "${TMPDIR_INSTALL}/${ARTIFACT}"
curl -fsSL "${BASE_URL}/SHA256SUMS"  -o "${TMPDIR_INSTALL}/SHA256SUMS"

# ── Verify checksum ──────────────────────────────────────────────────

EXPECTED=$(grep "${ARTIFACT}$" "${TMPDIR_INSTALL}/SHA256SUMS" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "warning: ${ARTIFACT} not found in SHA256SUMS, skipping verification" >&2
else
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "${TMPDIR_INSTALL}/${ARTIFACT}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "${TMPDIR_INSTALL}/${ARTIFACT}" | awk '{print $1}')
  else
    echo "warning: no sha256sum or shasum found, skipping verification" >&2
    ACTUAL="$EXPECTED"
  fi
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "error: checksum mismatch for ${ARTIFACT}" >&2
    echo "  expected: ${EXPECTED}" >&2
    echo "  got:      ${ACTUAL}" >&2
    exit 1
  fi
  echo "Checksum verified."
fi

# ── Install ──────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
mv "${TMPDIR_INSTALL}/${ARTIFACT}" "${INSTALL_DIR}/ariadne"
chmod +x "${INSTALL_DIR}/ariadne"

echo "Installed ariadne ${TAG} to ${INSTALL_DIR}/ariadne"

# ── PATH hint ────────────────────────────────────────────────────────

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "Add to your PATH if not already present:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
