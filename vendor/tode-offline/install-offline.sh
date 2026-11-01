#!/bin/bash
# Install tode (terminal-code) with no network access.
#
# The upstream installer in installers/ is used verbatim except for one line:
# the single curl that fetches the release tarball is rewritten into a copy from
# artifacts/. Everything else — the atomic rename, the daemon shutdown, the
# ldd check, the PATH advice — is upstream's own code, so this does not drift
# from what `curl -fsSL https://tode.sh/install | bash` would do.
#
# Their PLATFORMS table is left untouched, which means the sha256 the installer
# checks is still the one upstream published. A corrupted or substituted tarball
# fails there exactly as it would online.
#
# tode additionally needs code-server, which it would otherwise download from
# GitHub on first run (src/src/codeserver/vendored.ts). This script unpacks it
# into the data directory ahead of time so that never happens.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ARTIFACTS="$HERE/artifacts"
INSTALLERS="$HERE/installers"
MANIFEST="$HERE/manifest.txt"
PLUGIN_DIR="$HERE/herdr-plugin"
INSTALLER_SCRIPT=tode-v0.4.3-install.sh

TARGET=""
SEED_CODE_SERVER=yes
LINK_PLUGIN=no

usage() {
  cat <<'USAGE'
usage: install-offline.sh [options]

Installs tode (terminal-code) from the tarballs in artifacts/, together with
the code-server build it would otherwise fetch on first run. Nothing is
downloaded.

options:
  --target <t>         override platform detection: linux-x64, linux-arm64,
                       darwin-x64, darwin-arm64
  --no-code-server     skip seeding code-server (tode will try to download it
                       on first run, which needs network)
  --link-plugin        also register the herdr plugin (herdr plugin link).
                       Without it the command is printed at the end instead.
  --list               show which artifacts are present and verified
  -h, --help           this message

environment passed through to the upstream installer:
  TODE_INSTALL_ROOT=<dir>         install tode somewhere other than
                                  ~/.local/lib/tode
USAGE
}

LIST=no
while [ $# -gt 0 ]; do
  case "$1" in
    tode) ;;               # accepted for symmetry with the old shared script
    --target) TARGET="${2:?--target needs a value}"; shift ;;
    --target=*) TARGET="${1#*=}" ;;
    --no-code-server) SEED_CODE_SERVER=no ;;
    --link-plugin) LINK_PLUGIN=yes ;;
    --list) LIST=yes ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Mirrors the detection in the upstream installer, including the Rosetta case
# where an x86_64 shell on Apple Silicon should still get the arm64 build.
detect_target() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo darwin-arm64 ;;
    Darwin-x86_64)
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
        echo darwin-arm64
      else
        echo darwin-x64
      fi
      ;;
    Linux-x86_64|Linux-amd64) echo linux-x64 ;;
    Linux-aarch64|Linux-arm64) echo linux-arm64 ;;
    *) return 1 ;;
  esac
}

HOST_TARGET="$(detect_target || true)"

if [ -z "$TARGET" ]; then
  if [ -z "$HOST_TARGET" ]; then
    echo "unsupported host: $(uname -s) $(uname -m)" >&2
    echo "tode has no build for it; on Windows install under WSL instead" >&2
    exit 1
  fi
  TARGET="$HOST_TARGET"
fi

# --target picks which artifact to use, but the upstream installer detects the
# platform itself and picks its own PLATFORMS row. If the two disagree the
# install would fail at its checksum check with a confusing message, so stop
# here instead. --target is for inspecting a bundle (--list), not cross-installing.
if [ "$LIST" = no ] && [ -n "$HOST_TARGET" ] && [ "$TARGET" != "$HOST_TARGET" ]; then
  echo "refusing to install $TARGET on a $HOST_TARGET host" >&2
  echo "the upstream installer would still resolve $HOST_TARGET and reject the tarball" >&2
  echo "run this on the target machine, or use --list to inspect the bundle" >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# field <product> <n> -> column n of that product's row for $TARGET
field() {
  awk -v p="$1" -v t="$TARGET" -v n="$2" \
    '$1 == p && $2 == t { print $(n); found = 1 } END { exit !found }' "$MANIFEST"
}

have_product() { field "$1" 1 >/dev/null 2>&1; }

