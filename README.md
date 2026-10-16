# School Payments (Ethiopia)

Multi-school SaaS for collecting fees over a **licensed Ethiopian gateway** (Chapa first). The platform never holds funds: each school registers a subaccount, and Chapa splits the payment so tuition lands in the school’s bank account.

Parents pay from an SMS link (telebirr, CBE Birr, M-Pesa, card). Every successful payment produces an **Ed25519-signed receipt** with a QR code that still verifies offline.

## Layout

| Path              | Role                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| `apps/web`        | Next.js 16 BFF. Session cookies stay httpOnly. Talks to the API over HTTP only. |
| `apps/api`        | NestJS 11. Database, gateway, SMS, email, storage, workers.                     |
| `packages/db`     | Prisma **7** schema, migrations, seed.                                          |
| `packages/shared` | Zod schemas, money (integer santim), receipt canonicalization, phone helpers.   |

Why Prisma 7, not 8: Prisma 8 is still a release candidate (`8.0.0-rc.*`). This repo pins Prisma **7.10**, the current stable line, with the `prisma-client` generator and `@prisma/adapter-pg`.

## Local development

Requires Node 22.18+, pnpm 11, Docker Desktop.

```bash
cp .env.example .env
# fill JWT_ACCESS_SECRET, DATA_ENCRYPTION_KEY, and receipt keys:
pnpm keys:generate
# paste the three RECEIPT_SIGNING_* values into .env

pnpm install
pnpm infra:up          # Postgres 5436, Redis 6380, Mailpit 8025
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm --filter @payment/api dev
pnpm --filter @payment/web dev
```

Copy the public receipt key into `apps/web/.env.local` as `NEXT_PUBLIC_RECEIPT_PUBLIC_KEYS` (see `.env.example` and `apps/web/.env.local`).

- Web: http://localhost:3000
- API + Swagger: http://localhost:4000/docs
- Mailpit: http://localhost:8025
- Seed admin: `SEED_PLATFORM_ADMIN_EMAIL` / `SEED_PLATFORM_ADMIN_PASSWORD` (must enroll TOTP on first login)

`PAYMENT_GATEWAY=mock` uses `/dev/checkout/:txRef` instead of Chapa. Forged webhooks are rejected.

## Security model (do not skip)

- Money is integer **santim**. Phone numbers are E.164.
- The API connects as `payment_app` (no `BYPASSRLS`). Migrations run as `payment_owner`.
- PostgreSQL RLS plus append-only triggers on ledger, audit log, payments and receipts.
- Staff: Argon2id passwords + TOTP. Parents: SMS OTP, no password.
- `apps/web` is the only public origin. It does not copy a browser-supplied `X-Forwarded-For` onto API calls.
- The API trusts `X-Forwarded-For` only from peers listed in `TRUSTED_PROXIES`, and only when that header is a single IP. Every other caller is rate-limited by the socket address. Set `TRUSTED_PROXIES` to the load balancer that strips any client-supplied forwarding header and sets the real client address.

## Deployment

These commands build local images. They do not deploy anything to a hosting provider, and this repository has no live production environment wired up.

```bash
docker build -f apps/api/Dockerfile -t payment-api .
docker build -f apps/api/Dockerfile --target worker -t payment-worker .
docker build -f apps/web/Dockerfile -t payment-web .
```

The API image runs `node dist/main.js` as the `node` user, with `RUN_WORKERS=false`. Its Docker health check calls `/health/live` and does not restart the container. The worker image runs `node dist/worker.js` and has no HTTP health check, because that process does not listen. Both processes are PID 1 in their images, so shutdown hooks exit the process after `SIGTERM`. `docker stop` therefore lets the worker finish its current job and close Redis. A `SIGKILL` can interrupt a job; BullMQ retries it after the lock expires, and a payment that already settled does not get a second ledger write. The web image runs the Next.js standalone server. Set `API_URL` when starting the web container; server-side calls and session refresh read it at runtime. `NEXT_PUBLIC_RECEIPT_PUBLIC_KEYS` is still baked in at image build time because the browser verifier needs it.

Run migrations once, from a checkout that has the Prisma CLI, before starting API replicas:

```bash
pnpm db:deploy
```

