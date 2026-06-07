-- Phase 2b: client transaction history + receipt requests.

ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS receipt_requested    boolean NOT NULL DEFAULT false;
ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS receipt_requested_at timestamptz;
ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS receipt_issued       boolean NOT NULL DEFAULT false;
ALTER TABLE kaizen_invoices ADD COLUMN IF NOT EXISTS receipt_issued_at    timestamptz;

-- Let the hotel app read its own company's payment records (transaction history).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'kaizen_invoices' AND policyname = 'kinv_app_read') THEN
    EXECUTE 'CREATE POLICY kinv_app_read ON kaizen_invoices FOR SELECT TO authenticated USING (company_id IN (SELECT kaizen_user_company_ids()))';
  END IF;
END $$;

-- One-time receipt/tax request by the client (Top Management / manager).
CREATE OR REPLACE FUNCTION kaizen_request_receipt(p_invoice uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_company uuid; v_requested boolean;
BEGIN
  SELECT company_id, receipt_requested INTO v_company, v_requested FROM kaizen_invoices WHERE id = p_invoice;
  IF v_company IS NULL THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF v_company NOT IN (SELECT kaizen_user_company_ids()) THEN RAISE EXCEPTION 'Not authorised'; END IF;
  IF NOT EXISTS (SELECT 1 FROM kaizen_profiles p WHERE p.id = auth.uid() AND p.role IN ('super_admin','manager')) THEN
    RAISE EXCEPTION 'Only Top Management or managers can request a receipt';
  END IF;
  IF v_requested THEN RAISE EXCEPTION 'A receipt has already been requested for this transaction'; END IF;
  UPDATE kaizen_invoices SET receipt_requested = true, receipt_requested_at = now() WHERE id = p_invoice;
END $$;

REVOKE EXECUTE ON FUNCTION kaizen_request_receipt(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kaizen_request_receipt(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
