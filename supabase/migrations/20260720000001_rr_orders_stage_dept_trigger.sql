-- RoutineRosterPage's onFulfill/onDeliver were narrowed in the UI to require
-- stagePic(tpl, 'fulfill'|'deliver') membership, but the kro_update RLS policy
-- on kaizen_rr_orders (20260612100000_routine_roster.sql) only checks
-- company_id membership — ANY authenticated member of the company can PATCH
-- any order's stage-transition columns directly, regardless of department.
-- That is the actual proven bypass; the UI restriction was purely cosmetic.
--
-- This trigger closes the coarse, security-relevant boundary — correct stage
-- department, or manager/super_admin — matching every legitimate write path
-- (all 9 call sites in RoutineRosterPage.tsx always pair a status transition
-- with the columns they touch, so gating on OLD.status -> NEW.status covers
-- every real caller). It deliberately does NOT replicate the finer
-- 'fulfill_pic_mode = users' / 'deliver_pic_mode = users' per-person
-- narrowing from kaizen_rr_templates — that stays app-enforced only, the same
-- residual-gap pattern already accepted elsewhere in this codebase for
-- workflow nuances that aren't the primary authorization boundary.
CREATE OR REPLACE FUNCTION kaizen_rr_orders_enforce_stage_dept()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_dept text := kaizen_current_dept();
  actor_role text := kaizen_current_role();
BEGIN
  IF actor_role IN ('super_admin', 'manager') THEN
    RETURN NEW;
  END IF;

  -- Cancel is manager/super_admin only (matches canManage-gated cancel button).
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'Not authorized: only a manager can cancel a routine roster order';
  END IF;

  -- Request-side: send (pending->sent), the send-failure rollback
  -- (sent->pending), and confirm (delivered->confirmed).
  IF (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent')
     OR (NEW.status = 'pending' AND OLD.status = 'sent')
     OR (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed')
  THEN
    IF actor_dept IS DISTINCT FROM OLD.request_department THEN
      RAISE EXCEPTION 'Not authorized: not in the requesting department for this order';
    END IF;
  END IF;

  -- Fulfill-side: accept, hand over to ready, or deliver directly on a
  -- two-stage order (no separate delivery department).
  IF (NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted')
     OR (NEW.status = 'ready' AND OLD.status IS DISTINCT FROM 'ready')
     OR (NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' AND OLD.deliver_department IS NULL)
  THEN
    IF actor_dept IS DISTINCT FROM OLD.fulfill_department THEN
      RAISE EXCEPTION 'Not authorized: not in the fulfilling department for this order';
    END IF;
  END IF;

  -- Deliver-side: final delivery on a three-stage order.
  IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' AND OLD.deliver_department IS NOT NULL THEN
    IF actor_dept IS DISTINCT FROM OLD.deliver_department THEN
      RAISE EXCEPTION 'Not authorized: not in the delivering department for this order';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kaizen_rr_orders_enforce_stage_dept ON kaizen_rr_orders;
CREATE TRIGGER kaizen_rr_orders_enforce_stage_dept
  BEFORE UPDATE ON kaizen_rr_orders
  FOR EACH ROW EXECUTE FUNCTION kaizen_rr_orders_enforce_stage_dept();