That runs `prisma migrate deploy` with `MIGRATION_DATABASE_URL` (the table owner). It applies pending migrations and does not reset the database. The API and worker processes do not migrate on startup, so replicas do not race. Do not run `pnpm db:seed` against production.

Start the images only after Postgres and Redis are reachable. Required API settings are listed in `.env.example`. In `NODE_ENV=production` the process refuses the mock gateway, the example `JWT_ACCESS_SECRET`, and a database URL that still contains the development role password. Generate real values; do not copy the example secrets. Chapa, SMS, and S3 credentials are required only for the providers you select. `SMS_PROVIDER=console` does not send SMS.

Postgres needs a durable volume for its data directory. Redis needs a durable volume if queued jobs and rate-limit counters should survive a Redis restart (`appendonly yes` is what local Compose uses). Receipt PDFs are not in Postgres: `STORAGE_DRIVER=local` writes inside the container and is lost when that container is recreated. Production needs `STORAGE_DRIVER=s3`.

`docker-compose.yml` is for local development. It publishes Postgres, Redis, and Mailpit on the host. It does not run the API, worker, or web, and it is not a production topology. Compose `restart: unless-stopped` restarts a container when its process exits. It does not restart a container because a health check failed.

A disposable local check is `pnpm test:deploy`. It requires the `payment-api` and `payment-worker` images. It starts `payment-web` only when that image is already present. The check creates only `payment-deploy-check-*` containers, volumes, and a network, then removes them. It does not use the developer database. It covers image contents, liveness while dependencies are absent, readiness after they appear, a repeated `migrate deploy`, API and Postgres restarts, recreating Postgres on the same volume, Redis AOF, worker startup without an HTTP port, and a queued verification for a payment reference that does not exist. After a container restart, API readiness is read with `wget` inside the API container. It does not take a real Chapa payment or send SMS.

What remains unverified until a real hosting environment exists: zero-downtime rollouts, orchestrator restarts, TLS, private networking so Postgres and Redis are not on a public interface, off-site backups, and S3 receipt storage.

## Backups

Implemented and tested: a custom-format `pg_dump` (`-Fc`) of the database named by `MIGRATION_DATABASE_URL`, a SHA-256 sidecar, and a restore into a disposable Postgres container that is not the application database. The verifier uses synthetic rows only. It checks the school, student, invoice, payment, both ledger entries, the receipt hash chain, the Ed25519 signature (with the public key still in memory for that run), the audit row, and the webhook event. It does not delete older backup files.

```bash
pnpm db:backup
pnpm db:restore-verify
pnpm test:backup
```

`pnpm db:backup` reads `MIGRATION_DATABASE_URL` from the environment or `.env` and writes `BACKUP_DIR` (default `backups/`). The password is passed to `pg_dump` through `PGPASSWORD`, not printed. A non-zero `pg_dump`, a file that does not start with `PGDMP`, or a checksum mismatch fails the command. Confirm a checksum with:

```bash
node --input-type=module -e "import { verifyChecksum } from './scripts/backup/lib.mjs'; console.log(await verifyChecksum(process.argv[1]))" -- backups/payment-<stamp>.dump
```

`pnpm db:restore-verify` restores a new synthetic backup into databases named `backup_src` and `backup_dst` on a random host port. It removes only the `payment-backup-verify-*` container it created. It refuses a target whose host, port, and database name match the application database (`localhost`, `127.0.0.1`, and `::1` count as the same host).

What the dump contains: the Postgres database, including schema migrations, schools, students, invoices, payments, ledger entries, receipts (payload, hash, signature, key id), audit logs, and webhook rows.

What the dump does not contain, and a restore will not bring back:

- Redis, BullMQ jobs, and rate-limit counters
- Receipt PDF files (`storage/` locally, or the S3/R2 bucket)
- Ed25519 signing keys, `DATA_ENCRYPTION_KEY`, JWT secrets, gateway secrets, and the rest of `.env`
- Records that exist only at Chapa or another gateway
- WAL files. This is not point-in-time recovery.

Recommendations that this repository does not perform for you: copy each dump and its `.sha256` file to a separate host or object store, encrypt that copy at rest, restrict who can read it, and keep at least 30 days. Run `pnpm db:restore-verify` on a schedule so a backup is proven restorable before you need it. Losing the receipt private key stops new signatures for that key id; old receipts still verify with the published public key, which is also outside the dump.

