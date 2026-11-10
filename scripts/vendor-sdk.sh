#!/usr/bin/env bash
# Copies the Supertext TypeScript SDK's sources into src/vendor/supertext-sdk, where the
# plugin's own TypeScript build compiles them into dist/ with the rest of the plugin, so
# sites install nothing besides the plugin.
# Source: https://github.com/Supertext/Supertext-API-SDK-Guide (sdk/typescript/src).
#
#   scripts/vendor-sdk.sh [commit-or-branch]        (default: main)
#   SDK_DIR=/path/to/clone scripts/vendor-sdk.sh    (use a local clone as it is)
#
# Import the API from src/vendor/supertext-sdk/v1/index.js (the SDK's `supertext-sdk/v1`).
set -euo pipefail
ref="${1:-main}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -n "${SDK_DIR:-}" ]; then
  src="$(cd "$SDK_DIR" && pwd)"
else
  git clone -q https://github.com/Supertext/Supertext-API-SDK-Guide "$work/sdk"
  git -C "$work/sdk" checkout -q "$ref"
  src="$work/sdk"
fi
commit="$(git -C "$src" rev-parse HEAD)"
version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$src/sdk/typescript/package.json" | head -1)"
dest="$root/src/vendor/supertext-sdk"
rm -rf "$dest"
mkdir -p "$dest"
# The SDK keeps the API in versioned folders (src/v1/...): copy the whole source tree.
cp -R "$src"/sdk/typescript/src/. "$dest/"
cp "$src/sdk/typescript/LICENSE" "$dest/LICENSE"
printf '%s\n' "$commit" > "$dest/COMMIT"
printf '%s\n' "$version" > "$dest/VERSION"
cat > "$dest/README.md" <<EOT
# Supertext SDK (bundled copy)

TypeScript part of the [Supertext SDK](https://github.com/Supertext/Supertext-API-SDK-Guide),
version $version, commit \`$commit\`, compiled with the plugin.

Don't edit these files: fix the SDK in its own repository, then run \`scripts/vendor-sdk.sh\`.
EOT
echo "src/vendor/supertext-sdk: Supertext SDK (TypeScript) $version from commit $commit"
