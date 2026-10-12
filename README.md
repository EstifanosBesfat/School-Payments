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

```bash
docker build -f apps/api/Dockerfile -t payment-api .
docker build -f apps/api/Dockerfile --target worker -t payment-worker .
docker build -f apps/web/Dockerfile -t payment-web .
```

Run three processes:

1. **API** — `payment-api` (`RUN_WORKERS=false`)
2. **Worker** — `payment-worker`
3. **Web** — `payment-web`, `API_URL` pointing at the internal API

Apply migrations before traffic: `pnpm db:deploy` using `MIGRATION_DATABASE_URL`.

Storage: local disk is for development. In production set `STORAGE_DRIVER=s3` (Cloudflare R2 or S3) so receipt PDFs survive deploys.

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

Watch these and page a human:

- `/health/live` and `/health/ready` on the API (DB + Redis)
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
