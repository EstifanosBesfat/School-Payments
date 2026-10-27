# Webhook Retry Strategy

## Overview

The payment system uses BullMQ for reliable webhook processing with exponential backoff. This ensures that temporary failures (network issues, API timeouts, database locks) don't result in lost payment confirmations.

## Current Configuration

### Default Job Options
```typescript
{
  attempts: 6,                                  // Total attempts (1 initial + 5 retries)
  backoff: { 
    type: 'exponential', 
    delay: 5000                                 // Base delay: 5 seconds
  },
  removeOnComplete: { 
    count: 2000,                                // Keep last 2000 successful jobs
    age: 7 * 24 * 3600                          // For 7 days
  },
  removeOnFail: { 
    count: 10000                                // Keep last 10,000 failed jobs
  },
}
```

### Retry Schedule

With exponential backoff starting at 5 seconds:

| Attempt | Delay | Time Since First Attempt |
|---------|-------|--------------------------|
| 1       | 0s    | 0s (initial)            |
| 2       | 5s    | 5s                      |
| 3       | 10s   | 15s                     |
| 4       | 20s   | 35s                     |
| 5       | 40s   | 1m 15s                  |
| 6       | 80s   | 2m 35s                  |

**Total retry window**: ~2.5 minutes

After 6 failed attempts, the webhook event is marked as permanently failed and requires manual investigation.

## Queue Concurrency

```typescript
{
  webhooks: 10,       // Process up to 10 webhook events in parallel
  payments: 10,       // Process up to 10 payment verifications in parallel
  receipts: 4,        // Serialize receipt generation (PDF rendering)
  notifications: 10,  // SMS/Email sending
  outbound: 10,       // Outbound webhook deliveries to schools
  maintenance: 1,     // Serialize reconciliation and cleanup jobs
}
```

## Failure Scenarios and Handling

### 1. Temporary Network Failure
**Symptom**: Connection timeout to Chapa API  
**Retry Behavior**: Exponential backoff retries  
**Expected Resolution**: Succeeds on retry 2-3  
**Fallback**: Sweep worker picks it up within 5 minutes  

### 2. Database Lock Conflict
**Symptom**: `ConflictException` - payment already being verified  
**Retry Behavior**: Job fails fast, not retried  
**Expected Resolution**: Immediate (other process completes verification)  
**Fallback**: None needed (success handled by winning process)  

### 3. Gateway API Rate Limit
**Symptom**: 429 Too Many Requests from Chapa  
**Retry Behavior**: Exponential backoff with increasing delays  
**Expected Resolution**: Succeeds after rate limit window expires  
**Fallback**: Sweep worker retries after 5 minutes  

### 4. Invalid Signature
**Symptom**: `UnauthorizedException` - signature validation failed  
**Retry Behavior**: Job fails fast, not retried (security violation)  
**Expected Resolution**: None (webhook is rejected)  
**Fallback**: Sweep worker verifies directly via API  

### 5. Payment Verification Still Pending
**Symptom**: `GatewaySuccessUnconfirmedError` - Chapa API still shows pending  
**Retry Behavior**: Retries with exponential backoff  
**Expected Resolution**: Succeeds when Chapa confirms transaction  
**Fallback**: Sweep worker continues verification attempts  

## Monitoring Webhook Failures

### Check Failed Webhook Jobs

```bash
# Connect to Redis
redis-cli -u $REDIS_URL

# List failed webhook jobs
ZRANGE bull:gateway-webhooks:failed 0 -1 WITHSCORES

# Get failed job details
GET bull:gateway-webhooks:{job-id}
```

### Query Failed Webhook Events

```sql
-- Find webhook events that failed processing
SELECT 
  id, 
  "gatewayName", 
  "eventType", 
  status, 
  "receivedAt",
  "processedAt",
  error
FROM "WebhookEvent"
WHERE status = 'FAILED'
ORDER BY "receivedAt" DESC
LIMIT 50;
```

### Alert Thresholds

**Warning**: > 5 failed webhook events in last hour  
**Critical**: > 20 failed webhook events in last hour  
**Action**: Investigate Chapa API status, check network connectivity  

## Webhook Event Lifecycle