| What                 | Status                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres             | `pnpm db:backup` writes a custom-format dump and checksum. Restore is checked by `pnpm db:restore-verify`. Retention, off-site copy, and encryption are not automated. |
| Receipt PDFs         | Not in Postgres. Use a versioned S3/R2 bucket in production.                                                                                                           |
| Receipt signing keys | Not in Postgres. Keep an offline copy of the Ed25519 private key.                                                                                                      |
| Redis                | Not in the dump. AOF in compose is local durability only. Treat Redis as ephemeral.                                                                                    |

## Monitoring

`GET /health/live` returns `200` and `{ "status": "ok" }` when the API process can respond. It does not contact PostgreSQL, Redis, Chapa, or SMS.

`GET /health/ready` returns `200` and `{ "status": "ok", "checks": { "database": "ok", "redis": "ok" } }` when both required local dependencies answer within 2 seconds. If either is down or too slow, the response is `503` and `{ "status": "degraded", "checks": { ... } }` with each check set to `ok` or `down`. That means the API should be taken out of rotation: payment routes need Postgres, and rate limits plus queueing need Redis. Chapa and SMS are not part of readiness, because stored invoices, receipts, and sign-in do not require them on every request. The body never includes connection strings, credentials, or the underlying error. The server log says only which check failed and whether it was a timeout or an error.

An unhealthy readiness check does not exit the process. Compose health checks on Postgres (`pg_isready`) and Redis (`redis-cli ping`) describe those containers only. The API image probes `/health/live` with `wget`. The worker image has no HTTP probe, because that process does not listen. Docker's `HEALTHCHECK` and Compose's `restart: unless-stopped` do not restart a container just because a probe fails. Nothing in this repository configures an orchestrator to do that.

Watch these and page a human:

- `/health/ready` returning `503`, or a `database` / `redis` check of `down`
- Queue lag (BullMQ: webhooks, payments, receipts, notifications, outbound)
- `ReconciliationIssue` rows with status `OPEN` (nightly job at 02:30 Africa/Addis_Ababa)
- 5xx rate on web and API
- SMS provider error rate (messages stay in `SmsMessage`)
- Disk/S3 put failures for `receipts/{schoolId}/{receiptNo}.pdf`

Logs must never contain secrets, full phone numbers, TOTP seeds, or card data.

## Go-live checklist

1. Replace every `change-me` secret. Rotate `JWT_ACCESS_SECRET` and `DATA_ENCRYPTION_KEY` if they were ever committed or shared.
2. Generate production Ed25519 keys (`pnpm keys:generate`). Publish the public key at `/.well-known/receipt-keys.json` and in `NEXT_PUBLIC_RECEIPT_PUBLIC_KEYS`. Keep previous keys in `RECEIPT_ADDITIONAL_PUBLIC_KEYS` when rotating.
3. Chapa **live** secret + webhook secret. Register `POST /webhooks/chapa` and the callback URL. Switch `PAYMENT_GATEWAY=chapa`. Confirm mock gateway 404s.
4. Each school: bank subaccount created, status `ACTIVE` only after that succeeds.
5. SMS: AfroMessage or GeezSMS with a registered sender name. Send a real invoice SMS on a test student.
6. SMTP that is not Mailpit. Send a receipt PDF to a real mailbox.
7. Platform admin and every school admin/accountant enrolled in TOTP. Disable unused seed users.
8. Web is the only public hostname. API bound to a private network. TLS everywhere. `NODE_ENV=production`.
9. RLS: connect as `payment_app`, `SELECT set_config('app.school_id', '<other-school-id>', true)` inside a transaction, confirm zero rows.
10. Run `pnpm --filter @payment/api test` and `test:e2e` against a staging database.
11. First nightly reconciliation reviewed. CSV export of receipts for the accountant.
12. Download `/receipts/offline-verifier.html` and keep a copy with the school.

## Tests

```bash
pnpm --filter @payment/shared test
pnpm --filter @payment/api test
pnpm --filter @payment/api test:e2e
pnpm --filter @payment/web typecheck
pnpm test:backup
```
