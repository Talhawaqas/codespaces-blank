#!/bin/bash
set -e
mkdir -p /srv/inaya-nas/nfs-share1
chown nobody:nogroup /srv/inaya-nas/nfs-share1
chmod 777 /srv/inaya-nas/nfs-share1

cat > /etc/exports <<'EOF'
/srv/inaya-nas/nfs-share1 172.21.0.0/20(rw,sync,no_subtree_check,no_root_squash)
EOF

exportfs -ra
service nfs-kernel-server restart
sleep 1
exportfs -v
rpcinfo -p 2>&1 | grep nfs || echo "rpcinfo nfs entries not found"
service nfs-kernel-server status | head -5
