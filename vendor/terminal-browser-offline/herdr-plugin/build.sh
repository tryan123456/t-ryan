#!/usr/bin/env bash
# What upstream's [[build]] does with `curl … | bash`, done from the bundle.
#
# herdr runs [[build]] when it installs a plugin from GitHub; `herdr plugin
# link` — the route this bundle uses — does not. Either way this must never
# reach the network, so it hands off to the bundle's offline installer.
# Re-running it is safe: the installer unpacks beside the target and renames.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALLER="$HERE/../install-offline.sh"

if [ ! -f "$INSTALLER" ]; then
  echo "offline installer not found at $INSTALLER" >&2
  echo "this plugin directory only works from inside the terminal-browser-offline bundle" >&2
  exit 1
fi

exec bash "$INSTALLER"
