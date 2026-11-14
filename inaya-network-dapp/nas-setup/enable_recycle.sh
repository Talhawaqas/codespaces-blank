#!/bin/bash
set -e
cat > /etc/samba/smb.conf <<'EOF'
[global]
   workgroup = WORKGROUP
   server string = Inaya Sovereign NAS
   security = user
   map to guest = never
   server min protocol = SMB2
   log file = /var/log/samba/log.%m
   max log size = 1000
   dns proxy = no

[inaya-share1]
   path = /srv/inaya-nas/share1
   browseable = yes
   read only = no
   guest ok = no
   valid users = inayanas
   create mask = 0664
   directory mask = 0775
   vfs objects = recycle
   recycle:repository = .recycle/%U
   recycle:keeptree = yes
   recycle:versions = yes
   recycle:touch = yes
   recycle:maxsize = 0
EOF
testparm -s > /tmp/testparm.log 2>&1
tail -25 /tmp/testparm.log
smbcontrol smbd reload-config
service smbd restart
sleep 1
service smbd status | head -3
