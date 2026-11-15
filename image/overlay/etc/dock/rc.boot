#!/bin/sh
# Dock VM boot script: runs once from busybox init, before the console and agent start.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys  || mount -t sysfs sysfs /sys
mountpoint -q /dev  || mount -t devtmpfs dev /dev
mkdir -p /dev/pts /dev/shm
mountpoint -q /dev/pts || mount -t devpts -o gid=5,mode=620 devpts /dev/pts
mountpoint -q /dev/shm || mount -t tmpfs -o nosuid,nodev shm /dev/shm
mount -t tmpfs -o nosuid,nodev,mode=755 run /run
mount -o remount,rw,noatime /

hostname dock
rm -rf /tmp/* /tmp/.[!.]* 2>/dev/null

[ -e /sys/class/net/eth0 ] || modprobe virtio_net 2>/dev/null
ip link set lo up
ip link set eth0 up
ip addr add 192.168.86.100/24 dev eth0
ip route add default via 192.168.86.1
echo "nameserver 192.168.86.1" > /etc/resolv.conf

# Write data out promptly: the page persists the disk a few seconds after each write.
echo 300 > /proc/sys/vm/dirty_writeback_centisecs
echo 600 > /proc/sys/vm/dirty_expire_centisecs

mkdir -p /dock/apps /dock/bin /dock/skills /dock/logs
