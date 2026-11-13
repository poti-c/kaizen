-- Daily hotel figures extracted from the "Daily Manager Reports" email.
--
-- One row per BUSINESS day (stat_date — the report's "Statistic on" date),
-- not per print date: the report generated on 07/11 describes 06/11, and
-- keying on the print date would silently shift every figure by a day.
--
-- Only aggregates are stored. The source email carries guest names, room
-- numbers, VIP status and booking sources; none of that is extracted and none
-- of it belongs in this table.
--
-- Idempotent (if not exists throughout); safe to run against live.

CREATE TABLE IF NOT EXISTS public.kaizen_hotel_daily (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES kaizen_companies(id) ON DELETE CASCADE,

  stat_date           date NOT NULL,
  report_date         date,

  -- Occupancy, this year
  occ_pct_today       numeric(6,2),
  occ_pct_mtd         numeric(6,2),
  occ_pct_ytd         numeric(6,2),
  occ_excl_pct_today  numeric(6,2),   -- % Rms without Comp & HU
  occ_excl_pct_mtd    numeric(6,2),
  occ_excl_pct_ytd    numeric(6,2),

  rooms_occupied_today integer,
  rooms_occupied_mtd   integer,
  rooms_occupied_ytd   integer,
  rooms_avail_today    integer,
  rooms_avail_mtd      integer,
  rooms_avail_ytd      integer,

  -- Revenue, this year
  hotel_revenue_today numeric(14,2),
  hotel_revenue_mtd   numeric(14,2),
  hotel_revenue_ytd   numeric(14,2),
  room_revenue_today  numeric(14,2),
  room_revenue_mtd    numeric(14,2),
  room_revenue_ytd    numeric(14,2),
  fb_revenue_today    numeric(14,2),
  fb_revenue_mtd      numeric(14,2),
  fb_revenue_ytd      numeric(14,2),
  misc_revenue_today  numeric(14,2),
  misc_revenue_mtd    numeric(14,2),
  misc_revenue_ytd    numeric(14,2),
  adr_today           numeric(12,2),
  adr_mtd             numeric(12,2),
  adr_ytd             numeric(12,2),

  -- Same-period last year, for the comparison the report already provides
  ly_occ_pct_today    numeric(6,2),
  ly_occ_pct_mtd      numeric(6,2),
  ly_occ_pct_ytd      numeric(6,2),
  ly_hotel_rev_today  numeric(14,2),
  ly_hotel_rev_mtd    numeric(14,2),
  ly_hotel_rev_ytd    numeric(14,2),

  -- Forecast: { asAtDate, days: [...], months: [...] } from the R010 report.
  -- JSONB rather than a child table because it is always read whole, as one
  -- snapshot belonging to this stat_date, and is never queried across rows.
  forecast            jsonb,

  uploaded_by         uuid REFERENCES kaizen_profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Re-uploading the same day's reports corrects the row instead of duplicating
-- it; the dashboard would otherwise have two candidate rows for one date.
CREATE UNIQUE INDEX IF NOT EXISTS kzn_hotel_daily_company_date
  ON public.kaizen_hotel_daily (company_id, stat_date);

CREATE INDEX IF NOT EXISTS kzn_hotel_daily_recent
  ON public.kaizen_hotel_daily (company_id, stat_date DESC);

ALTER TABLE public.kaizen_hotel_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Read: anyone signed in to the company. The wall panel signs in as an
  -- ordinary user, so this has to cover every role, not just managers.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'kaizen_hotel_daily' AND policyname = 'kzn_hotel_daily_select') THEN
    EXECUTE $p$
      CREATE POLICY kzn_hotel_daily_select ON kaizen_hotel_daily FOR SELECT
        USING (company_id IN (SELECT kaizen_user_company_ids()))$p$;
  END IF;

  -- Write: managers and admins of that company only. These are the hotel's
  -- revenue figures; a staff account must not be able to write them.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'kaizen_hotel_daily' AND policyname = 'kzn_hotel_daily_insert') THEN
    EXECUTE $p$
      CREATE POLICY kzn_hotel_daily_insert ON kaizen_hotel_daily FOR INSERT
        WITH CHECK (
          company_id IN (SELECT kaizen_user_company_ids())
          AND kaizen_current_role() IN ('super_admin', 'manager')
        )$p$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'kaizen_hotel_daily' AND policyname = 'kzn_hotel_daily_update') THEN
    EXECUTE $p$
      CREATE POLICY kzn_hotel_daily_update ON kaizen_hotel_daily FOR UPDATE
        USING (
          company_id IN (SELECT kaizen_user_company_ids())
          AND kaizen_current_role() IN ('super_admin', 'manager')
        )
        WITH CHECK (
          company_id IN (SELECT kaizen_user_company_ids())
          AND kaizen_current_role() IN ('super_admin', 'manager')
        )$p$;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'kaizen_hotel_daily' AND policyname = 'kzn_hotel_daily_delete') THEN
    EXECUTE $p$
      CREATE POLICY kzn_hotel_daily_delete ON kaizen_hotel_daily FOR DELETE
        USING (
          company_id IN (SELECT kaizen_user_company_ids())
          AND kaizen_current_role() = 'super_admin'
        )$p$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
