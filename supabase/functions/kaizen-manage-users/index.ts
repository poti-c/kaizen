import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function normUser(u: string): string {
  return String(u || "").trim().toLowerCase().split(" ").filter(Boolean).join(".");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (userErr || !user) return json({ error: "Unauthorized" }, 401);

  const { data: callerProfile } = await supabaseAdmin
    .from("kaizen_profiles")
    .select("role, department, company_id")
    .eq("id", user.id)
    .single();

  const callerRole = callerProfile?.role;
  const callerDept = callerProfile?.department;
  const callerCompany = callerProfile?.company_id;

  if (callerRole !== "super_admin" && callerRole !== "manager") {
    return json({ error: "Forbidden" }, 403);
  }

  const body = await req.json();
  const { action } = body;

  async function assertCanManage(userId: string): Promise<{ ok: boolean; error?: string; target?: any }> {
    const { data: target } = await supabaseAdmin.from("kaizen_profiles").select("role, department, company_id, full_name, username").eq("id", userId).single();
    if (!target) return { ok: false, error: "User not found" };
    if (callerRole === "super_admin") {
      if (target.company_id !== callerCompany) return { ok: false, error: "Different company" };
      return { ok: true, target };
    }
    if (target.company_id !== callerCompany) return { ok: false, error: "Different company" };
    const isHR = callerDept === "human_resource";
    if (isHR) {
      if (target.role === "super_admin") return { ok: false, error: "HR cannot manage Top Management" };
      return { ok: true, target };
    }
    if (target.role !== "staff") return { ok: false, error: "Managers can only manage staff" };
    if (target.department !== callerDept) return { ok: false, error: "Staff in another department" };
    return { ok: true, target };
  }

  // Build a staff member's deterministic login email from username + company code.
  async function staffLoginEmail(username: string, companyId: string | null): Promise<string | null> {
    if (!companyId) return null;
    const { data: co } = await supabaseAdmin.from("kaizen_companies").select("slug, login_code").eq("id", companyId).maybeSingle();
    const code = co?.login_code ?? co?.slug;
    if (!code) return null;
    return normUser(username) + "@" + code + ".staff.kaizen.internal";
  }

  // ── CREATE ──────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { role, full_name, position, username, email, department, password, company_id } = body;

    if (!role || !full_name || !department || !password) {
      return json({ error: "role, full_name, department and password are required" }, 400);
    }

    if (callerRole === "manager") {
      if (role !== "staff") return json({ error: "Managers can only create staff accounts" }, 403);
      if (department !== callerDept) return json({ error: "Managers can only create staff in their own department" }, 403);
    }

    let authEmail: string | undefined;
    if (role === "staff") {
      if (!username) return json({ error: "username is required for staff" }, 400);
      const targetCompany = company_id ?? callerCompany;
      const built = await staffLoginEmail(username, targetCompany);
      if (!built) return json({ error: "Company not found for staff account" }, 400);
      authEmail = built;
    } else {
      authEmail = email?.trim().toLowerCase();
      if (!authEmail) return json({ error: "email is required for manager/admin" }, 400);
    }

    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: authEmail,
      password,
      email_confirm: true,
    });

    if (createErr) return json({ error: createErr.message }, 400);

    const userId = newUser.user.id;
    const targetCompanyId = company_id ?? callerCompany;

    const { error: profileErr } = await supabaseAdmin.from("kaizen_profiles").insert({
      id: userId,
      full_name: full_name.trim(),
      position: position?.trim() || null,
      username: role === "staff" ? username?.trim() : null,
      email: role !== "staff" ? authEmail : null,
      role,
      department,
      is_active: true,
      company_id: targetCompanyId ?? null,
    });

    if (profileErr) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return json({ error: profileErr.message }, 400);
    }

    if (role === "super_admin" && targetCompanyId) {
      await supabaseAdmin.from("kaizen_super_admin_companies")
        .upsert({ super_admin_id: userId, company_id: targetCompanyId }, { onConflict: "super_admin_id,company_id", ignoreDuplicates: true });
    }

    return json({ success: true, userId });
  }

  // ── SET ACTIVE (suspend / reactivate) ────────────────────────────────────────
  if (action === "set_active") {
    const { userId, is_active } = body;
    if (!userId || typeof is_active !== "boolean") return json({ error: "userId and is_active are required" }, 400);
    if (userId === user.id) return json({ error: "Cannot change your own status" }, 400);
    const check = await assertCanManage(userId);
    if (!check.ok) return json({ error: check.error }, 403);
    const { error: updErr } = await supabaseAdmin.from("kaizen_profiles").update({ is_active }).eq("id", userId);
    if (updErr) return json({ error: updErr.message }, 400);
    return json({ success: true });
  }

  // ── UPDATE PROFILE ────────────────────────────────────────────────────────────
  if (action === "update_profile") {
    const { userId, updates } = body;
    if (!userId || !updates) return json({ error: "userId and updates are required" }, 400);
    const check = await assertCanManage(userId);
    if (!check.ok) return json({ error: check.error }, 403);
    const target = check.target;

    const allowed: Record<string, unknown> = {
      full_name: updates.full_name,
      position: updates.position,
      username: updates.username,
      must_change_password: updates.must_change_password,
    };
    if (callerRole === "super_admin") {
      if (updates.department !== undefined) allowed.department = updates.department;
      if (updates.role !== undefined) allowed.role = updates.role;
    }
    Object.keys(allowed).forEach((k) => allowed[k] === undefined && delete allowed[k]);
    const { error: updErr } = await supabaseAdmin.from("kaizen_profiles").update(allowed).eq("id", userId);
    if (updErr) return json({ error: updErr.message }, 400);

    // Keep a staff member's LOGIN email in sync with their username so the two
    // never drift apart (a staff member logs in with username + company code).
    // Compare against the ACTUAL current auth email so this also repairs any
    // account whose email already drifted from its username, and skips no-ops.
    const newUsername = (updates.username ?? "").trim();
    if (target.role === "staff" && newUsername) {
      const newEmail = await staffLoginEmail(newUsername, target.company_id);
      if (newEmail) {
        const { data: authU } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (authU?.user?.email !== newEmail) {
          const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { email: newEmail, email_confirm: true });
          if (emailErr) return json({ error: "Profile saved, but failed to update login: " + emailErr.message }, 400);
        }
      }
    }

    return json({ success: true });
  }

  // ── DELETE (soft) ─────────────────────────────────────────────────────────────
  // Keep the profile row so the person's name survives on historical cases
  // (shown struck-through). Block their login, and remove them from every case
  // they were In Charge of — falling back to the CASE's department manager when
  // no other person in charge remains.
  if (action === "delete") {
    const { userId } = body;
    if (!userId) return json({ error: "userId is required" }, 400);
    if (userId === user.id) return json({ error: "Cannot delete your own account" }, 400);

    if (callerRole === "manager") {
      const check = await assertCanManage(userId);
      if (!check.ok) return json({ error: check.error }, 403);
      if (callerDept === "human_resource") return json({ error: "HR Manager cannot delete users" }, 403);
    }

    // 1) Mark the profile removed and deactivate it (blocks login via the app's is_active check).
    const nowIso = new Date().toISOString();
    const { error: softErr } = await supabaseAdmin.from("kaizen_profiles")
      .update({ deleted_at: nowIso, is_active: false }).eq("id", userId);
    if (softErr) return json({ error: softErr.message }, 400);

    // 2) Ban the auth user so they can't obtain a session either (best-effort).
    try { await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: "876000h" }); } catch (_) { /* non-fatal */ }

    // 3) Remove them from In Charge on every case; fall back to the case's department manager.
    const { data: picCases } = await supabaseAdmin
      .from("kaizen_cases")
      .select("id, case_number, title, department, company_id, pic_ids")
      .contains("pic_ids", [userId]);

    for (const c of picCases ?? []) {
      const remaining = ((c.pic_ids as string[]) ?? []).filter((id) => id !== userId);
      if (remaining.length > 0) {
        await supabaseAdmin.from("kaizen_cases")
          .update({ pic_ids: remaining, person_in_charge: remaining[0], updated_at: nowIso })
          .eq("id", c.id);
        continue;
      }
      // No one left in charge → assign the CASE's department manager (active, not deleted).
      const { data: mgr } = await supabaseAdmin.from("kaizen_profiles")
        .select("id, full_name")
        .eq("company_id", c.company_id).eq("department", c.department).eq("role", "manager")
        .eq("is_active", true).is("deleted_at", null)
        .neq("id", userId)
        .limit(1).maybeSingle();
      if (mgr) {
        await supabaseAdmin.from("kaizen_cases")
          .update({ pic_ids: [mgr.id], person_in_charge: mgr.id, updated_at: nowIso })
          .eq("id", c.id);
        await supabaseAdmin.from("kaizen_notifications").insert({
          user_id: mgr.id,
          case_id: c.id,
          title: "Auto-assigned as In Charge",
          message: `A removed team member left case ${c.case_number} without an owner — you have been assigned as In Charge. You can reassign it anytime.`,
          notification_type: "assignment",
        });
      } else {
        // No active manager for that department → leave it unassigned.
        await supabaseAdmin.from("kaizen_cases")
          .update({ pic_ids: [], person_in_charge: null, updated_at: nowIso })
          .eq("id", c.id);
      }
    }

    return json({ success: true });
  }

  // ── RESET PASSWORD ────────────────────────────────────────────────────────────
  if (action === "reset_password" || action === "update_password") {
    const { userId, password } = body;
    if (!userId || !password) return json({ error: "userId and password are required" }, 400);

    if (callerRole === "manager") {
      const check = await assertCanManage(userId);
      if (!check.ok) return json({ error: check.error }, 403);
    }

    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
    if (pwErr) return json({ error: pwErr.message }, 400);

    return json({ success: true });
  }

  return json({ error: "Unknown action" }, 400);
});
