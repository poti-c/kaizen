# Deployment & Safety Net

How the Kaizen System ships, and how to change it safely while it's live.

## What "live" means here

- **Frontend** — the React app, hosted on **GitHub Pages**. It auto-deploys from
  the `gh-pages` branch, which is rebuilt by `.github/workflows/deploy.yml` on
  every push to `main`. A change is live ~1–2 minutes after it lands on `main`.
- **Backend** — **Supabase** (database, auth, storage, edge functions). This is
  always live. Schema/function changes take effect immediately on the production
  database.

So: editing the frontend is low-risk (a bad change is reverted with one commit).
Editing the **database** is the higher-risk area and gets extra care below.

## Safety gates (automatic)

1. **CI on every branch / pull request** (`.github/workflows/ci.yml`)
   - Runs `tsc --noEmit` (type-check) + `vite build`.
   - If either fails, the PR shows a red ✗ — fix before merging.
2. **Production deploy is gated** (`.github/workflows/deploy.yml`)
   - `main` only deploys if `tsc --noEmit` **and** the build pass.
   - Broken code (type errors or build failures) can never reach the live site,
     even on a direct push to `main`.

## The safe workflow (recommended)

```
1. Create a branch:      git checkout -b feature/xyz
2. Make changes, commit, push the branch
3. Open a Pull Request to main  →  CI runs automatically
4. Review the change + a local preview (npm run dev)
5. Merge the PR  →  main deploys to production
```

Working on a branch + PR means CI validates the change **before** it can affect
the live site. For a quick one-line fix you can still commit to `main` directly —
the deploy gate will still stop it if it doesn't compile.

> Optional hardening: enable **branch protection** on `main` in GitHub
> (Settings → Branches) to *require* the CI check to pass and a PR before merging.
> Recommended once more than one person can push.

## Database changes (the careful part)

The live database is shared by all clients, so schema/data changes need discipline:

- **Always use a versioned migration** in `supabase/migrations/` (never one-off
  edits in the dashboard). They're committed to git, so the schema history is
  reproducible and reviewable.
- **Review the SQL before applying.** Migrations that drop columns/tables or
  rewrite data are effectively irreversible on production — back up first.
- **Prefer additive changes** (add a column/table) over destructive ones; migrate
  data in a follow-up step, then remove the old shape once nothing reads it.

### Staging database (optional, strongest net)

For zero-risk testing of schema changes against a *copy* of production, two
options:

- **Supabase Branching** (Pro plan) — spins up an ephemeral database branch per
  git branch; migrations run there first, merged to prod on merge. Paid.
- **A second free Supabase project** as "staging" — point a `staging` build at it
  via env vars, test migrations there, then apply to production.

Neither is set up yet; pick one when you want it.

## Rollback

- **Frontend:** `git revert <bad-commit>` and push to `main` — the previous build
  redeploys automatically.
- **Database:** restore from a Supabase backup, or apply a corrective migration.
  (This is why destructive migrations need a backup first.)
