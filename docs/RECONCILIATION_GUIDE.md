# Payment Reconciliation Guide

## Overview

This guide explains how the payment reconciliation system handles the **multi-attempt checkout sync failure** problem, where parents complete payments at Chapa but your school dashboard doesn't reflect the successful payment.

## The Problem

### What Happens

1. A parent opens your school payment link
2. First payment attempt fails (insufficient funds, expired OTP, etc.)
3. Parent clicks "Retry" or "Try Again" inside Chapa's hosted checkout page
4. Payment succeeds on the second attempt at Chapa
5. **Problem**: Your school dashboard still shows "Failed" or "Pending"

### Why It Happens

When a parent retries inside Chapa's checkout page:
- Chapa may create a new internal transaction reference
- The webhook from Chapa might reference the wrong transaction ID
- Your system loses track of the successful payment
- Chapa has the money, but your database doesn't know about it

## Automated Solutions (Already Running)

### 1. 5-Minute Sweep Worker ✅

**What it does:**
- Runs every 5 minutes automatically
- Checks all `PENDING` payments older than 10 minutes
- Checks all `FAILED` payments that might succeed on retry (within 30-minute window)
- Calls Chapa's API directly to verify the true status
- Updates your database to match Chapa's records
- Automatically settles successful payments

**Location:** `apps/api/src/reconciliation/reconciliation.service.ts` → `sweepPending()`

**Cron schedule:** `*/5 * * * *` (every 5 minutes)

**What it processes:**
```sql
-- Stale pending payments
SELECT * FROM "Payment" 
WHERE status = 'PENDING' 
  AND "createdAt" < NOW() - INTERVAL '10 minutes'
LIMIT 500;

-- Failed payments that might succeed on retry
SELECT * FROM "Payment" 
WHERE status = 'FAILED' 
  AND "failureReason" = 'gateway_reported_failed'
  AND "createdAt" > NOW() - INTERVAL '30 minutes'
LIMIT 500;
```

### 2. Nightly Full Reconciliation ✅

**What it does:**
- Runs every night at 2:30 AM (Africa/Addis_Ababa timezone)
- Fetches all transactions from Chapa (last 3 days)
- Compares Chapa's records with your database
- Creates `ReconciliationIssue` records for mismatches
- Automatically fixes issues where possible

**Location:** `apps/api/src/reconciliation/reconciliation.service.ts` → `run()`

**Cron schedule:** `30 2 * * *` (2:30 AM daily)

**Issue types detected:**
- `status_mismatch`: Chapa shows success, you show failed/pending
- `gateway_tx_unknown`: Transaction exists at Chapa but not in your database
- `amount_mismatch`: Payment amounts don't match
- `missing_at_gateway`: You show success but Chapa doesn't have it
- `receipt_chain_broken`: Receipt blockchain integrity issue

### 3. Distributed Lock Mechanism ✅

**What it does:**
- Prevents duplicate processing of the same payment
- Uses Redis locks with 10-second TTL
- Ensures webhooks and sweep workers don't conflict

**Location:** `apps/api/src/payments/payment-lock.service.ts`

## Manual Solutions (When Automated Fails)

### Scenario: Parent Says "I Was Charged But Dashboard Shows Unpaid"

#### Step 1: Ask Parent for Proof
Ask the parent to provide:
- Screenshot of bank statement showing deduction
- SMS from bank showing transaction
- Chapa reference number (if they have it)

#### Step 2: Check Chapa Dashboard
1. Log into your Chapa merchant dashboard
2. Go to Transactions
3. Search for the transaction by:
   - Student name
   - Amount
   - Date
   - Phone number
4. Copy the **Transaction Reference** (starts with `CHK-` or similar)

#### Step 3: Use "Attach Payment" Feature
1. In your school dashboard, go to the student's invoice
2. Click **"Attach External Payment"** button
3. Paste the Chapa transaction reference
4. Click **"Verify and Attach"**

