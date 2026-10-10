-- Tenant isolation (Row-Level Security) and tamper-resistance for money records.
--
-- The API connects as the non-owner role `payment_app`, so RLS applies to it. Tenant request
-- paths run inside PrismaService.tenant(), which sets `app.school_id` for the transaction.
-- When the setting is absent (system jobs: webhooks, reconciliation, platform admin) all rows
-- are visible; when present, only that school's rows are visible or writable.

CREATE OR REPLACE FUNCTION app_current_school() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Student', 'Guardian', 'StudentGuardian', 'FeeItem', 'Invoice', 'InvoiceLine',
    'Payment', 'LedgerEntry', 'Receipt', 'ApiKey', 'WebhookEndpoint', 'WebhookDelivery',
    'SmsMessage', 'EmailMessage', 'AuditLog', 'ReconciliationIssue'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_current_school() IS NULL OR "schoolId" = app_current_school()) WITH CHECK (app_current_school() IS NULL OR "schoolId" = app_current_school())',
      t
    );
  END LOOP;
END
$$;

-- Append-only enforcement. These apply to every role, including the owner.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on "%" is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER payment_no_delete
  BEFORE DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER receipt_no_delete
  BEFORE DELETE ON "Receipt"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A signed receipt is immutable; only the rendered PDF location may be filled in later.
CREATE OR REPLACE FUNCTION receipt_only_pdf_key_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'pdfKey') IS DISTINCT FROM (to_jsonb(OLD) - 'pdfKey') THEN
    RAISE EXCEPTION 'Issued receipts are immutable (only "pdfKey" may change)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER receipt_immutable
  BEFORE UPDATE ON "Receipt"
  FOR EACH ROW EXECUTE FUNCTION receipt_only_pdf_key_changes();

-- The application role never needs migration history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_app')
     AND to_regclass('"_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM payment_app;
  END IF;
END
$$;
