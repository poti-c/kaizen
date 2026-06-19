-- Phase 3 security fixes

-- I18-001: Fix push subscription INSERT policy to require user_id = auth.uid().
-- The previous policy only checked auth.uid() IS NOT NULL, allowing any authenticated
-- user to register a push subscription under any other user's ID.
DROP POLICY IF EXISTS "kzn_push_insert" ON kaizen_push_subscriptions;
CREATE POLICY "kzn_push_insert" ON kaizen_push_subscriptions
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- KAI-004: Prevent concurrent slip-free submission duplicates with a partial unique index.
-- The existing dedup check uses maybeSingle() which silently discards on multiple matches,
-- and two concurrent requests can both pass the check before either inserts. The index
-- raises a unique violation on the second insert; the code catches it and returns duplicate:true.
CREATE UNIQUE INDEX IF NOT EXISTS kps_slip_free_pending_uidx
  ON kaizen_payment_submissions (company_id, kind, target)
  WHERE proof_hash IS NULL AND status = 'pending';
