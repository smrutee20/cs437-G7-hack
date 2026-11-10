#!/usr/bin/env bash
# Weekly maintenance of the private loopback TLS certificates. Caddy renews the
# public certificates separately. Keep the same private key so a crash cannot
# leave a mismatched key/certificate pair while replacing the certificate.
set -euo pipefail
umask 077
if [[ $EUID != 0 ]]; then echo 'Run as root (sudo).'; exit 1; fi
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --force ) ]]; then echo 'usage: renew-internal-tls.sh [--force]'; exit 1; fi
base=/etc/feedback/tls
for site in portal respond; do
  if [[ ${1:-} != --force ]] && openssl x509 -checkend 2592000 -noout -in "$base/$site.crt" >/dev/null 2>&1; then
    continue
  fi
  hostname="$site.freedback.tech"
  temp=$(mktemp -d "$base/.renew-$site.XXXXXXXX")
  trap 'rm -rf "$temp"' EXIT
  openssl req -new -sha256 -key "$base/$site.key" -subj "/CN=$hostname" \
    -addext "subjectAltName=DNS:$hostname" -out "$temp/request.csr" >/dev/null 2>&1
  openssl x509 -req -sha256 -days 90 -copy_extensions copy \
    -in "$temp/request.csr" -CA "$base/internal-ca.crt" -CAkey "$base/internal-ca.key" \
    -out "$temp/cert.crt" >/dev/null 2>&1
  openssl verify -verify_hostname "$hostname" -CAfile "$base/internal-ca.crt" "$temp/cert.crt" >/dev/null
  chown "feedback-$site:feedback-$site" "$temp/cert.crt"
  chmod 600 "$temp/cert.crt"
  mv -f "$temp/cert.crt" "$base/$site.crt"
  systemctl restart "feedback-$site.service"
  rm -rf "$temp"
  trap - EXIT
done
