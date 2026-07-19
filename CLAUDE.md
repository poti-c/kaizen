# Kaizen System — project notes

## Live preview — start immediately
At the start of EVERY session, before doing anything else, call
`preview_start` with name `"kaizen"` so the live preview is ready in the
panel by the time the user looks at it. Do this without being asked.
If `preview_start` reports the port is busy, run
`lsof -ti :5176 | xargs kill -9`, then retry once.

The dev server runs on port **5176** (see `.claude/launch.json`).
Vite is configured with `host: true` (IPv6 + IPv4) in `vite.config.ts` —
do not remove it; the preview panel connects via `::1` and shows
"Awaiting server…" forever without it.

## Stack
- React + Vite + TypeScript, Supabase backend.
- All Supabase tables/policies are prefixed `kaizen_` / `kzn_`.
- SQL migrations live in `supabase/migrations/`. Migrations pushed to git
  are NOT auto-applied to the Supabase project — apply them explicitly.

## Function grants — `REVOKE ... FROM PUBLIC` does NOT work here
Supabase runs `ALTER DEFAULT PRIVILEGES` granting `EXECUTE` to `anon` and
`authenticated`, so every new function is created with those as **explicit**
grants:

```
postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
```

`REVOKE EXECUTE ON FUNCTION f() FROM PUBLIC` only drops the implicit `PUBLIC`
grant — the explicit `anon` grant survives and the function stays callable by
anyone holding the publishable key, which ships in the browser bundle. **Name
the roles:**

```sql
REVOKE ALL ON FUNCTION public.f(args) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f(args) TO service_role;  -- or authenticated
```

This trap produced two separate live vulnerabilities (2026-07-19): anonymous
Console admin creation, and anonymous subscription/addon activation. Eight
`REVOKE ... FROM PUBLIC` statements already in the repo are no-ops — they look
correct in review, which is exactly why this is worth remembering.

Rules of thumb for any new `SECURITY DEFINER` function:
- It bypasses RLS. It must authorize its own caller (`auth.uid()`, role check),
  or be `service_role`-only. Never rely on RLS to protect it.
- Grant the narrowest role that works: `service_role` if only edge functions
  call it, `authenticated` if the browser calls it. Never leave `anon`.
- Verify after applying — `\df+` lies less than the migration does:
  ```sql
  select proname, array_to_string(proacl,' | ') from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';
  ```

## Schema drift — the repo must be able to rebuild the DB
Because migrations are applied explicitly, it is easy to change the live
project and forget the migration. A sweep on 2026-07-19 found 18 orphaned
objects that way, including two that made `db reset` abort outright. Anything
changed on live needs a matching `supabase/migrations/` file, written with
`if not exists` so it is a no-op against live.

## Notes
- `.claude/` is gitignored (local dev config + the `debug` skill).
- A rebuilt database has an empty `kaizen_console_admins`, so the Console has
  no login until an admin is bootstrapped by hand — the live row holds a real
  password hash and is deliberately not in the repo.
