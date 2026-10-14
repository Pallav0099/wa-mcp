#!/bin/sh
# WA Bridge installer: WhatsApp for your AI agents.
#
#   curl -fsSL https://github.com/xrig-io/wa-bridge/releases/latest/download/install.sh | sh
#
# Installs wa-bridge for the current user (no sudo) into ~/.wa-bridge and links `wa-bridge` (and `wa`, when that
# name is free) into ~/.local/bin. It does not link WhatsApp, start a service or touch your agents: `wa connect`
# does that, with your consent, afterwards. Re-running it upgrades or repairs an install.
#
# Nothing downloaded is run before it is verified:
#   1. Node's tarball must match nodejs.org's SHASUMS256.txt AND this release's SHA256SUMS
#   2. that Node checks the Ed25519 signature of SHA256SUMS against PUBKEY below
#   3. the wa-bridge tarball must match SHA256SUMS
#
# Options / environment:
#   --version X.Y.Z   (WA_BRIDGE_VERSION)         a specific release instead of the latest
#   --no-modify-path  (WA_BRIDGE_NO_MODIFY_PATH=1) do not add ~/.local/bin to your shell's PATH
#   --allow-root                                   install for root (not recommended)
#   WA_BRIDGE_INSTALL  install root   (default: ~/.wa-bridge)
#   WA_BRIDGE_HOME     data directory (default: $XDG_DATA_HOME/wa-bridge, i.e. ~/.local/share/wa-bridge)
#   WA_BRIDGE_REPO, WA_BRIDGE_DOWNLOAD_URL, WA_BRIDGE_NODE_MIRROR   other download locations (mirrors, tests)

PUBKEY='hjEXz90rJ8GyNNoCePO3a9Usd4xGcKMxDRkZOKo71EU='
REPO_DEFAULT='xrig-io/wa-bridge'

say() { printf '%s\n' "$*"; }
warn() { printf 'wa-bridge install: %s\n' "$*" >&2; }
die() { printf 'wa-bridge install: error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# single-quote for embedding in a generated shell script
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

fetch() {
  if have curl; then
    curl --proto '=https,http' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1" || die "download failed: $1"
  else
    wget -q -O "$2" "$1" || die "download failed: $1"
  fi
}

sha256() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# sha256 listed for file $1 in sums file $2
sum_of() { awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$2"; }

VERIFY_JS='
const [k, file, sigFile] = process.argv.slice(1);
const c = require("crypto"), fs = require("fs");
const key = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(k, "base64")]), format: "der", type: "spki" });
const sig = Buffer.from(fs.readFileSync(sigFile, "utf8").trim(), "base64");
process.exit(sig.length === 64 && c.verify(null, fs.readFileSync(file), key, sig) ? 0 : 1);
'

add_path_line() { # file
  [ -f "$1" ] && grep -q '# >>> wa-bridge >>>' "$1" && return 0
  {
    printf '\n# >>> wa-bridge >>>\n'
    printf 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n'
    printf '# <<< wa-bridge <<<\n'
  } >> "$1"
  PATH_FILES="$PATH_FILES $1"
}

link_alias() { # name -> 0 linked, 1 skipped
  target="$BIN_DIR/$1"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$ROOT/bin/wa-bridge" ]; then return 0; fi
  if [ -e "$target" ] || [ -L "$target" ]; then warn "$target already exists and is not wa-bridge; leaving it alone"; return 1; fi
  other=$(command -v "$1" 2>/dev/null || true)
  if [ -n "$other" ]; then warn "\`$1\` is already a command on this system ($other); use \`wa-bridge\` instead"; return 1; fi
  ln -s "$ROOT/bin/wa-bridge" "$target"
}

