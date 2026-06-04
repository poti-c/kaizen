-- New companies start with BLANK departments/categories/locations
-- (super admin adds them later). Seed explicit empty arrays so the app
-- shows nothing instead of falling back to hardcoded defaults.
create or replace function kaizen_seed_company_taxonomy()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into kaizen_settings (key, value, company_id) values
    ('custom_departments', '[]'::jsonb, new.id),
    ('custom_categories',  '[]'::jsonb, new.id),
    ('custom_locations',   '[]'::jsonb, new.id)
  on conflict (key, company_id) do nothing;
  return new;
end; $$;

drop trigger if exists trg_seed_company_taxonomy on kaizen_companies;
create trigger trg_seed_company_taxonomy
after insert on kaizen_companies
for each row execute function kaizen_seed_company_taxonomy();
