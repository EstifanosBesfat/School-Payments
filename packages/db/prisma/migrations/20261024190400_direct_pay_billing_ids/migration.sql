-- Direct-pay billing ids. billRef is a frozen copy of the invoice number, which already
-- embeds the school code, so retries keep one public id. The partial unique index and the
-- immutability trigger are not represented in schema.prisma.

ALTER TABLE "Invoice" ADD COLUMN "billRef" TEXT;

UPDATE "Invoice" SET "billRef" = "number" WHERE "billRef" IS NULL;

ALTER TABLE "Invoice" ALTER COLUMN "billRef" SET NOT NULL;
CREATE UNIQUE INDEX "Invoice_billRef_key" ON "Invoice"("billRef");

CREATE OR REPLACE FUNCTION forbid_bill_ref_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."billRef" IS DISTINCT FROM OLD."billRef" THEN
    RAISE EXCEPTION 'Invoice billRef is immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invoice_bill_ref_immutable
  BEFORE UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION forbid_bill_ref_change();

ALTER TABLE "Payment" ADD COLUMN "gatewaySessionId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "sessionExpiresAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "payerMethod" TEXT;
CREATE UNIQUE INDEX "Payment_gatewaySessionId_key" ON "Payment"("gatewaySessionId");
CREATE UNIQUE INDEX "payment_one_pending_per_invoice" ON "Payment"("invoiceId") WHERE "status" = 'PENDING';

ALTER TABLE "School" ADD COLUMN "payoutBankCode" TEXT;
ALTER TABLE "School" ADD COLUMN "payoutAccountEncrypted" TEXT;

ALTER TABLE "WebhookEvent" ADD COLUMN "sessionId" TEXT;
CREATE INDEX "WebhookEvent_sessionId_idx" ON "WebhookEvent"("sessionId");
