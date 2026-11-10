# AWS Lightsail deployment

This is the concrete deployment of the Feedback Booth. For release requirements and incident/restore procedures, see [deployment.md](deployment.md). **Do not use real participants yet:** institutional login has not been exercised, off-instance backups are absent, and the ingress/privacy and signer security reviews are open.

## What is running

- One x86-64 Lightsail instance (`feedback-booth`) in Mumbai (`ap-south-1`), static IPv4 `3.6.215.231`. The DNS A records for `portal.freedback.tech` and `respond.freedback.tech` point to that address. This layout avoids a load balancer, RDS, CDN and Route 53; review the Lightsail bill and storage/transfer charges in the AWS console rather than assuming a fixed total.
- Caddy serves both public HTTPS sites and obtains their Let's Encrypt certificates. It forwards to separate Node HTTPS listeners on loopback (`4173` for the portal, `4174` for responses), each with a hostname-specific certificate signed by a private local CA. Caddy verifies that CA. HTTP redirects to HTTPS.
- PostgreSQL 17 runs in Docker Compose on loopback port `55432`, with a persistent volume and separate least-privilege runtime logins. The portal, response service and native `workerd` signer run as separate systemd users; the signer listens only on loopback port `8790` with a service credential. `/var/lib/feedback/keys` and `/var/lib/feedback/journal.jsonl` are restricted to the portal user. Environment and secrets are under `/etc/feedback/` (never put them in Git).
- Configuration sources are [`deploy/aws/`](../deploy/aws/): Compose, Caddyfile, systemd units, initial bootstrap and private TLS certificate maintenance. `bootstrap.sh` is **one-time only**; never rerun it on an initialized host. Do not overwrite the journal, database, encryption key or CA on redeploy.

On 2026-11-09, both sites returned HTTP 200 with valid public TLS, CSP and HSTS; the portal login redirected to Google, while the response site's login path returned 404 without a cookie. On 2026-11-08, the server services and PostgreSQL health check were active, and the private certificate-renewal timer was enabled. **Current server health is unverified:** SSH port 22 timed out from this workstation on 2026-11-09, while port 443 remained reachable. Check the Lightsail networking firewall and your own outbound SSH policy before relying on remote administration; do not change firewall rules without verifying the instance/account and limiting SSH access.

## Access and checks

Use an authorized, dedicated SSH key stored outside Git; `.certs/` and the downloaded Google client JSON are ignored. Verify the server's host key out of band before first connection. Never paste passwords, OAuth secrets or private keys into chat or commit them. The deployment's existing dedicated key is `.certs/feedback-aws-deploy` and its known-hosts file is `.certs/aws-download/known_hosts` on the deployment workstation.

From the repository root, after SSH access is restored:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=.certs/aws-download/known_hosts \
  -i .certs/feedback-aws-deploy ubuntu@3.6.215.231
```

On the instance, for **read-only** health checks (do not print environment files, database URLs or request logs):

```sh
sudo systemctl is-active caddy feedback-signer feedback-portal feedback-respond feedback-internal-tls.timer
sudo docker compose -f /opt/feedback/current/deploy/aws/compose.yaml ps
sudo systemctl list-timers feedback-internal-tls.timer --no-pager
sudo openssl x509 -noout -enddate -in /etc/feedback/tls/portal.crt
sudo openssl x509 -noout -enddate -in /etc/feedback/tls/respond.crt
df -h /; swapon --show
```

Public smoke checks (no authentication needed):

```sh
curl -fSI https://portal.freedback.tech/
curl -fSI https://respond.freedback.tech/
curl -sS -o /dev/null -w '%{http_code}\n' https://respond.freedback.tech/api/v1/auth/login # expect 404
```

The login redirect proves only that the OAuth URL is configured; **it does not prove Google token verification or institutional authorization.** An authorized institutional tester must complete a sign-in before that gate can be closed.

## Maintenance and remaining work

- Caddy manages *public* TLS. `feedback-internal-tls.timer` checks the *private loopback* certificates weekly and renews them when less than 30 days remain; `deploy/aws/renew-internal-tls.sh` restarts the relevant service after renewal. Check timer status and service health after a renewal. Do not replace the local CA without coordinating Caddy and both listeners.
- The release artifact was built for the two exact public origins and copied to `/opt/feedback/current`; runtime dependencies were installed with `npm ci --omit=dev`. Future updates should build and verify both bundles before transfer, exclude `.certs/`, client secrets and `dist-demo`, use a staging directory and controlled restart/rollback, and retain the live data directories and `/etc/feedback/`. There is **no tested automated rollout or rollback** yet. Do not rerun the first-time bootstrap for an update.
- There are **no verified off-instance encrypted PostgreSQL, key or independent journal backups**, WAL archive, restore drill or backup-expiry enforcement. A same-instance volume or Lightsail snapshot alone does not satisfy the recovery/rollback requirements in [deployment.md](deployment.md) §8. Implement and test a separate encrypted backup scheme before considering real participants; do not roll back a database without running the specified recovery procedure offline.
- Do not treat Caddy's absence of an access-log directive as a complete ingress privacy review. Verify Lightsail/network logs, server swap/core-dump settings, ingress header stripping, request bounds and any external telemetry. The signer still needs a pinned container image/digest and security sign-off. The credential-rotation procedure is not established.
- When SSH access returns, recheck service health, disk space, private TLS timer and the database/journal sync before making further changes. An unavailable SSH port is not evidence that the site or database is healthy.
