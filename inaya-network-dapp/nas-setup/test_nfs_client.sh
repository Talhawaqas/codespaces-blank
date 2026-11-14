#!/bin/bash
set -e
apt-get install -y nfs-common >/tmp/nfs-common-install.log 2>&1 || true
mkdir -p /mnt/inaya-nfs-test
mount -t nfs4 172.21.35.48:/srv/inaya-nas/nfs-share1 /mnt/inaya-nfs-test
echo "--- mounted ---"
mount | grep inaya-nfs-test
echo "--- write ---"
echo "Inaya Sovereign NAS - real NFS write test $(date)" > /mnt/inaya-nfs-test/nfstest1.txt
echo "--- read ---"
cat /mnt/inaya-nfs-test/nfstest1.txt
echo "--- rename ---"
mv /mnt/inaya-nfs-test/nfstest1.txt /mnt/inaya-nfs-test/nfstest1-renamed.txt
echo "--- mkdir + nested write/read ---"
mkdir -p /mnt/inaya-nfs-test/subdir
echo "nested nfs content" > /mnt/inaya-nfs-test/subdir/nested.txt
cat /mnt/inaya-nfs-test/subdir/nested.txt
echo "--- listing ---"
ls -la /mnt/inaya-nfs-test/
echo "--- delete ---"
rm /mnt/inaya-nfs-test/nfstest1-renamed.txt
ls -la /mnt/inaya-nfs-test/
echo "--- unmount ---"
umount /mnt/inaya-nfs-test
echo "--- remount and verify persistence ---"
mount -t nfs4 172.21.35.48:/srv/inaya-nas/nfs-share1 /mnt/inaya-nfs-test
cat /mnt/inaya-nfs-test/subdir/nested.txt
echo "NFS_TEST_COMPLETE"
