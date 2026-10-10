# School Payments (Ethiopia)

Multi-school SaaS for collecting fees over a **licensed Ethiopian gateway** (Chapa first). The platform never holds funds: each school registers a subaccount, and Chapa splits the payment so tuition lands in the school’s bank account.

Parents pay from an SMS link (telebirr, CBE Birr, M-Pesa, card). Every successful payment produces an **Ed25519-signed receipt** with a QR code that still verifies offline.

## Layout

| Path | Role |
| --- | --- |
| `apps/web` | Next.js 16 BFF. Session cookies stay httpOnly. Talks to the API over HTTP only. |
| `apps/api` | NestJS 11. Database, gateway, SMS, email, storage, workers. |
| `packages/db` | Prisma **7** schema, migrations, seed. |
| `packages/shared` | Zod schemas, money (integer santim), receipt canonicalization, phone helpers. |

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
- `apps/web` is the only public origin. The API sets `trust proxy 1` and trusts `X-Forwarded-For` from that hop.
- **In production the API must not be reachable from the internet.** Put it behind the web app or a load balancer that strips incoming `X-Forwarded-For` and sets it itself. If clients can hit the API directly they can spoof client IPs used for rate limits and audit logs.

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

| What | How |
| --- | --- |
| Postgres | Nightly `pg_dump` of the `payment` database (owner role). Retain at least 30 days. Test restore on a copy. |
| Receipt PDFs | Versioned S3/R2 bucket with object lock or versioning. |
| Receipt signing keys | Offline copy of the Ed25519 private key. Losing it means new receipts cannot be issued with that key id; old receipts still verify with the published public key. |
| Redis | AOF is enabled in compose. Treat Redis as ephemeral: jobs retry, but do not store the only copy of money data there. |

Point-in-time recovery: enable Postgres WAL archiving (or your host’s PITR) before going live.

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
9. RLS: connect as `payment_app`, `SET app.current_school` to a foreign id, confirm zero rows.
10. Run `pnpm --filter @payment/api test` and `test:e2e` against a staging database.
11. First nightly reconciliation reviewed. CSV export of receipts for the accountant.
12. Download `/receipts/offline-verifier.html` and keep a copy with the school.

## Tests

```bash
pnpm --filter @payment/shared test
pnpm --filter @payment/api test
pnpm --filter @payment/api test:e2e
pnpm --filter @payment/web typecheck
```
