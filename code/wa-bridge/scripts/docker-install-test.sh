#!/bin/sh
# Run the real one-liner (curl … | sh) inside one Docker image, against a release served by
# `node scripts/test-install.mjs --serve-only` (signed with that run's throwaway key, which its install.sh trusts).
#   scripts/docker-install-test.sh <image> <release-url> <node-mirror-url> <expect: ok|unsupported>
# The container uses the host network to reach the server and installs as an unprivileged user.
set -eu
IMAGE=$1 URL=$2 MIRROR=$3 EXPECT=$4
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/prep.sh" <<'EOF'
set -e
if command -v apt-get >/dev/null; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null
elif command -v dnf >/dev/null; then dnf install -y -q curl tar gzip findutils >/dev/null
elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --needed curl tar gzip >/dev/null
elif command -v apk >/dev/null; then apk add -q curl
fi
id tester >/dev/null 2>&1 || useradd -m tester 2>/dev/null || adduser -D tester
EOF

cat > "$WORK/run.sh" <<EOF
set -e
export WA_BRIDGE_DOWNLOAD_URL='$URL' WA_BRIDGE_NODE_MIRROR='$MIRROR'
curl -fsSL "\$WA_BRIDGE_DOWNLOAD_URL/install.sh" | sh
W="\$HOME/.wa-bridge/bin/wa-bridge"
"\$W" version
"\$W" doctor --json >/dev/null || true
"\$W" start --no-service
"\$W" status | grep -q 'state: *unlinked'
"\$W" uninstall --yes
test ! -e "\$HOME/.wa-bridge"
echo INSTALL-TEST-PASSED
EOF
chmod 755 "$WORK"; chmod 644 "$WORK"/*.sh

set +e
out=$(docker run --rm --network host -v "$WORK:/t:ro" "$IMAGE" sh -c 'sh /t/prep.sh && su tester -c "sh /t/run.sh"' 2>&1)
code=$?
set -e
printf '%s\n' "$out" | tail -n 25
if [ "$EXPECT" = unsupported ]; then
  if [ $code -ne 0 ] && printf '%s' "$out" | grep -q 'is not supported'; then echo "OK: $IMAGE was refused cleanly"; exit 0; fi
  echo "FAIL: $IMAGE should have been refused as unsupported"; exit 1
fi
if [ $code -eq 0 ] && printf '%s' "$out" | grep -q INSTALL-TEST-PASSED; then echo "OK: $IMAGE"; exit 0; fi
echo "FAIL: $IMAGE (exit $code)"; exit 1
