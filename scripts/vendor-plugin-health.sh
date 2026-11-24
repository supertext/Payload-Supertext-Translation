#!/usr/bin/env bash
# Copies the sources of Supertext Plugin Health (TypeScript) into src/vendor/supertext-plugin-health,
# next to the Supertext SDK's, where the plugin's own TypeScript build compiles them into dist/
# with the rest of the plugin, so sites install nothing besides the plugin.
# Source: https://github.com/Supertext/Commando-Center-Supertext-Translation (plugin-health/typescript/src).
#
#   scripts/vendor-plugin-health.sh [commit-or-branch]                  (default: main; tags: plugin-health-vX.Y.Z)
#   PLUGIN_HEALTH_DIR=/path/to/clone scripts/vendor-plugin-health.sh    (use a local clone as it is)
#
# Import it from src/vendor/supertext-plugin-health/index.js (the package `supertext-plugin-health`).
set -euo pipefail
ref="${1:-main}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -n "${PLUGIN_HEALTH_DIR:-}" ]; then
  src="$(cd "$PLUGIN_HEALTH_DIR" && pwd)"
else
  git clone -q https://github.com/Supertext/Commando-Center-Supertext-Translation "$work/center"
  git -C "$work/center" checkout -q "$ref"
  src="$work/center"
fi
commit="$(git -C "$src" rev-parse HEAD)"
version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$src/plugin-health/typescript/package.json" | head -1)"
dest="$root/src/vendor/supertext-plugin-health"
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$src"/plugin-health/typescript/src/. "$dest/"
# Plugin Health 0.4+ reads the dashboard address from config.json with an import attribute
# (`import config from './config.json' with { type: 'json' }`), which not every tsconfig or bundler
# accepts: the copy gets the same values as a constant instead.
if [ -f "$src/plugin-health/typescript/src/config.json" ]; then
  node -e '
    const fs = require("fs");
    const [index, json] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(json, "utf8"));
    const line = "import config from \x27./config.json\x27 with { type: \x27json\x27 }";
    const source = fs.readFileSync(index, "utf8");
    if (!source.includes(line)) { console.error("config.json import not found in " + index); process.exit(1); }
    fs.writeFileSync(index, source.replace(line, "// Inlined from config.json by scripts/vendor-plugin-health.sh.\nconst config = " + JSON.stringify(config) + " as const"));
  ' "$dest/index.ts" "$src/plugin-health/typescript/src/config.json"
fi
cp "$src/plugin-health/typescript/LICENSE" "$dest/LICENSE"
printf '%s\n' "$commit" > "$dest/COMMIT"
printf '%s\n' "$version" > "$dest/VERSION"
cat > "$dest/README.md" <<EOT
# Supertext Plugin Health (bundled copy)

TypeScript part of [Supertext Plugin Health](https://github.com/Supertext/Commando-Center-Supertext-Translation/tree/main/plugin-health),
version $version, commit \`$commit\`, compiled with the plugin.

Don't edit these files: fix it in Commando-Center-Supertext-Translation/plugin-health, then run \`scripts/vendor-plugin-health.sh\`.
EOT
echo "src/vendor/supertext-plugin-health: Supertext Plugin Health (TypeScript) $version from commit $commit"
