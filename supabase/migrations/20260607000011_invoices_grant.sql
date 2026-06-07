-- Fix: client transaction history showed "No payments recorded yet" even when
-- approved invoices existed. kaizen_invoices had the RLS read policy
-- (kinv_app_read) but the `authenticated` role was never granted table-level
-- SELECT, so Postgres denied the read before RLS could scope it. Grant SELECT;
-- RLS still restricts rows to the user's own company via kaizen_user_company_ids().
GRANT SELECT ON public.kaizen_invoices TO authenticated;

NOTIFY pgrst, 'reload schema';
