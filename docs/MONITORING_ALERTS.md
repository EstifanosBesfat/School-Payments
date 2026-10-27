# Monitoring and Alert Configuration

## Health Check Endpoints

### 1. `/health/live`
- **Purpose**: Process liveness check
- **Response Time**: < 50ms
- **Dependencies**: None (always returns 200)
- **Use For**: Kubernetes liveness probe

### 2. `/health/ready`
- **Purpose**: Service readiness check
- **Response Time**: < 2 seconds
- **Dependencies**: PostgreSQL, Redis
- **Use For**: Kubernetes readiness probe, load balancer health checks
- **Alert On**: Returns 503 for > 1 minute

### 3. `/health/workers` ⭐ NEW
- **Purpose**: Background worker and reconciliation health
- **Response Time**: < 5 seconds
- **Dependencies**: PostgreSQL (queries reconciliation tables)
- **Use For**: Detecting multi-attempt checkout sync failures
- **Alert On**: Returns 503 or `status: 'critical'`

## Alert Rules

### Critical Alerts (Page On-Call Engineer)

#### 1. Sweep Worker Stalled
```yaml
Alert: SweepWorkerStalled
Query: health_workers_status == "critical" AND stalePending_count > 10
Duration: 15 minutes
Severity: Critical
Message: |
  Sweep worker has not processed stale pending payments.
  {{ stalePending_count }} payments stuck in PENDING status for over 1 hour.
  
  Parents may have been charged at Chapa but school dashboard shows unpaid.
  
  Impact: Manual intervention required for each affected payment.
  
  Action:
  1. Check API logs: grep "Pending sweep" /var/log/payment-api.log
  2. Verify RUN_WORKERS=true in environment
  3. Check Redis connectivity
  4. Restart API service if needed
  5. Manually trigger: POST /api/reconciliation/run (platform admin)

Runbook: https://docs.yourplatform.com/runbooks/sweep-worker-stalled
```

#### 2. High Reconciliation Issues
```yaml
Alert: HighReconciliationIssues
Query: health_workers_openIssues_count > 20
Duration: 30 minutes
Severity: Critical
Message: |
  {{ openIssues_count }} open reconciliation issues detected.
  
  This indicates payment discrepancies between Chapa and your database.
  Common causes:
  - Parents completing payments via Chapa retry loop
  - Webhook delivery failures
  - Chapa API issues
  
  Action:
  1. Review dashboard: /dashboard/reconciliation
  2. Check for patterns (same school, same time period)
  3. Verify Chapa webhook endpoint is accessible
  4. Contact Chapa support if widespread issue

Dashboard: https://app.yourplatform.com/dashboard/reconciliation
```

#### 3. Reconciliation Job Failed
```yaml
Alert: ReconciliationJobFailed
Query: health_workers_lastReconciliation_status == "critical" AND lastReconciliation_lastError != null
Duration: immediate
Severity: Critical
Message: |
  Nightly reconciliation job failed with error.
  
  Error: {{ lastReconciliation_lastError }}
  
  Impact: Payment discrepancies may go undetected until next successful run.
  
  Action:
  1. Check full error in database: 
     SELECT * FROM "ReconciliationRun" ORDER BY "startedAt" DESC LIMIT 1;
  2. Review API logs during reconciliation window (2:30 AM)
  3. Check Chapa API connectivity
  4. Manually trigger: POST /api/reconciliation/run
  5. If error persists, escalate to development team

Logs: Check logs from 02:30-03:00 Africa/Addis_Ababa
```

### Warning Alerts (Notify Team Channel)

#### 4. Elevated Pending Payments
```yaml
Alert: ElevatedPendingPayments
Query: health_workers_stalePending_count > 5 AND <= 10
Duration: 30 minutes
Severity: Warning
Message: |
  {{ stalePending_count }} payments stuck in PENDING for over 1 hour.
  
  Sweep worker is running but payments are not settling.
  Possible causes:
  - Chapa API slow to respond
  - Network issues between API and Chapa
  - Unusual payment gateway behavior
  
  Action:
  1. Monitor for increase (becomes critical at 10+)
  2. Check Chapa status page
  3. Review individual payments in dashboard
  4. Consider manual intervention if count continues to grow

Dashboard: /dashboard/payments?status=PENDING
```

