#!/usr/bin/env python3
"""Turns image/build/rootfs into the files the web app serves:

  web/vm/vmlinuz, web/vm/initramfs      kernel + initramfs (booted directly by the emulator)
  web/vm/disk/manifest.json             virtual disk geometry + list of non-empty chunks
  web/vm/disk/<n>.gz                    gzip of each non-empty 1 MiB chunk of the ext4 image

Usage: image/make-image.py [--size-gb 10]
"""
import argparse, gzip, hashlib, json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
ROOT = os.path.join(BUILD, "rootfs")
OVERLAY = os.path.join(HERE, "overlay")
OUT = os.path.join(HERE, "..", "web", "vm")
CHUNK = 1 << 20


def run(*cmd, **kw):
    subprocess.run(cmd, check=True, **kw)


INIT = """#!/bin/busybox sh
# Dock early boot: load the disk and filesystem drivers, mount the root disk, hand over.
bb=/bin/busybox
$bb mount -t devtmpfs dev /dev
for m in /modules/*.ko; do $bb insmod "$m"; done
n=0
until [ -b /dev/sda ] || [ $n -ge 400 ]; do $bb sleep 0.02; n=$((n+1)); done
$bb mount -t ext4 -o rw,noatime /dev/sda /sysroot || { echo "dock: cannot mount the root disk"; exec $bb sh; }
$bb mount -o move /dev /sysroot/dev
exec $bb switch_root /sysroot /sbin/init
"""

# Loaded in the initramfs, in dependency order (see modules.dep).
BOOT_MODULES = ["sd_mod", "ext4", "virtio_net"]


def module_load_order(stage, version):
    dep_file = os.path.join(stage, "lib", "modules", version, "modules.dep")
    deps = {}
    for line in open(dep_file):
        path, _, rest = line.partition(":")
        deps[path.strip()] = rest.split()
    by_name = {os.path.basename(p).split(".ko")[0]: p for p in deps}
    order = []

    def visit(path):
        for dep in deps[path]:
            visit(dep)
        if path not in order:
            order.append(path)

    for name in BOOT_MODULES:
        visit(by_name[name])
    return order


def cpio_entry(name, mode, data=b"", rdev=(0, 0), ino=[1]):
    ino[0] += 1
    encoded = name.encode() + b"\0"
    fields = [ino[0], mode, 0, 0, 1, 0, len(data), 0, 0, rdev[0], rdev[1], len(encoded), 0]
    out = b"070701" + b"".join(b"%08x" % f for f in fields) + encoded
    out += b"\0" * (-len(out) % 4)
    out += data + b"\0" * (-len(data) % 4)
    return out


def build_initramfs(stage, out_path):
    """A minimal initramfs: busybox, the few kernel modules needed to reach the disk, /init."""
    version = os.listdir(os.path.join(stage, "lib", "modules"))[0]
    archive = b""
    for d in ("bin", "lib", "dev", "proc", "sys", "sysroot", "modules"):
        archive += cpio_entry(d, 0o040755)
    archive += cpio_entry("dev/console", 0o020600, rdev=(5, 1))
    for rel in ("bin/busybox", "lib/ld-musl-i386.so.1"):
        archive += cpio_entry(rel, 0o100755, open(os.path.join(stage, rel), "rb").read())
    for i, rel in enumerate(module_load_order(stage, version)):
        raw = gzip.decompress(open(os.path.join(stage, "lib", "modules", version, rel), "rb").read())
        name = os.path.basename(rel).split(".ko")[0]
        archive += cpio_entry(f"modules/{i:02d}-{name}.ko", 0o100644, raw)
    archive += cpio_entry("init", 0o100755, INIT.encode())
    archive += cpio_entry("TRAILER!!!", 0)
    with open(out_path, "wb") as f:
        f.write(gzip.compress(archive, compresslevel=9, mtime=0))
    return len(archive)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size-gb", type=int, default=10)
    args = ap.parse_args()

    stage = os.path.join(BUILD, "stage")
    if os.path.exists(stage):
        shutil.rmtree(stage)
    run("cp", "-a", ROOT, stage)
    run("cp", "-a", OVERLAY + "/.", stage)

    # Kernel and initramfs are loaded by the emulator, not from the disk.
    os.makedirs(OUT, exist_ok=True)
    shutil.copy(os.path.join(stage, "boot", "vmlinuz-virt"), os.path.join(OUT, "vmlinuz"))
    build_initramfs(stage, os.path.join(OUT, "initramfs"))
    for name in os.listdir(os.path.join(stage, "boot")):
        path = os.path.join(stage, "boot", name)
        if os.path.isfile(path) and not os.path.islink(path):
            os.remove(path)

    # root logs in with bash
    passwd = os.path.join(stage, "etc", "passwd")
    lines = open(passwd).read().splitlines()
    lines = [l.rsplit(":", 1)[0] + ":/bin/bash" if l.startswith("root:") else l for l in lines]
    open(passwd, "w").write("\n".join(lines) + "\n")
    for d in ("dock/apps", "dock/bin", "dock/skills", "dock/logs", "dock/npm"):
        os.makedirs(os.path.join(stage, d), exist_ok=True)

    img = os.path.join(BUILD, "disk.img")
    if os.path.exists(img):
        os.remove(img)
    size = args.size_gb << 30
    with open(img, "wb") as f:
        f.truncate(size)
    run("mke2fs", "-q", "-t", "ext4", "-F", "-L", "dock", "-m", "0", "-J", "size=32",
        "-U", "d0c4d0c4-0000-4000-8000-000000000001",
        "-E", "lazy_itable_init=1,lazy_journal_init=1,root_owner=0:0,hash_seed=d0c4d0c4-0000-4000-8000-000000000002",
        "-d", stage, img)

    disk_dir = os.path.join(OUT, "disk")
    if os.path.exists(disk_dir):
        shutil.rmtree(disk_dir)
    os.makedirs(disk_dir)
    present, digest, stored = [], hashlib.sha256(), 0
    zero = bytes(CHUNK)
    with open(img, "rb") as f:
        index = 0
        while True:
            # Skip holes quickly.
            try:
                data_at = os.lseek(f.fileno(), index * CHUNK, os.SEEK_DATA)
            except OSError:
                break
            index = data_at // CHUNK
            f.seek(index * CHUNK)
            buf = f.read(CHUNK)
            if not buf:
                break
            if len(buf) < CHUNK:
                buf += bytes(CHUNK - len(buf))
            if buf != zero:
                packed = gzip.compress(buf, compresslevel=9, mtime=0)
                with open(os.path.join(disk_dir, f"{index}.gz"), "wb") as out:
                    out.write(packed)
                present.append(index)
                digest.update(index.to_bytes(4, "little"))
                digest.update(hashlib.sha256(buf).digest())
                stored += len(packed)
            index += 1
    manifest = {
        "version": digest.hexdigest()[:16],
        "size": size,
        "chunkSize": CHUNK,
        "present": present,
        "kernel": "vmlinuz",
        "initrd": "initramfs",
        "cmdline": "rw console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on "
                   "nowatchdog quiet loglevel=3",
    }
    with open(os.path.join(disk_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    print(f"disk: {len(present)} chunks, {stored / 1e6:.1f} MB compressed, version {manifest['version']}")


if __name__ == "__main__":
    sys.exit(main())