**What happens:**
- System calls Chapa API to verify the transaction
- Checks that amount and currency match the invoice
- Creates a payment record in your database
- Marks invoice as paid
- Issues receipt automatically
- Sends SMS confirmation to parent

**Location:** `apps/api/src/payments/payments.service.ts` → `attachVerifiedTransaction()`

#### Step 4: Document the Issue
After attaching the payment:
1. Go to **Dashboard → Reconciliation**
2. Find the reconciliation issue (if one was created)
3. Click **"Mark as Resolved"**
4. Add note: "Manually attached after retry loop. Parent reference: [reference]. Date resolved: [date]"

## Monitoring and Alerts

### What to Monitor

1. **Reconciliation Issues Count**
   - Dashboard → Reconciliation
   - Filter: Status = OPEN
   - **Alert if**: More than 10 OPEN issues

2. **Sweep Worker Status**
   - Check logs for: "Pending sweep queued X verifications"
   - **Alert if**: No sweep logs for 10+ minutes

3. **Queue Lag**
   - Check BullMQ dashboard (if enabled)
   - Queue: `maintenance`
   - **Alert if**: Jobs waiting > 5 minutes

### Expected Metrics (Normal Operation)

- **Sweep runs**: Every 5 minutes
- **Typical queued verifications**: 0-5 per sweep
- **Reconciliation issues**: 0-3 per day
- **Settled late**: 0-2 per nightly run

### Red Flags

- ⚠️ Sweep worker hasn't run in 10+ minutes
- ⚠️ More than 10 OPEN reconciliation issues
- ⚠️ Same payment failing verification repeatedly
- ⚠️ Amount mismatches (indicates wrong invoice or fraud)

## Configuration Check

### Verify Workers Are Running

Check your `.env` file:
```bash
# This should be true (or omitted, defaults to true)
RUN_WORKERS=true
```

### Check Logs

Development:
```bash
# In the API logs, you should see:
# - "Started 6 queue workers"
# - "Pending sweep queued X verifications" (every 5 minutes)
# - "Reconciliation run-id: checked X, issues Y" (nightly)
```

Production:
```bash
# Check logs in your logging service
grep "Pending sweep" /var/log/payment-api.log
grep "Reconciliation" /var/log/payment-api.log
```

## Training Staff

### For School Cashiers

**When a parent says "I paid but it's not showing":**

1. ✅ **DO**: Ask for proof (bank SMS screenshot)
2. ✅ **DO**: Check Chapa dashboard first
3. ✅ **DO**: Use "Attach Payment" if transaction exists at Chapa
4. ✅ **DO**: Document in reconciliation notes
5. ❌ **DON'T**: Create a manual receipt without verifying at Chapa
6. ❌ **DON'T**: Ask parent to pay again without checking Chapa first

### For Platform Admins

**Daily checklist:**
- [ ] Check reconciliation dashboard for OPEN issues
- [ ] Review yesterday's nightly reconciliation report
- [ ] Verify sweep worker is running (check recent logs)
- [ ] Resolve any `status_mismatch` issues within 24 hours

## Technical Details

### Payment Status Flow

```
PENDING → (verification) → SUCCEEDED → (receipt issued)
   ↓                           ↓
FAILED                     REFUNDED
   ↓
REVIEW (manual intervention needed)
```

### Verification Sources

1. **Webhook** (real-time, preferred)
   - Chapa sends webhook immediately
   - Signed with `CHAPA_WEBHOOK_SECRET`
   - May fail due to network issues

2. **Sweep Worker** (5-minute polling, backup)
   - Calls `GET /transaction/verify/{txRef}`
   - Bypasses broken webhook trail
   - Catches payments stuck as PENDING or FAILED

3. **Manual Verification** (on-demand)
   - Staff-initiated via "Attach Payment"
   - Uses same `verify` API call
   - For unknown transaction references

### Lock Mechanism

