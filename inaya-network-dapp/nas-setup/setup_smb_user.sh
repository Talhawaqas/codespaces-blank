#!/bin/bash
set -e
SMB_PASS=$(openssl rand -base64 18)
printf '%s\n%s\n' "$SMB_PASS" "$SMB_PASS" | smbpasswd -a -s inayanas
smbpasswd -e inayanas
echo "SMB_PASSWORD=$SMB_PASS" > /root/.inaya_nas_test_creds
cat /root/.inaya_nas_test_creds
