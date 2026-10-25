#!/usr/bin/env bash
# Clone, patch and build the Obscura engine with disk-backed IndexedDB.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/obscura"
PATCH="$ROOT/patches/obscura/0001-disk-backed-indexeddb.patch"
UPSTREAM="https://github.com/h4ckf0r0day/obscura"
REV="8b3dd47"

if [[ ! -d "$VENDOR/.git" ]]; then
  mkdir -p "$ROOT/vendor"
  git clone "$UPSTREAM" "$VENDOR"
  git -C "$VENDOR" checkout "$REV"
fi

if git -C "$VENDOR" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "patch already applied"
else
  git -C "$VENDOR" apply "$PATCH"
  echo "applied $(basename "$PATCH")"
fi

(
  cd "$VENDOR"
  cargo build --release -p obscura-cli --bins --features render
)

echo
echo "OBSCURA_BIN=$VENDOR/target/release/obscura"
