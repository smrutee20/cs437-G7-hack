# AWS Lightsail deployment

This is the concrete deployment of the Feedback Booth. For release requirements and incident/restore procedures, see [deployment.md](deployment.md). **Do not collect real feedback yet:** an IITGN student has signed in and used the deployed portal (confirmed by the project team; see [issue #3](https://github.com/smrutee20/cs437-G7-hack/issues/3)), but signed `email`/`hd` claims have not been independently inspected, off-instance backups are absent, and the ingress/privacy and signer security reviews are open.

## What is running

- One x86-64 Lightsail instance (`feedback-booth`) in Mumbai (`ap-south-1`), static IPv4 `3.6.215.231`. The DNS A records for `portal.freedback.tech` and `respond.freedback.tech` point to that address. This layout avoids a load balancer, RDS, CDN and Route 53; review the Lightsail bill and storage/transfer charges in the AWS console rather than assuming a fixed total.
- Caddy serves both public HTTPS sites and obtains their Let's Encrypt certificates. It forwards to separate Node HTTPS listeners on loopback (`4173` for the portal, `4174` for responses), each with a hostname-specific certificate signed by a private local CA. Caddy verifies that CA. HTTP redirects to HTTPS.
- PostgreSQL 17 runs in Docker Compose on loopback port `55432`, with a persistent volume and separate least-privilege runtime logins. The portal, response service and native `workerd` signer run as separate systemd users; the signer listens only on loopback port `8790` with a service credential. `/var/lib/feedback/keys` and `/var/lib/feedback/journal.jsonl` are restricted to the portal user. Environment and secrets are under `/etc/feedback/` (never put them in Git).
- Configuration sources are [`deploy/aws/`](../deploy/aws/): Compose, Caddyfile, systemd units, initial bootstrap and private TLS certificate maintenance. `bootstrap.sh` is **one-time only**; never rerun it on an initialized host. Do not overwrite the journal, database, encryption key or CA on redeploy.

On 2026-11-10, both sites returned HTTP 200 with valid public TLS, CSP and HSTS; the response site's login path returned 404. SSH was reachable, the portal, response, signer, Caddy and private TLS timer were active, and the database had 11 migrations. Policy v2 was deployed after migration: the two previously closed v1 polls and their three responses were preserved. SSH had timed out on 2026-11-09; check the Lightsail firewall and your outbound SSH policy if access fails again. Do not change firewall rules without verifying the instance/account and limiting SSH access.

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

The login redirect by itself proves only that the OAuth URL is configured. A real IITGN student has since signed in and used the portal, but we have not recorded an independent inspection of the signed `email`/`hd` claims or institutional authorization. This observation does not close the release gate.

## Maintenance and remaining work

- Caddy manages *public* TLS. `feedback-internal-tls.timer` checks the *private loopback* certificates weekly and renews them when less than 30 days remain; `deploy/aws/renew-internal-tls.sh` restarts the relevant service after renewal. Check timer status and service health after a renewal. Do not replace the local CA without coordinating Caddy and both listeners.
- On 2026-11-16, a browser-link bug exposed that the original portal and response bundles had been built with the local `.test` defaults, despite the runtime configuration using the public origins. Both static bundles were rebuilt with `npm run build:deploy` and swapped on the instance; the two services were restarted. Public assets now contain `https://respond.freedback.tech` (portal bundle) and `https://portal.freedback.tech` (response bundle). The former directories remain as `apps/{portal,respond}/dist.rollback-20261116-origin-fix` for rollback; they contain the broken local origins and must not be restored as a fix. This was a static-bundle correction, not a test of a real account or a general rollout procedure.
- For future public builds, run `npm run build:deploy` (sets both public origins and refuses missing/development origins). Do **not** use plain `npm run build` for deployment: it intentionally defaults to local `.test` origins for synthetic development. Verify the hashed JavaScript assets served from both public hosts before sharing any poll link. Exclude `.certs/`, client secrets and `dist-demo`; stage the new release, keep rollback copies, and retain live data directories and `/etc/feedback/`. Runtime dependencies were installed with `npm ci --omit=dev`. **Before starting code that uses policy v2, apply the forward-only `0010_small_polls` migration with the deployment-only migration credential.** It updates editable drafts; opened v1 polls keep their frozen thresholds. Do not apply it without a verified recovery path. There is **no tested automated rollout or rollback** yet. Do not rerun the first-time bootstrap for an update.
- Before the 2026-11-10 migration, an encrypted, off-instance database dump and encrypted recovery-state archive (keys, journal and configuration) were saved under the deployment workstation's ignored `.certs/`; the database dump was restored and its counts verified in an isolated tmpfs PostgreSQL container. **This is only a one-time checkpoint**, not a tested full recovery of the application. The passphrase and archives reside on the same workstation; there are still no recurring independent durable encrypted backups, WAL archive, restore drill for the full stack or backup-expiry enforcement. A same-instance volume or Lightsail snapshot alone does not satisfy [deployment.md](deployment.md) §8. Implement and test a separate encrypted backup scheme before considering real participants; do not roll back a database without running the specified recovery procedure offline.
- Do not treat Caddy's absence of an access-log directive as a complete ingress privacy review. Verify Lightsail/network logs, server swap/core-dump settings, ingress header stripping, request bounds and any external telemetry. The signer still needs a pinned container image/digest and security sign-off. The credential-rotation procedure is not established.
- When SSH access returns, recheck service health, disk space, private TLS timer and the database/journal sync before making further changes. An unavailable SSH port is not evidence that the site or database is healthy.