#### 5. Reconciliation Overdue
```yaml
Alert: ReconciliationOverdue
Query: health_workers_lastReconciliation_hoursAgo > 30
Duration: immediate
Severity: Warning
Message: |
  Nightly reconciliation has not run in {{ lastReconciliation_hoursAgo }} hours.
  
  Expected to run daily at 2:30 AM Africa/Addis_Ababa.
  
  Action:
  1. Check if RUN_WORKERS=true
  2. Verify cron job is scheduled in Redis
  3. Check API logs for errors during scheduled time
  4. Manually trigger if needed: POST /api/reconciliation/run

Last Run: {{ lastReconciliation_hoursAgo }} hours ago
```

#### 6. Growing Reconciliation Issues
```yaml
Alert: GrowingReconciliationIssues
Query: rate(health_workers_openIssues_count[1h]) > 5
Duration: 1 hour
Severity: Warning
Message: |
  Reconciliation issues increasing rapidly.
  Rate: {{ rate }} new issues per hour
  
  This pattern suggests:
  - Webhook delivery problems
  - Parent retry loop pattern
  - Chapa API returning inconsistent data
  
  Action:
  1. Check recent issues: /dashboard/reconciliation?status=OPEN
  2. Look for common patterns (same school, timeframe)
  3. Verify webhook endpoint is receiving requests
  4. Check Chapa dashboard for transaction volume anomalies

Dashboard: /dashboard/reconciliation
```

## Monitoring Setup Examples

### Prometheus

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'payment-api-workers'
    scrape_interval: 60s
    metrics_path: '/health/workers'
    static_configs:
      - targets: ['api.yourplatform.com:4000']
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: 'health_workers_.*'
        action: keep
```

### Datadog

```python
# datadog_check.py
from datadog import api, initialize
import requests

initialize()

def check_worker_health():
    response = requests.get('https://api.yourplatform.com/health/workers')
    data = response.json()
    
    # Send metrics
    api.Metric.send(
        metric='payment.workers.status',
        points=1 if data['status'] == 'ok' else 0
    )
    api.Metric.send(
        metric='payment.workers.open_issues',
        points=data['checks']['openIssues']['count']
    )
    api.Metric.send(
        metric='payment.workers.stale_pending',
        points=data['checks']['stalePending']['count']
    )
    
    # Send alert if critical
    if data['status'] == 'critical':
        api.Event.create(
            title='Payment Worker Health Critical',
            text=f"Worker health check failed: {data}",
            alert_type='error',
            tags=['payment', 'workers', 'critical']
        )
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Payment Reconciliation Health",
    "panels": [
      {
        "title": "Open Reconciliation Issues",
        "targets": [{
          "expr": "health_workers_openIssues_count",
          "legendFormat": "Open Issues"
        }],
        "thresholds": [
          { "value": 10, "color": "yellow" },
          { "value": 20, "color": "red" }
        ]
      },
      {
        "title": "Stale Pending Payments",
        "targets": [{
          "expr": "health_workers_stalePending_count",
          "legendFormat": "Stale Payments"
        }],
        "thresholds": [
          { "value": 5, "color": "yellow" },
          { "value": 10, "color": "red" }
        ]
      },
      {
        "title": "Last Reconciliation",
        "targets": [{
          "expr": "health_workers_lastReconciliation_hoursAgo",
          "legendFormat": "Hours Since Last Run"
        }],
        "thresholds": [
          { "value": 30, "color": "yellow" },
          { "value": 45, "color": "red" }
        ]
      }
    ]
  }
}
```

### PagerDuty Integration

```bash
#!/bin/bash
# check-workers-health.sh
# Run this script every minute via cron