```typescript
// Prevents race conditions
const lock = await redis.set(
  `payment-lock:${txRef}`, 
  'locked', 
  'NX', // Only if not exists
  'PX', // Expire in milliseconds
  10000 // 10 seconds
);

if (!lock) {
  // Another process is handling this payment
  return HTTP 409 Conflict;
}
```

## Troubleshooting

### Issue: Sweep Worker Not Running

**Symptoms:**
- Payments stuck as PENDING for hours
- No "Pending sweep" logs

**Diagnosis:**
```bash
# Check environment
grep RUN_WORKERS .env

# Check logs
docker logs payment-api | grep "Started.*queue workers"
```

**Solution:**
1. Ensure `RUN_WORKERS=true` in `.env`
2. Restart API service
3. Verify Redis is accessible

### Issue: Payment Verified But Receipt Not Issued

**Symptoms:**
- Payment status = SUCCEEDED
- No receipt record

**Diagnosis:**
```sql
SELECT * FROM "Payment" 
WHERE status = 'SUCCEEDED' 
  AND "succeededAt" < NOW() - INTERVAL '10 minutes'
  AND id NOT IN (SELECT "paymentId" FROM "Receipt");
```

**Solution:**
- Nightly reconciliation automatically re-queues missing receipts
- Or manually trigger: POST `/api/internal/receipts/requeue`

### Issue: Amount Mismatch

**Symptoms:**
- Reconciliation issue with kind = `amount_mismatch`
- Payment status = REVIEW

**Diagnosis:**
```sql
SELECT * FROM "Payment" 
WHERE status = 'REVIEW' 
  AND "reviewReason" LIKE 'amount_mismatch%';
```

**Solution:**
1. Check Chapa dashboard for actual amount charged
2. Check invoice for expected amount
3. If amounts truly differ:
   - Investigate possible fraud
   - Issue partial refund if overpaid
   - Request additional payment if underpaid
4. Document in audit log

## API Endpoints

### For Platform Admins

```bash
# Trigger reconciliation manually
POST /api/reconciliation/run
Authorization: Bearer <platform_admin_token>

# List reconciliation issues
GET /api/reconciliation/issues?status=OPEN&page=1&pageSize=25
Authorization: Bearer <staff_token>

# Resolve an issue
POST /api/reconciliation/issues/:issueId/resolve
Authorization: Bearer <staff_token>
Content-Type: application/json
{
  "note": "Manually verified with Chapa support. Transaction was duplicate webhook delivery."
}
```

### For School Staff

```bash
# Attach external payment
POST /api/schools/:schoolId/payments/attach
Authorization: Bearer <school_staff_token>
Content-Type: application/json
{
  "invoiceId": "clx123abc",
  "txRef": "CHK_20261022_ABC123",
  "note": "Parent retry loop payment"
}
```

## Best Practices

1. ✅ **Let automated reconciliation run first** (wait 5-10 minutes after payment)
2. ✅ **Check reconciliation dashboard daily**
3. ✅ **Document all manual interventions**
4. ✅ **Train staff on "Attach Payment" workflow**
5. ✅ **Monitor sweep worker health**
6. ✅ **Review nightly reconciliation reports**
7. ❌ **Don't create manual receipts without verification**
8. ❌ **Don't ask parents to pay twice without checking Chapa**

## Support Escalation

### Level 1: School Staff
- Check if payment appears in Chapa dashboard
- Use "Attach Payment" if found
- Document in reconciliation notes

### Level 2: Platform Admin
- Review reconciliation issues
- Check sweep worker logs
- Verify Redis and database connectivity
- Contact Chapa support if needed

### Level 3: Developer
- Investigate sweep worker failure
- Check for API changes from Chapa
- Review error logs for verification failures
- Deploy hotfix if needed

## Success Metrics

A well-functioning reconciliation system should have:

- **< 5% payments** requiring manual intervention
- **< 10 minutes** average time to detect and fix sync issues
- **0 double payments** (prevented by idempotency and locks)
- **100% accuracy** between Chapa records and your database (after nightly run)

---

**Last Updated:** 2026-10-22  
**Document Owner:** Platform Engineering Team
