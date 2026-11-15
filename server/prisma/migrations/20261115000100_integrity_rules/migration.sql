-- Database-level integrity rules that hold no matter which code path (or person) writes to the tables.

-- 1. Sanity checks on monetary columns ------------------------------------------------------------
ALTER TABLE "JournalEntryLine"
  ADD CONSTRAINT "JournalEntryLine_amounts_check"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND NOT ("debit" > 0 AND "credit" > 0) AND ("debit" > 0 OR "credit" > 0));

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_amounts_check"
  CHECK ("amount" >= 0 AND "taxAmount" >= 0 AND "totalAmount" >= 0 AND "amountPaid" >= 0 AND "amountPaid" <= "totalAmount");

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_amounts_check"
  CHECK ("total" >= 0 AND "amountPaid" >= 0 AND "amountPaid" <= "total");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amounts_check"
  CHECK ("amount" > 0 AND "fee" >= 0 AND "fee" <= "amount" AND "refundedAmount" >= 0 AND "refundedAmount" <= "amount");

ALTER TABLE "AccountTransaction"
  ADD CONSTRAINT "AccountTransaction_amount_check" CHECK ("amount" > 0);

-- 2. Double entry: every journal entry must balance when the transaction commits ---------------------
CREATE OR REPLACE FUNCTION cas_check_journal_balance() RETURNS trigger AS $$
DECLARE
  entry_id text;
  total_debit numeric;
  total_credit numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    entry_id := OLD."journalEntryId";
  ELSE
    entry_id := NEW."journalEntryId";
  END IF;
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0)
    INTO total_debit, total_credit
    FROM "JournalEntryLine" WHERE "journalEntryId" = entry_id;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debits % <> credits %)', entry_id, total_debit, total_credit
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "JournalEntryLine_balance"
  AFTER INSERT OR UPDATE OR DELETE ON "JournalEntryLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cas_check_journal_balance();

-- 3. The ledger and the audit trail are append-only ---------------------------------------------
CREATE OR REPLACE FUNCTION cas_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalEntryLine_immutable"
  BEFORE UPDATE OR DELETE ON "JournalEntryLine"
  FOR EACH ROW EXECUTE FUNCTION cas_forbid_change();

CREATE TRIGGER "JournalEntry_immutable"
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION cas_forbid_change();

CREATE TRIGGER "AuditLog_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION cas_forbid_change();
