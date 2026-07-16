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

## Notes
- `.claude/` is gitignored (local dev config + the `debug` skill).
