#!/usr/bin/env bash
# Run once on the fresh Lightsail host, after the built release is unpacked.
# Never prints passwords, tokens, certificate private keys, or OAuth material.
set -euo pipefail
umask 077
release=/opt/feedback/current
config=/etc/feedback
state=/var/lib/feedback
if [[ $EUID != 0 ]]; then echo 'Run as root (sudo).'; exit 1; fi
if [[ -e $config/postgres.env ]]; then echo 'Already initialized; refusing to replace credentials or database.'; exit 1; fi

for account in feedback-portal feedback-respond feedback-signer; do
  id "$account" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$account"
done
install -d -m 700 -o feedback-portal -g feedback-portal "$state" "$state/keys"
# Traverse-only for service users; individual secrets remain 0600 and per-user.
install -d -m 711 "$config" "$config/tls"

# PostgreSQL superuser is deployment-only; no running API receives it.
admin_password=$(openssl rand -hex 24)
printf 'POSTGRES_USER=feedback_migrator\nPOSTGRES_DB=feedback\nPOSTGRES_PASSWORD=%s\n' "$admin_password" > "$config/postgres.env"
chmod 600 "$config/postgres.env"
cd "$release"
docker compose -f deploy/aws/compose.yaml config --quiet
docker compose -f deploy/aws/compose.yaml up -d --wait postgres
FEEDBACK_MIGRATION_DB_URL="postgresql://feedback_migrator:${admin_password}@127.0.0.1:55432/feedback" \
  /usr/local/bin/node services/portal-api/dist/ops-cli.js migrate

# Each runtime login belongs to exactly one non-login role.
create_login() {
  local login=$1 group=$2 password
  password=$(openssl rand -hex 24)
  if ! printf "CREATE ROLE %s LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE IN ROLE %s;\n" \
    "$login" "$password" "$group" | docker exec -i feedback-postgres-1 \
    psql -q -v ON_ERROR_STOP=1 -U feedback_migrator -d feedback >/dev/null 2>&1; then
    echo "Could not create $login; stop and inspect locally before retrying (do not rerun bootstrap)." >&2
    exit 1
  fi
  printf '%s' "$password"
}
portal=$(create_login feedback_portal_login feedback_portal_admin)
issuer=$(create_login feedback_issuer_login feedback_issuer)
auth=$(create_login feedback_auth_login feedback_auth)
closer=$(create_login feedback_closer_login feedback_closer)
retention=$(create_login feedback_retention_login feedback_retention)
respond=$(create_login feedback_respond_login feedback_response_public)
operator=$(create_login feedback_operator_login feedback_operator)

openssl rand 32 > "$config/key-encryption.key"
openssl rand 32 > "$config/cursor.key"
signer_token=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
printf '%s\n' "$signer_token" > "$config/signer-token"
printf 'SIGNER_SERVICE_TOKEN=%s\n' "$signer_token" > "$config/signer.env"
chmod 600 "$config"/*.key "$config"/signer-token "$config"/signer.env
chown feedback-portal:feedback-portal "$config/key-encryption.key" "$config/cursor.key" "$config/signer-token"

cat > "$config/portal.env" <<EOF
NODE_ENV=production
FEEDBACK_PORTAL_ORIGIN=https://portal.freedback.tech
FEEDBACK_RESPOND_ORIGIN=https://respond.freedback.tech
FEEDBACK_LISTEN_HOST=127.0.0.1
FEEDBACK_LISTEN_PORT=4173
FEEDBACK_TLS_CERT_FILE=$config/tls/portal.crt
FEEDBACK_TLS_KEY_FILE=$config/tls/portal.key
FEEDBACK_GOOGLE_CLIENT_ID=755222041635-arfnl1aqltu8obt7sjj4rspe2n5h4682.apps.googleusercontent.com
FEEDBACK_GOOGLE_CLIENT_SECRET_FILE=$config/google-client-secret
FEEDBACK_PORTAL_DB_URL=postgresql://feedback_portal_login:$portal@127.0.0.1:55432/feedback
FEEDBACK_ISSUER_DB_URL=postgresql://feedback_issuer_login:$issuer@127.0.0.1:55432/feedback
FEEDBACK_AUTH_DB_URL=postgresql://feedback_auth_login:$auth@127.0.0.1:55432/feedback
FEEDBACK_CLOSER_DB_URL=postgresql://feedback_closer_login:$closer@127.0.0.1:55432/feedback
FEEDBACK_RETENTION_DB_URL=postgresql://feedback_retention_login:$retention@127.0.0.1:55432/feedback
FEEDBACK_KEY_DIRECTORY=$state/keys
FEEDBACK_KEY_ENCRYPTION_KEY_FILE=$config/key-encryption.key
FEEDBACK_CURSOR_KEY_FILE=$config/cursor.key
FEEDBACK_JOURNAL_PATH=$state/journal.jsonl
FEEDBACK_SIGNER_URL=http://127.0.0.1:8790
FEEDBACK_SIGNER_TOKEN_FILE=$config/signer-token
EOF
cat > "$config/respond.env" <<EOF
NODE_ENV=production
FEEDBACK_PORTAL_ORIGIN=https://portal.freedback.tech
FEEDBACK_RESPOND_ORIGIN=https://respond.freedback.tech
FEEDBACK_LISTEN_HOST=127.0.0.1
FEEDBACK_LISTEN_PORT=4174
FEEDBACK_TLS_CERT_FILE=$config/tls/respond.crt
FEEDBACK_TLS_KEY_FILE=$config/tls/respond.key
FEEDBACK_RESPOND_DB_URL=postgresql://feedback_respond_login:$respond@127.0.0.1:55432/feedback
EOF
cat > "$config/operator.env" <<EOF
FEEDBACK_JOURNAL_PATH=$state/journal.jsonl
FEEDBACK_KEY_DIRECTORY=$state/keys
FEEDBACK_OPERATOR_DB_URL=postgresql://feedback_operator_login:$operator@127.0.0.1:55432/feedback
FEEDBACK_RETENTION_DB_URL=postgresql://feedback_retention_login:$retention@127.0.0.1:55432/feedback
EOF
chmod 600 "$config/portal.env" "$config/respond.env" "$config/operator.env"
chown feedback-portal:feedback-portal "$config/portal.env"
chown feedback-respond:feedback-respond "$config/respond.env"
sudo -u feedback-portal env FEEDBACK_JOURNAL_PATH="$state/journal.jsonl" \
  /usr/local/bin/node "$release/services/portal-api/dist/ops-cli.js" init-journal

echo 'Database migrated; restricted runtime roles, keys, and journal initialized. No app has started.'
