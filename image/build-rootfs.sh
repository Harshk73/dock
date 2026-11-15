#!/bin/bash
# Builds the Alpine x86 root filesystem tree for the Dock VM.
# Usage: image/build-rootfs.sh   (run as root on Linux; needs curl and access to dl-cdn.alpinelinux.org)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/cache"
BUILD="$HERE/build"
ROOT="$BUILD/rootfs"
ALPINE_BRANCH="v3.24"
MIRROR="https://dl-cdn.alpinelinux.org/alpine"
APK="$CACHE/apkstatic/sbin/apk.static"

PACKAGES="
  alpine-baselayout alpine-keys busybox busybox-binsh apk-tools musl-utils
  ca-certificates bash curl git tar gzip unzip xz jq nano less file
  python3 py3-pip nodejs npm
  linux-virt
"

ALPINE_RELEASE="3.24.4"
HOST_ARCH="$(uname -m)"   # apk.static runs on the build machine; the image is always x86

# Bootstrap tools: Alpine's signing keys and a static apk, fetched once into the cache.
mkdir -p "$CACHE/apk"
if [ ! -d "$CACHE/keys/etc/apk/keys" ]; then
  curl -fsSL -o "$CACHE/minirootfs.tar.gz" \
    "$MIRROR/$ALPINE_BRANCH/releases/x86/alpine-minirootfs-$ALPINE_RELEASE-x86.tar.gz"
  mkdir -p "$CACHE/keys"
  tar -xzf "$CACHE/minirootfs.tar.gz" -C "$CACHE/keys" ./etc/apk/keys
fi
if [ ! -x "$APK" ]; then
  curl -fsSL -o "$CACHE/APKINDEX.tar.gz" "$MIRROR/$ALPINE_BRANCH/main/$HOST_ARCH/APKINDEX.tar.gz"
  tar -xzf "$CACHE/APKINDEX.tar.gz" -C "$CACHE" APKINDEX
  version="$(awk '/^P:apk-tools-static$/ { found = 1 } found && /^V:/ { print substr($0, 3); exit }' "$CACHE/APKINDEX")"
  curl -fsSL -o "$CACHE/apk-tools-static.apk" "$MIRROR/$ALPINE_BRANCH/main/$HOST_ARCH/apk-tools-static-$version.apk"
  mkdir -p "$CACHE/apkstatic"
  tar -xzf "$CACHE/apk-tools-static.apk" -C "$CACHE/apkstatic" sbin/apk.static 2>/dev/null
fi

rm -rf "$ROOT"
mkdir -p "$ROOT/etc/apk" "$ROOT/etc/mkinitfs"
cp -a "$CACHE/keys/etc/apk/keys" "$ROOT/etc/apk/keys"
cat > "$ROOT/etc/apk/repositories" <<EOF
$MIRROR/$ALPINE_BRANCH/main
$MIRROR/$ALPINE_BRANCH/community
EOF
# Keep the stock initramfs generator from pulling in more than the VM needs.
echo 'features="ata base scsi ext4 virtio"' > "$ROOT/etc/mkinitfs/mkinitfs.conf"

# shellcheck disable=SC2086
"$APK" --root "$ROOT" --arch x86 --initdb --cache-dir "$CACHE/apk" --no-progress \
  add $PACKAGES

echo "rootfs size: $(du -sh "$ROOT" | cut -f1)"
ls -la "$ROOT/boot"
