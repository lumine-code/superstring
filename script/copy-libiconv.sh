#!/bin/bash
set -euo pipefail

# Resolve the vendored library's symlink and install a complete copy next to
# the product. Parallel addon and native-test builds can share this target.
src="$1"
dest="$2"
tmp="$(mktemp "${dest}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

cp -L "$src" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$dest"