HEALTH_URL="https://api.yourplatform.com/health/workers"
PAGERDUTY_KEY="your-integration-key"

response=$(curl -s "$HEALTH_URL")
status=$(echo "$response" | jq -r '.status')

if [ "$status" == "critical" ]; then
  # Trigger PagerDuty incident
  curl -X POST https://events.pagerduty.com/v2/enqueue \
    -H 'Content-Type: application/json' \
    -d @- <<EOF
{
  "routing_key": "$PAGERDUTY_KEY",
  "event_action": "trigger",
  "payload": {
    "summary": "Payment Worker Health Critical",
    "severity": "critical",
    "source": "payment-api",
    "custom_details": $response
  }
}
EOF
fi
```

## Healthcheck Response Examples

### Normal Operation
```json
{
  "status": "ok",
  "checks": {
    "openIssues": {
      "status": "ok",
      "count": 2,
      "threshold": 10
    },
    "stalePending": {
      "status": "ok",
      "count": 0,
      "threshold": 5
    },
    "lastReconciliation": {
      "status": "ok",
      "hoursAgo": 12,
      "threshold": 30,
      "lastError": null
    }
  },
  "timestamp": "2026-10-22T14:30:00.000Z"
}
```

### Degraded (Warning)
```json
{
  "status": "degraded",
  "checks": {
    "openIssues": {
      "status": "warn",
      "count": 12,
      "threshold": 10
    },
    "stalePending": {
      "status": "ok",
      "count": 3,
      "threshold": 5
    },
    "lastReconciliation": {
      "status": "ok",
      "hoursAgo": 18,
      "threshold": 30,
      "lastError": null
    }
  },
  "timestamp": "2026-10-22T14:30:00.000Z"
}
```

### Critical (Alert)
```json
{
  "status": "critical",
  "checks": {
    "openIssues": {
      "status": "critical",
      "count": 25,
      "threshold": 10
    },
    "stalePending": {
      "status": "critical",
      "count": 15,
      "threshold": 5
    },
    "lastReconciliation": {
      "status": "warn",
      "hoursAgo": 32,
      "threshold": 30,
      "lastError": null
    }
  },
  "timestamp": "2026-10-22T14:30:00.000Z"
}
```

## Daily Checklist

### Morning Review (Platform Admin)
- [ ] Check `/health/workers` endpoint
- [ ] Review yesterday's reconciliation run
- [ ] Check open issues: `/dashboard/reconciliation?status=OPEN`
- [ ] Verify no stale pending payments > 24 hours old

### Weekly Review
- [ ] Export reconciliation issues as CSV
- [ ] Analyze patterns (which schools, which times)
- [ ] Review webhook delivery success rate
- [ ] Check Chapa API response times

### Monthly Review
- [ ] Calculate payment success rate
- [ ] Measure average time to settle pending payments
- [ ] Count manual interventions required
- [ ] Review alert false positive rate

## Troubleshooting Commands

```bash
# Check worker health
curl https://api.yourplatform.com/health/workers | jq

# Count stale pending payments
psql $DATABASE_URL -c "SELECT COUNT(*) FROM \"Payment\" WHERE status='PENDING' AND \"createdAt\" < NOW() - INTERVAL '1 hour';"

# List open reconciliation issues
psql $DATABASE_URL -c "SELECT kind, COUNT(*) FROM \"ReconciliationIssue\" WHERE status='OPEN' GROUP BY kind;"

# Check last reconciliation run
psql $DATABASE_URL -c "SELECT * FROM \"ReconciliationRun\" ORDER BY \"startedAt\" DESC LIMIT 1;"

# Manually trigger reconciliation (requires platform admin token)
curl -X POST https://api.yourplatform.com/api/reconciliation/run \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Check BullMQ queue status
redis-cli -u $REDIS_URL ZRANGE bull:maintenance:repeat 0 -1
```

---

**Last Updated:** 2026-10-22  
**Document Owner:** Platform Operations Team
