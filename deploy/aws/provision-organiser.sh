#!/usr/bin/env bash
# Run on the initialized Lightsail instance as root. Look up the subject of an
# already signed-in Google account, then grant it the organiser role using the
# restricted operator CLI. Never prints the subject or database credentials.
set -euo pipefail
umask 077

if [[ $EUID -ne 0 || $# -ne 1 || -z $1 ]]; then
  echo 'Usage: sudo bash provision-organiser.sh email@iitgn.ac.in' >&2
  exit 1
fi

email=$1
subject=$(docker exec -i feedback-postgres-1 \
  psql -XAt -v ON_ERROR_STOP=1 -v "target_email=$email" \
    -U feedback_migrator -d feedback -f - <<'SQL'
SELECT subject FROM identity.users
 WHERE issuer = 'https://accounts.google.com'
   AND email = :'target_email';
SQL
)

if [[ -z $subject || $subject == *$'\n'* ]]; then
  echo 'Expected exactly one signed-in account; no change made.' >&2
  exit 1
fi

set -a
. /etc/feedback/operator.env
set +a
exec /usr/local/bin/node /opt/feedback/current/services/portal-api/dist/ops-cli.js provision-organiser "$subject"
