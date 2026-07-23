// kaizen-orphan-sweep — deletes orphaned objects from the kaizen-photos bucket.
// Invoked on a schedule by pg_cron (see 20260723000003_orphan_sweep_cron.sql).
//
// Auth: deployed with verify_jwt=false and gated by a shared secret. The caller
// must send `x-sweep-secret` matching public.kaizen_maintenance_config
// ('orphan_sweep_secret'), which only service_role/postgres can read. Worst case
// of an unauthorized call is still bounded — it only ever deletes objects that no
// live row references and that are older than the age cutoff.
//
// Uses the auto-injected SUPABASE_SERVICE_ROLE_KEY (no manual secret needed). The
// orphan set is computed by public.kaizen_list_orphan_photos so the delete logic
// and the reference check live in one authoritative place.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Shared-secret gate (read via service role; RLS-locked table).
  const { data: cfg } = await admin
    .from("kaizen_maintenance_config").select("value").eq("key", "orphan_sweep_secret").maybeSingle();
  const expected = cfg?.value;
  const got = req.headers.get("x-sweep-secret");
  if (!expected || got !== expected) return json({ error: "unauthorized" }, 401);

  // Optional age override (defaults to 7 days) for manual runs; the cron sends none.
  let olderThan = "7 days";
  try {
    const b = await req.json();
    if (b && typeof b.older_than === "string") olderThan = b.older_than;
  } catch { /* no body */ }

  const { data: names, error } = await admin.rpc("kaizen_list_orphan_photos", { p_older_than: olderThan });
  if (error) return json({ error: error.message }, 500);
  const list = (names ?? []) as string[];

  let removed = 0;
  const errors: string[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    if (chunk.length === 0) continue;
    const { data: del, error: derr } = await admin.storage.from("kaizen-photos").remove(chunk);
    if (derr) errors.push(derr.message);
    else removed += del?.length ?? 0;
  }

  await admin.from("kaizen_maintenance_log").insert({
    job: "orphan_sweep",
    deleted_count: removed,
    details: { requested: list.length, older_than: olderThan, errors },
  });

  return json({ requested: list.length, removed, errors });
});
