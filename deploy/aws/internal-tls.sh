#!/usr/bin/env bash
# A small private CA for the two loopback HTTPS listeners; public TLS is Caddy.
set -euo pipefail
umask 077
if [[ $EUID != 0 ]]; then echo 'Run as root (sudo).'; exit 1; fi
base=/etc/feedback/tls
if [[ -e $base/internal-ca.key ]]; then echo 'Internal CA already exists; refusing to replace it.'; exit 1; fi
install -d -m 711 "$base"
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 \
  -subj '/CN=Feedback internal loopback CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$base/internal-ca.key" -out "$base/internal-ca.crt" >/dev/null 2>&1
chmod 644 "$base/internal-ca.crt"
for site in portal respond; do
  hostname="$site.freedback.tech"
  openssl req -new -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=$hostname" -addext "subjectAltName=DNS:$hostname" \
    -keyout "$base/$site.key" -out "$base/$site.csr" >/dev/null 2>&1
  openssl x509 -req -sha256 -days 90 -copy_extensions copy \
    -in "$base/$site.csr" -CA "$base/internal-ca.crt" -CAkey "$base/internal-ca.key" \
    -CAcreateserial -out "$base/$site.crt" >/dev/null 2>&1
  rm "$base/$site.csr"
  chmod 600 "$base/$site.key" "$base/$site.crt"
  chown "feedback-$site:feedback-$site" "$base/$site.key" "$base/$site.crt"
done
# The private files are unreadable to Caddy; it only needs the CA's public cert.
chmod 711 "$base"
echo 'Private loopback TLS certificates created (90 days; renew before expiry).'