# Checks the artifact exists and matches the sha256 recorded in the manifest.
# Done before touching anything on disk so a bad bundle stops early.
#
# Only the resolved path goes to stdout, so callers can capture it; all progress
# and error text goes to stderr.
verify() {
  local product="$1" file sha path got
  file="$(field "$product" 4)"
  sha="$(field "$product" 5)"
  path="$ARTIFACTS/$file"
  if [ ! -f "$path" ]; then
    echo "missing artifact: $path" >&2
    echo "the bundle does not carry $product for $TARGET" >&2
    return 1
  fi
  printf 'verifying %s ... ' "$file" >&2
  got="$(sha256_of "$path")"
  if [ "$got" != "$sha" ]; then
    printf 'FAILED\n' >&2
    echo "  expected $sha" >&2
    echo "  got      $got" >&2
    return 1
  fi
  printf 'ok\n' >&2
  printf '%s' "$path"
}

if [ "$LIST" = yes ]; then
  echo "target: $TARGET"
  for p in tode code-server; do
    if have_product "$p"; then
      printf '  %-13s %-9s ' "$p" "$(field "$p" 3)"
      if verify "$p" >/dev/null 2>&1; then echo "verified"; else echo "PROBLEM"; fi
    else
      printf '  %-13s %s\n' "$p" "not in bundle for $TARGET"
    fi
  done
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Rewrites the one downloading line into a copy. The match is asserted to hit
# exactly once: if upstream reshapes that line, this fails loudly rather than
# quietly leaving a curl in place that would reach for the network.
patch_installer() {
  local src="$1" out="$2" hits
  hits="$(grep -c '^curl -fL --retry 3 --retry-delay 2 --progress-bar' "$src" || true)"
  if [ "$hits" != 1 ]; then
    echo "expected exactly 1 download line in $(basename "$src"), found $hits" >&2
    echo "the vendored installer changed shape — re-check it before trusting this script" >&2
    exit 1
  fi
  sed 's|^curl -fL --retry 3 --retry-delay 2 --progress-bar.*|cp -- "$OFFLINE_TARBALL" "$TARBALL"|' \
    "$src" > "$out"
  # Nothing network-capable may survive outside the PLATFORMS table (lines 1-10).
  if tail -n +11 "$out" | grep -qE '(^|[^-[:alnum:]])(curl|wget)([^-[:alnum:]]|$)'; then
    echo "a curl/wget remains in the patched $(basename "$src"):" >&2
    tail -n +11 "$out" | grep -nE '(^|[^-[:alnum:]])(curl|wget)([^-[:alnum:]]|$)' >&2
    exit 1
  fi
}

run_installer() {
  local product="$1" script="$2" tarball patched
  tarball="$(verify "$product")"
  patched="$TMP/$product-install.sh"
  patch_installer "$INSTALLERS/$script" "$patched"
  echo "installing $product $(field "$product" 3) ($TARGET) from the bundle"
  OFFLINE_TARBALL="$tarball" bash "$patched"
}

# code-server goes where tode looks for it: DATA_DIR/code-server/<version>,
# with the binary at bin/code-server. Unpacked beside the target and renamed
# into place, the same way tode's own fetch does it.
seed_code_server() {
  local tarball version root staging
  tarball="$(verify code-server)"
  version="$(field code-server 3)"
  root="${XDG_DATA_HOME:-$HOME/.local/share}/tode/code-server/$version"

  if [ -x "$root/bin/code-server" ]; then
    echo "code-server $version already in place at $root"
    return 0
  fi

  echo "unpacking code-server $version -> $root"
  staging="$root.unpacking"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$tarball" -C "$staging" --strip-components 1
  if [ ! -x "$staging/bin/code-server" ]; then
    echo "unpacked code-server but bin/code-server is missing or not executable" >&2
    rm -rf "$staging"
    exit 1
  fi
  rm -rf "$root"
  mkdir -p "$(dirname "$root")"
  mv "$staging" "$root"
}

if [ "$SEED_CODE_SERVER" = yes ]; then seed_code_server; fi
run_installer tode "$INSTALLER_SCRIPT"

echo
echo "done — installed offline, nothing was downloaded"
if [ "$SEED_CODE_SERVER" = no ]; then
  echo "note: code-server was not seeded, so tode's first run will need network"
fi

# The herdr plugin is a separate step: `herdr plugin link` registers the
# directory as-is and never runs the manifest's [[build]], which is why the
# binary had to go in first.
if [ "$LINK_PLUGIN" = yes ]; then
  if ! command -v herdr >/dev/null 2>&1; then
    echo "herdr is not on PATH — skipping the plugin link" >&2
    exit 0
  fi
  echo
  echo "linking the herdr plugin from $PLUGIN_DIR"
  herdr plugin link "$PLUGIN_DIR"
elif command -v herdr >/dev/null 2>&1; then
  echo
  echo "to add the herdr plugin (no network, nothing downloaded):"
  echo "  herdr plugin link \"$PLUGIN_DIR\""
fi
