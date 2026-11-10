#!/usr/bin/env bash
# Installs dsh-deepwater into a DSH profile.
#
# The package is copied into the profile's node_modules, the profile's
# package.json gains a link to it, and cordis.patch.yml gains the single
# `- insert:` row that mounts it.
#
# After it finishes, restart the desktop app: the desktop app captures its
# index injection at startup, so a running window will not pick up the new
# bundle until it comes back up.
#
#   ./install.sh                       # $DSH_HOME/profiles/desktop
#   ./install.sh /path/to/profile      # a specific profile
#   ./install.sh --uninstall           # take it back out

set -euo pipefail

PROFILE_DIR="${1:-${DSH_HOME:-$HOME/.dsh}/profiles/desktop}"
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNINSTALL=0

if [[ "${1:-}" == "--uninstall" ]]; then
  UNINSTALL=1
  PROFILE_DIR="${2:-${DSH_HOME:-$HOME/.dsh}/profiles/desktop}"
fi

PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
PROFILE_PACKAGE="$PROFILE_DIR/package.json"
MODULE_DIR="$PROFILE_DIR/node_modules/dsh-deepwater"

if [[ ! -f "$PATCH_FILE" ]]; then
  echo "This does not look like a DSH profile: $PATCH_FILE is missing." >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$PROFILE_DIR/.deepwater-backup-$STAMP"
mkdir -p "$BACKUP_DIR"
cp "$PATCH_FILE" "$BACKUP_DIR/cordis.patch.yml"
[[ -f "$PROFILE_PACKAGE" ]] && cp "$PROFILE_PACKAGE" "$BACKUP_DIR/package.json"
echo "==> Backed the profile up to $BACKUP_DIR"

if [[ "$UNINSTALL" == "1" ]]; then
  echo "==> Removing the mount row"
  python3 - "$PATCH_FILE" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
text = re.sub(r'(?ms)^- insert:\r?\n\s*- id: deepwater\r?\n(?:\s+.*\r?\n)*', '', text)
open(path, 'w', encoding='utf-8', newline='').write(text)
PY
  rm -rf "$MODULE_DIR"
  echo "==> Done. Restart the desktop app."
  exit 0
fi

echo "==> Copying the package into the profile"
rm -rf "$MODULE_DIR"
mkdir -p "$MODULE_DIR"
cp -R "$PACKAGE_DIR/src" "$MODULE_DIR/src"
cp -R "$PACKAGE_DIR/verify" "$MODULE_DIR/verify"
for file in client.js cordis.patch.yml entry.js build-client.mjs package.json README.md LICENSE; do
  [[ -f "$PACKAGE_DIR/$file" ]] && cp "$PACKAGE_DIR/$file" "$MODULE_DIR/$file"
done

echo "==> Linking the package into the profile package.json"
if [[ -f "$PROFILE_PACKAGE" ]]; then
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const target = process.argv[2];
    const json = JSON.parse(fs.readFileSync(path, "utf8"));
    json.dependencies = json.dependencies || {};
    json.dependencies["dsh-deepwater"] = "link:" + target;
    fs.writeFileSync(path, JSON.stringify(json, null, 2) + "\n", "utf8");
  ' "$PROFILE_PACKAGE" "$MODULE_DIR"
fi

echo "==> Adding the mount row to cordis.patch.yml"
if ! grep -qE '^\s*- id: deepwater\s*$' "$PATCH_FILE"; then
  cat >> "$PATCH_FILE" <<'YAML'

# dsh-deepwater: the surface and ambience layers, mounted as one row.
# Turn this row off to take the whole frame back down; the client half's
# disposer restores the stock appearance.
- insert:
  - id: deepwater
    name: dsh-deepwater
    config:
      enabled: true
      preset: roomy
      ambience: true
YAML
fi

echo "==> Verifying the package"
( cd "$MODULE_DIR" && node verify/verify-deepwater.mjs )

echo "==> Done. Restart the desktop app so it picks up the new bundle."