main() {
  set -eu
  VERSION=${WA_BRIDGE_VERSION:-}
  MODIFY_PATH=1
  [ "${WA_BRIDGE_NO_MODIFY_PATH:-0}" = 1 ] && MODIFY_PATH=0
  ALLOW_ROOT=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION=$2; shift ;;
      --version=*) VERSION=${1#--version=} ;;
      --no-modify-path) MODIFY_PATH=0 ;;
      --allow-root) ALLOW_ROOT=1 ;;
      -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
  VERSION=${VERSION#v}

  # ------------------------------------------------------------ this machine
  [ "$(uname -s)" = Linux ] || die "wa-bridge currently supports Linux only (this is $(uname -s))"
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported CPU $(uname -m): x86_64 and aarch64 are supported" ;;
  esac
  if ldd --version 2>&1 | grep -qi musl; then
    die "musl libc (Alpine and similar) is not supported: the Node runtime needs glibc 2.28 or newer"
  fi
  GLIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }')
  [ -n "$GLIBC" ] || die "cannot determine the glibc version; glibc 2.28 or newer is required"
  gmaj=${GLIBC%%.*}; gmin=${GLIBC#*.}; gmin=${gmin%%.*}
  if [ "$gmaj" -lt 2 ] || { [ "$gmaj" -eq 2 ] && [ "$gmin" -lt 28 ]; }; then die "glibc $GLIBC is too old: 2.28 or newer is required"; fi
  if [ "$(id -u)" = 0 ] && [ "$ALLOW_ROOT" != 1 ]; then
    die "run this as your normal user, not root: wa-bridge installs per user (override: --allow-root)"
  fi
  [ -n "${HOME:-}" ] || die "HOME is not set"
  for t in tar gzip mktemp awk sed grep; do have "$t" || die "required tool not found: $t"; done
  have curl || have wget || die "curl or wget is required"
  have sha256sum || have shasum || die "sha256sum is required"

  ROOT=${WA_BRIDGE_INSTALL:-$HOME/.wa-bridge}
  DATA=${WA_BRIDGE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/wa-bridge}
  BIN_DIR=$HOME/.local/bin
  REPO=${WA_BRIDGE_REPO:-$REPO_DEFAULT}
  if [ -n "${WA_BRIDGE_DOWNLOAD_URL:-}" ]; then URL=${WA_BRIDGE_DOWNLOAD_URL%/}
  elif [ -n "$VERSION" ]; then URL="https://github.com/$REPO/releases/download/v$VERSION"
  else URL="https://github.com/$REPO/releases/latest/download"; fi
  NODE_MIRROR=${WA_BRIDGE_NODE_MIRROR:-https://nodejs.org/dist}
  NODE_MIRROR=${NODE_MIRROR%/}

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/wa-bridge-install.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT
  trap 'rm -rf "$TMP"; exit 130' INT TERM

  # ------------------------------------------------------------ what to install
  say "wa-bridge: reading the release at $URL"
  fetch "$URL/SHA256SUMS" "$TMP/SHA256SUMS"
  fetch "$URL/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig"
  APP=$(awk '{ print $2 }' "$TMP/SHA256SUMS" | sed 's/^\*//' | grep -E "^wa-bridge-[0-9][0-9A-Za-z.-]*-linux-$ARCH\.tar\.gz\$" | head -n 1 || true)
  [ -n "$APP" ] || die "this release has no build for linux-$ARCH"
  NODEF=$(awk '{ print $2 }' "$TMP/SHA256SUMS" | sed 's/^\*//' | grep -E "^node-v[0-9]+\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.gz\$" | head -n 1 || true)
  [ -n "$NODEF" ] || die "this release does not name its Node runtime"
  VER=${APP#wa-bridge-}; VER=${VER%-linux-$ARCH.tar.gz}
  NODEVER=${NODEF#node-}; NODEVER=${NODEVER%-linux-$ARCH.tar.gz}
  if [ -n "$VERSION" ] && [ "$VERSION" != "$VER" ]; then die "asked for $VERSION but the release is $VER"; fi

  # ------------------------------------------------------------ 1. Node, checked against nodejs.org
  NODE="$ROOT/node/$NODEVER/bin/node"
  if [ -x "$NODE" ] && [ "$("$NODE" --version 2>/dev/null)" = "$NODEVER" ]; then
    NEW_NODE=""
    CHECK_NODE=$NODE
  else
    say "wa-bridge: downloading Node $NODEVER (linux-$ARCH)"
    fetch "$NODE_MIRROR/$NODEVER/$NODEF" "$TMP/$NODEF"
    fetch "$NODE_MIRROR/$NODEVER/SHASUMS256.txt" "$TMP/NODE-SHASUMS256.txt"
    got=$(sha256 "$TMP/$NODEF")
    [ "$got" = "$(sum_of "$NODEF" "$TMP/NODE-SHASUMS256.txt")" ] || die "the Node tarball does not match nodejs.org's SHASUMS256.txt"
    [ "$got" = "$(sum_of "$NODEF" "$TMP/SHA256SUMS")" ] || die "the Node tarball does not match the wa-bridge release"
    ndir=${NODEF%.tar.gz}
    tar -xzf "$TMP/$NODEF" -C "$TMP" "$ndir/bin/node" "$ndir/LICENSE"
    NEW_NODE="$TMP/$ndir"
    CHECK_NODE="$NEW_NODE/bin/node"
  fi

  # ------------------------------------------------------------ 2. the release signature
  "$CHECK_NODE" -e "$VERIFY_JS" "$PUBKEY" "$TMP/SHA256SUMS" "$TMP/SHA256SUMS.sig" \
    || die "the release signature is not valid (SHA256SUMS.sig); nothing was installed"

  # ------------------------------------------------------------ 3. wa-bridge itself
  say "wa-bridge: downloading wa-bridge $VER (linux-$ARCH)"
  fetch "$URL/$APP" "$TMP/$APP"
  [ "$(sha256 "$TMP/$APP")" = "$(sum_of "$APP" "$TMP/SHA256SUMS")" ] || die "the wa-bridge tarball does not match SHA256SUMS"

  umask 022
  mkdir -p "$ROOT/bin" "$ROOT/versions" "$ROOT/node"
  if [ -n "$NEW_NODE" ]; then
    mkdir -p "$ROOT/node/$NODEVER/bin"
    mv -f "$NEW_NODE/bin/node" "$ROOT/node/$NODEVER/bin/node"
    mv -f "$NEW_NODE/LICENSE" "$ROOT/node/$NODEVER/LICENSE"
  fi
  STAGE="$ROOT/versions/.$VER.installing"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  tar -xzf "$TMP/$APP" -C "$STAGE" --strip-components=1
  [ "$(cat "$STAGE/NODE_VERSION")" = "$NODEVER" ] || die "the tarball expects a different Node version"
  "$NODE" --disable-warning=ExperimentalWarning "$STAGE/bin/wa.mjs" version >/dev/null 2>&1 \
    || die "wa-bridge $VER does not start on this machine; nothing was switched"
  if [ -d "$ROOT/versions/$VER" ]; then rm -rf "$ROOT/versions/.$VER.old"; mv "$ROOT/versions/$VER" "$ROOT/versions/.$VER.old"; fi
  mv "$STAGE" "$ROOT/versions/$VER"
  rm -rf "$ROOT/versions/.$VER.old"

  # the version we replace becomes `previous` (for `wa update --rollback`)
  if [ -L "$ROOT/current" ] && [ "$(readlink "$ROOT/current")" != "versions/$VER" ]; then
    ln -sfn "$(readlink "$ROOT/current")" "$ROOT/.previous.tmp" && mv -fT "$ROOT/.previous.tmp" "$ROOT/previous" 2>/dev/null || true
  fi
  ln -sfn "versions/$VER" "$ROOT/.current.tmp"
  mv -fT "$ROOT/.current.tmp" "$ROOT/current" 2>/dev/null || { rm -rf "$ROOT/current"; mv -f "$ROOT/.current.tmp" "$ROOT/current"; }

  cat > "$ROOT/bin/.wa-bridge.tmp" <<EOF
#!/bin/sh
# wa-bridge launcher, written by install.sh. Re-run the installer instead of editing this file.
# The data directory is fixed here so the shell, the systemd service and every agent use the same one.
WA_BRIDGE_LAUNCHER=$(sq "$ROOT/bin/wa-bridge")
WA_BRIDGE_HOME=$(sq "$DATA")
export WA_BRIDGE_LAUNCHER WA_BRIDGE_HOME
read -r WA_BRIDGE_NODE < $(sq "$ROOT/current/NODE_VERSION")
exec $(sq "$ROOT/node")/"\$WA_BRIDGE_NODE"/bin/node --disable-warning=ExperimentalWarning $(sq "$ROOT/current/bin/wa.mjs") "\$@"
EOF
  chmod 755 "$ROOT/bin/.wa-bridge.tmp"
  mv -f "$ROOT/bin/.wa-bridge.tmp" "$ROOT/bin/wa-bridge"

  # ------------------------------------------------------------ commands on PATH
  mkdir -p "$BIN_DIR"
  CMD="$ROOT/bin/wa-bridge"            # what to tell the user to type
  if link_alias wa-bridge; then CMD=wa-bridge; fi
  if link_alias wa; then CMD=wa; fi
  PATH_FILES=""
  case ":$PATH:" in
    *":$BIN_DIR:"*) ON_PATH=1 ;;
    *) ON_PATH=0 ;;
  esac
  [ "$ON_PATH" = 1 ] || CMD="$ROOT/bin/wa-bridge"
  if [ "$ON_PATH" = 0 ] && [ "$MODIFY_PATH" = 1 ]; then
    add_path_line "$HOME/.profile"
    { [ -f "$HOME/.bashrc" ] || [ "${SHELL##*/}" = bash ]; } && add_path_line "$HOME/.bashrc"
    { [ -f "$HOME/.zshrc" ] || [ "${SHELL##*/}" = zsh ]; } && add_path_line "$HOME/.zshrc"
    if have fish || [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/fish" ]; then
      fishconf="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wa-bridge.fish"
      if [ ! -f "$fishconf" ]; then
        mkdir -p "$(dirname "$fishconf")"
        printf '# added by the wa-bridge installer; remove with: wa uninstall\nif not contains -- $HOME/.local/bin $PATH\n    set -gx PATH $HOME/.local/bin $PATH\nend\n' > "$fishconf"
        PATH_FILES="$PATH_FILES $fishconf"
      fi
    fi
  fi

  # ------------------------------------------------------------ upgrade: restart a running daemon, refresh skills
  "$ROOT/bin/wa-bridge" post-install || warn "post-install steps reported a problem; run: $CMD doctor"

  say ""
  say "✓ wa-bridge $VER installed in $ROOT"
  if [ -n "$PATH_FILES" ]; then say "  ~/.local/bin was added to your PATH in:$PATH_FILES (open a new terminal to use \`wa\`)"; fi
  say "  Now run:  $CMD connect"
  say "  (links WhatsApp with a QR code in your terminal, then adds it to your agents)"
}

main "$@"