```
1. Chapa sends webhook → POST /webhooks/:gateway
2. Signature validation
3. Lock acquisition (prevents duplicate processing)
4. Event persisted to WebhookEvent table
5. Job enqueued to 'gateway-webhooks' queue
6. HTTP 200 returned to Chapa (fast acknowledgment)

... (async processing) ...

7. Worker picks up job
8. Calls PaymentsService.verifyAndSettle()
9. Updates payment status, issues receipt
10. If fails: retry with exponential backoff
11. If succeeds: mark WebhookEvent as PROCESSED
12. If fails 6 times: mark WebhookEvent as FAILED
```

## Idempotency Guarantees

### Event Key
Each webhook event generates a deterministic `eventKey`:
```typescript
const eventKey = sha256(`${txRef}:${eventType}:${timestamp}`);
```

This prevents duplicate processing of the same webhook event, even if Chapa sends it multiple times.

### Payment Lock
The `txRef` is locked during verification using Redis NX (set-if-not-exists):
```typescript
await redis.set(`payment-lock:${txRef}`, 'locked', 'NX', 'PX', 10000);
```

This prevents:
- Multiple webhook deliveries from processing simultaneously
- Webhook and sweep worker from conflicting
- Race conditions during payment settlement

### Database Constraints
- `Payment.txRef` is unique (prevents duplicate payment records)
- `Payment.gatewayReference` is unique (prevents duplicate settlements)
- `WebhookEvent.eventKey` is unique (prevents duplicate event storage)

## Enhanced Retry Configuration (Optional)

For production environments with higher reliability requirements:

```typescript
// Longer retry window with more attempts
const PRODUCTION_JOB_OPTIONS: JobsOptions = {
  attempts: 10,                                  // More attempts
  backoff: { 
    type: 'exponential', 
    delay: 10000                                 // Start with 10 seconds
  },
  removeOnComplete: { 
    count: 5000,                                 // Keep more history
    age: 14 * 24 * 3600                          // 14 days
  },
  removeOnFail: { 
    count: 20000                                 // Keep more failed jobs
  },
};
```

This extends the retry window to ~15 minutes with delays up to 2.5 minutes between attempts.

## Best Practices

1. ✅ **Monitor webhook failure rate** - Alert when > 5% of webhooks fail
2. ✅ **Keep Chapa webhook URL accessible** - No firewall blocking
3. ✅ **Rotate webhook secrets regularly** - Update `CHAPA_WEBHOOK_SECRET`
4. ✅ **Review failed webhooks weekly** - Identify patterns
5. ✅ **Test webhook endpoint in staging** - Use Chapa test mode
6. ✅ **Document webhook failures** - Add to runbook
7. ❌ **Don't block webhook endpoint** - Fast ack, async processing
8. ❌ **Don't skip signature validation** - Security first

## Troubleshooting

### High Webhook Failure Rate

**Symptoms**: > 10% of webhooks failing  

**Diagnostic Steps**:
1. Check Chapa status page: https://status.chapa.co
2. Verify webhook URL is accessible: `curl -I https://api.yourplatform.com/webhooks/chapa`
3. Check API logs for error patterns
4. Verify Redis connectivity
5. Check database connection pool

**Common Fixes**:
- Increase database connection pool size
- Scale up API instances
- Contact Chapa support for API issues

### Webhooks Not Being Processed

**Symptoms**: Payments stuck as PENDING, no webhook processing logs  

**Diagnostic Steps**:
1. Check if `RUN_WORKERS=true` in environment
2. Verify workers started: Look for "Started 6 queue workers" in logs
3. Check Redis connection
4. Verify BullMQ queue exists: `redis-cli KEYS bull:gateway-webhooks:*`

**Common Fixes**:
- Restart API service
- Check Redis connectivity
- Verify BullMQ configuration

### Webhooks Failing Signature Validation

**Symptoms**: Many `UnauthorizedException` errors in logs  

**Diagnostic Steps**:
1. Verify `CHAPA_WEBHOOK_SECRET` matches Chapa dashboard
2. Check if webhook secret was recently rotated
3. Confirm header name: `x-chapa-signature` or `chapa-signature`

**Common Fixes**:
- Update `CHAPA_WEBHOOK_SECRET` to match Chapa dashboard
- Redeploy API with correct secret
- Contact Chapa support to verify webhook configuration

## Related Documentation

- [Reconciliation Guide](./RECONCILIATION_GUIDE.md) - Handling multi-attempt checkout failures
- [Monitoring Alerts](./MONITORING_ALERTS.md) - Alert configuration
- [Chapa Webhook Documentation](https://developer.chapa.co/docs/webhooks) - Official Chapa docs

---

**Last Updated**: 2026-10-22  
**Document Owner**: Platform Engineering Team
