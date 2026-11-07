#!/usr/bin/env bash
# Creates a LOCAL CA and a certificate for the two distinct loopback hostnames.
# Does not modify system or browser trust stores. Never use these keys for real users.
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p .certs
if [[ -e .certs/dev-ca.key || -e .certs/dev-server.key ]]; then
  printf 'Local keys already exist. Refusing to replace them.\n' >&2
  exit 1
fi
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -keyout .certs/dev-ca.key -out .certs/dev-ca.crt \
  -subj '/CN=IITGN Feedback Local Development CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout .certs/dev-server.key -out .certs/dev-server.csr \
  -subj '/CN=portal.feedback.test' >/dev/null 2>&1
cat > .certs/dev-server.ext <<'EOF'
subjectAltName=DNS:portal.feedback.test,DNS:respond.feedback.test
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -sha256 -days 30 \
  -in .certs/dev-server.csr -CA .certs/dev-ca.crt -CAkey .certs/dev-ca.key \
  -CAcreateserial -out .certs/dev-server.crt -extfile .certs/dev-server.ext >/dev/null 2>&1
rm .certs/dev-server.csr .certs/dev-server.ext .certs/dev-ca.srl
printf 'Local CA: %s/.certs/dev-ca.crt\n' "$PWD"
printf 'Trust this local CA in your dev browser/OS before interactive browsing.\n'
