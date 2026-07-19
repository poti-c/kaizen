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

// Built-in department slugs (mirror of DEPARTMENTS in src/types). Custom
// departments are stored as their LABEL in kaizen_settings.custom_departments.
const BUILTIN_DEPT_SLUGS = new Set([
  "top_management", "front_office", "sales_team", "house_keeping",
  "human_resource", "engineering_team", "restaurant", "kitchen", "accounting",
]);

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
    .select("role, department, managed_departments, company_id, is_active, deleted_at")
    .eq("id", user.id)
    .single();

  const callerRole = callerProfile?.role;
  const callerDept = callerProfile?.department;
  const callerCompany = callerProfile?.company_id;
  const callerEffectiveDepts: string[] = [callerDept, ...(callerProfile?.managed_departments ?? [])].filter(Boolean);

  if (callerRole !== "super_admin" && callerRole !== "manager") {
    return json({ error: "Forbidden" }, 403);
  }
  if (!callerProfile?.is_active || callerProfile?.deleted_at) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  const { action } = body;

  // Companies a super admin may manage: their home company plus every company
  // granted via kaizen_super_admin_companies (the same set the app's company
  // switcher exposes). Cached for the request.
  let _accessible: Set<string> | null = null;
  async function accessibleCompanies(): Promise<Set<string>> {
    if (_accessible) return _accessible;
    const ids = new Set<string>();
    if (callerCompany) ids.add(callerCompany);
    const { data: grants } = await supabaseAdmin
      .from("kaizen_super_admin_companies")
      .select("company_id")
      .eq("super_admin_id", user.id);
    for (const g of grants ?? []) if (g.company_id) ids.add(g.company_id);
    _accessible = ids;
    return ids;
  }

  async function assertCanManage(userId: string): Promise<{ ok: boolean; error?: string; target?: any }> {
    const { data: target } = await supabaseAdmin.from("kaizen_profiles").select("role, department, company_id, full_name, username, deleted_at").eq("id", userId).maybeSingle();
    if (!target) return { ok: false, error: "User not found" };
    if (target.deleted_at) return { ok: false, error: "Cannot modify a deleted user" };
    if (callerRole === "super_admin") {
      // Honour cross-company access — a super admin manages users in any company
      // they can switch into, not only their home company.
      const allowed = await accessibleCompanies();
      if (!target.company_id || !allowed.has(target.company_id)) return { ok: false, error: "Different company" };
      return { ok: true, target };
    }
    if (target.company_id !== callerCompany) return { ok: false, error: "Different company" };
    const isHR = callerDept === "human_resource";
    if (isHR) {
      if (target.role === "super_admin") return { ok: false, error: "HR cannot manage Top Management" };
      if (target.role === "manager") return { ok: false, error: "HR can only manage staff accounts" };
      return { ok: true, target };
    }
    if (target.role !== "staff") return { ok: false, error: "Managers can only manage staff" };
    // Match the CREATE path: a manager may manage staff in their primary department OR
    // any department assigned via managed_departments. Checking callerDept alone caused
    // suspend/edit/delete/reset to 403 for staff a manager could legitimately create.
    if (!callerEffectiveDepts.includes(target.department)) return { ok: false, error: "Staff in another department" };
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

  // Enforce a company's package seat limit for a role. Returns an error message
  // when adding/activating/promoting one more user of `role` would exceed the cap,
  // else null. `excludeUserId` omits the target from the count (e.g. a role change
  // where the user is already counted under their old role). Used by create,
  // set_active (reactivate) and update_profile (role change) so the cap can't be
  // bypassed by suspending+reactivating or by promoting existing staff.
  async function roleLimitError(companyId: string | null, role: string, excludeUserId?: string): Promise<string | null> {
    if (!companyId || !(role === "super_admin" || role === "manager" || role === "staff")) return null;
    const { data: co } = await supabaseAdmin.from("kaizen_companies").select("max_super_admins, max_managers, max_staff").eq("id", companyId).maybeSingle();
    const limit = role === "super_admin" ? co?.max_super_admins : role === "manager" ? co?.max_managers : co?.max_staff;
    if (limit === null || limit === undefined) return null;
    let q = supabaseAdmin.from("kaizen_profiles")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId).eq("role", role).eq("is_active", true).is("deleted_at", null);
    if (excludeUserId) q = q.neq("id", excludeUserId);
    const { count } = await q;
    if ((count ?? 0) >= limit) {
      const noun = role === "super_admin" ? "Top Management account(s)" : role === "manager" ? "managers" : "staff";
      return `Your plan allows up to ${limit} ${noun}. Upgrade the package to add more.`;
    }
    return null;
  }

  // Validate that a department is real for a company: a built-in slug, or a custom
  // LABEL present in that company's kaizen_settings.custom_departments. Prevents
  // orphaning a user under a typo'd/foreign department that no case query matches.
  async function isValidDepartment(companyId: string | null, department: string): Promise<boolean> {
    if (!department) return false;
    if (BUILTIN_DEPT_SLUGS.has(department)) return true;
    if (!companyId) return false;
    const { data } = await supabaseAdmin.from("kaizen_settings").select("value")
      .eq("company_id", companyId).eq("key", "custom_departments").maybeSingle();
    const labels = Array.isArray(data?.value) ? (data!.value as string[]) : [];
    return labels.includes(department);
  }

  // ── CREATE ──────────────────────────────────────────────────────────────────
  if (action === "create") {
    const { role, full_name, position, username, email, department, password, company_id } = body;

    if (!role || !full_name || !department || !password) {
      return json({ error: "role, full_name, department and password are required" }, 400);
    }
    if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

    if (callerRole === "manager") {
      if (role !== "staff") return json({ error: "Managers can only create staff accounts" }, 403);
      if (!callerEffectiveDepts.includes(department)) return json({ error: "Managers can only create staff in their own department" }, 403);
      // A manager may only create staff inside their OWN company. Reject any
      // attempt to target another tenant via a body company_id (the downstream
      // `company_id ?? callerCompany` would otherwise honour the foreign id).
      if (company_id && company_id !== callerCompany) {
        return json({ error: "Managers can only create staff in their own company." }, 403);
      }
    }

    // A super_admin may only create users in a company they actually manage (own + granted),
    // not in any arbitrary company id passed in the body.
    if (callerRole === "super_admin") {
      const targetCo = company_id ?? callerCompany;
      if (!targetCo || !(await accessibleCompanies()).has(targetCo)) {
        return json({ error: "You can only create users in companies you manage." }, 403);
      }
    }

    // Validate the department actually belongs to the target company (managers are
    // already gated to their own depts above; this covers super_admin and typos).
    const createCompany = company_id ?? callerCompany;
    if (!(await isValidDepartment(createCompany, department))) {
      return json({ error: "That department does not exist for this company." }, 400);
    }
    if (role === "super_admin" && department !== "top_management") {
      return json({ error: "Top Management accounts must belong to the top_management department." }, 400);
    }

    // Enforce the company package's user limits (Top Management / managers / staff).
    const limitCompany = company_id ?? callerCompany;
    if ((role === "super_admin" || role === "manager" || role === "staff") && limitCompany) {
      const limitErr = await roleLimitError(limitCompany, role);
      if (limitErr) {
        return json({ error: limitErr }, 400);
      }
    }

    let authEmail: string | undefined;
    if (role === "staff") {
      if (!username) return json({ error: "username is required for staff" }, 400);
      const targetCompany = company_id ?? callerCompany;
      const built = await staffLoginEmail(username, targetCompany);
      if (!built) return json({ error: "Company not found for staff account" }, 400);
      authEmail = built;

      // If a SOFT-DELETED staff account already holds this login email, release
      // it so the username can be reused for a new hire. We keep the old row's
      // full_name (so historical cases still show who it was) but rename its
      // username + auth email to a tombstone, freeing the slot.
      // MU-CLASH-01: usernames are stored RAW-trimmed (not normalized), so we must
      // NOT pre-filter the query by normUser(username) — that would exclude any
      // soft-deleted row whose username has uppercase/spaces (e.g. "John Smith"),
      // leaving its login-email slot occupied and producing a misleading
      // "already taken by an active account" error. Fetch all soft-deleted staff
      // for the company and compare in JS on the normalized form instead.
      const { data: removedStaff } = await supabaseAdmin
        .from("kaizen_profiles")
        .select("id, username, company_id")
        .eq("company_id", targetCompany)
        .eq("role", "staff")
        .not("deleted_at", "is", null);
      const clash = (removedStaff ?? []).find(
        (r: any) => normUser(r.username ?? "") === normUser(username)
      );
      if (clash) {
        const tomb = `.removed.${Math.floor(Date.now() / 1000)}.${Math.random().toString(36).slice(2, 7)}`;
        const freedUsername = `${clash.username ?? "removed"}${tomb}`;
        const freedEmail = await staffLoginEmail(freedUsername, clash.company_id);
        if (freedEmail) {
          // Auth email first — only rename the profile if the auth side succeeds.
          const { error: freeAuthErr } = await supabaseAdmin.auth.admin.updateUserById(clash.id, { email: freedEmail });
          if (!freeAuthErr) {
            await supabaseAdmin.from("kaizen_profiles").update({ username: freedUsername }).eq("id", clash.id).eq("username", clash.username);
          }
        }
      }
    } else {
      authEmail = email?.trim().toLowerCase();
      if (!authEmail) return json({ error: "email is required for manager/admin" }, 400);
    }

    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: authEmail,
      password,
      email_confirm: true,
    });

    if (createErr) {
      const msg = /already.*registered|already.*exists|email.*taken/i.test(createErr.message)
        ? (role === "staff"
            ? "This username is already taken by an active account. Please choose a different username."
            : "This email is already registered.")
        : createErr.message;
      return json({ error: msg }, 400);
    }

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

    // SEAT-001 (mitigation): the pre-insert roleLimitError check is a TOCTOU window — two
    // concurrent creates can each pass it and push the company over its seat cap. Re-verify
    // AFTER inserting and roll this user back if we now exceed the limit. This fails closed
    // (a rare concurrent pair may both roll back; the admin just retries one at a time)
    // rather than silently leaving the company over its paid seat count. A DB-level
    // constraint/trigger would make it fully atomic; this is the no-migration mitigation.
    const overLimitErr = await roleLimitError(targetCompanyId ?? null, role, userId);
    if (overLimitErr) {
      await supabaseAdmin.from("kaizen_profiles").delete().eq("id", userId);
      await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
      return json({ error: overLimitErr }, 400);
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
    // Reactivating consumes a seat — re-check the plan cap (the count basis is
    // is_active=true, so a suspended user is "free"; without this a company could
    // suspend, create a replacement, then reactivate to exceed the limit).
    if (is_active && check.target) {
      const limitErr = await roleLimitError(check.target.company_id, check.target.role, userId);
      if (limitErr) return json({ error: limitErr }, 400);
    }
    const { error: updErr } = await supabaseAdmin.from("kaizen_profiles").update({ is_active }).eq("id", userId);
    if (updErr) return json({ error: updErr.message }, 400);
    // SEAT-001 (mitigation): re-verify the cap AFTER reactivating and re-suspend if a
    // concurrent reactivate/create pushed us over (same TOCTOU window as create). Fails closed.
    if (is_active && check.target) {
      const overLimitErr = await roleLimitError(check.target.company_id, check.target.role, userId);
      if (overLimitErr) {
        await supabaseAdmin.from("kaizen_profiles").update({ is_active: false }).eq("id", userId);
        return json({ error: overLimitErr }, 400);
      }
    }
    // Revoke (or restore) the auth session so a SUSPENDED user can't keep using a
    // still-valid JWT until it expires. Best-effort; the is_active flag remains the
    // source of truth (the client also re-checks it on session restore).
    try {
      await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: is_active ? "none" : "876000h" });
    } catch (_) { /* non-fatal */ }
    return json({ success: true });
  }

  // ── UPDATE PROFILE ────────────────────────────────────────────────────────────
  if (action === "update_profile") {
    const { userId, updates } = body;
    if (!userId || !updates) return json({ error: "userId and updates are required" }, 400);
    const check = await assertCanManage(userId);
    if (!check.ok) return json({ error: check.error }, 403);
    const target = check.target;

    // The role after this update (super admins may change it; otherwise unchanged).
    const finalRole = (callerRole === "super_admin" && updates.role !== undefined) ? updates.role : target.role;
    // Managers & admins log in with their email; staff log in with a username.
    const emailIn = typeof updates.email === "string" ? updates.email.trim().toLowerCase() : "";

    // MU-005: promoting a staff member to manager/admin without a login email locks them out —
    // their auth email is still the .staff.kaizen.internal address and there is no way to log in.
    if (callerRole === "super_admin" && updates.role !== undefined && updates.role !== "staff" && target.role === "staff" && !emailIn) {
      return json({ error: `A login email is required when promoting a staff member to ${updates.role}.` }, 400);
    }
    // MU-006: demoting to staff without a username leaves the account unloggable (staff use username login)
    if (callerRole === "super_admin" && updates.role === "staff" && target.role !== "staff" && !(updates.username?.trim())) {
      return json({ error: "A username is required when demoting an account to staff." }, 400);
    }

    if (updates.full_name !== undefined && !String(updates.full_name ?? "").trim()) {
      return json({ error: "full_name must not be blank" }, 400);
    }
    // MU-003: username changes are super_admin only — managers must not be able to lock staff out
    const allowed: Record<string, unknown> = {
      full_name: updates.full_name !== undefined ? String(updates.full_name).trim() : undefined,
      position: updates.position,
    };
    if (updates.must_change_password !== undefined) {
      if (callerRole !== "super_admin") {
        return json({ error: "Only Top Management can set the must_change_password flag" }, 403);
      }
      allowed.must_change_password = updates.must_change_password;
    }
    if (callerRole === "super_admin") {
      // Allow username change only for super_admin callers
      if (updates.username !== undefined) allowed.username = typeof updates.username === "string" ? updates.username.trim() : updates.username;
      if (updates.department !== undefined) {
        if (!(await isValidDepartment(target.company_id, updates.department))) {
          return json({ error: "That department does not exist for this company." }, 400);
        }
        allowed.department = updates.department;
      }
      if (updates.role !== undefined) {
        const VALID_ROLES = new Set(["super_admin", "manager", "staff"]);
        if (!VALID_ROLES.has(updates.role)) return json({ error: "Invalid role." }, 400);
        if (updates.role === "super_admin") {
          const effectiveDept = updates.department ?? target.department;
          if (effectiveDept !== "top_management") {
            return json({ error: "Top Management accounts must belong to the Top Management department." }, 400);
          }
        }
        if (updates.role !== target.role) {
          const limitErr = await roleLimitError(target.company_id, updates.role, userId);
          if (limitErr) return json({ error: limitErr }, 400);
          allowed.role = updates.role;
          // MU-002: clear the stale identity field only when role ACTUALLY changes boundary
          if (updates.role === "staff") {
            allowed.email = null;   // was a manager/admin email — clear it
          } else {
            allowed.username = null; // was a staff username — clear it
          }
        } else {
          allowed.role = updates.role;
        }
      }
    }
    // Store the login email on the profile for managers/admins.
    if (finalRole !== "staff" && emailIn) allowed.email = emailIn;
    Object.keys(allowed).forEach((k) => allowed[k] === undefined && delete allowed[k]);

    // MU-001: attempt auth email update FIRST — if it fails we haven't mutated the profile row yet
    const newUsername = (((callerRole === "super_admin" ? updates.username : undefined) ?? "")).trim();
    let targetAuthEmail: string | null = null;
    if (finalRole === "staff" && newUsername) {
      targetAuthEmail = await staffLoginEmail(newUsername, target.company_id);
    } else if (finalRole !== "staff" && emailIn) {
      targetAuthEmail = emailIn;
    }
    let oldAuthEmail: string | null = null;
    let didUpdateAuthEmail = false;
    if (targetAuthEmail) {
      const { data: authU } = await supabaseAdmin.auth.admin.getUserById(userId);
      oldAuthEmail = authU?.user?.email ?? null;
      if (authU?.user?.email !== targetAuthEmail) {
        const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { email: targetAuthEmail, email_confirm: true });
        if (emailErr) {
          const taken = /already.*registered|already.*exists|email.*taken|duplicate/i.test(emailErr.message);
          return json({ error: taken ? "That email is already registered to another account." : "Failed to update login: " + emailErr.message }, 400);
        }
        didUpdateAuthEmail = true;
      }
    }

    // Auth update succeeded (or wasn't needed) — now commit the profile row.
    // On profile failure, roll back the auth email if it was changed.
    const { error: updErr } = await supabaseAdmin.from("kaizen_profiles").update(allowed).eq("id", userId);
    if (updErr) {
      if (didUpdateAuthEmail && oldAuthEmail !== null) {
        // Best-effort rollback — restore the previous auth email
        await supabaseAdmin.auth.admin.updateUserById(userId, { email: oldAuthEmail, email_confirm: true }).catch(() => {});
      }
      return json({ error: updErr.message }, 400);
    }

    // When a user is promoted to super_admin ensure they have a company grant row.
    //
    // A PostgrestFilterBuilder is a bare PromiseLike: it implements then() but has NO
    // catch(). The `.catch(() => {})` that used to sit here therefore threw TypeError
    // synchronously — before the upsert was ever sent — so the promotion updated the
    // role but never created the grant row, leaving a super_admin with no company
    // access. supabase-js resolves with { error } instead of rejecting, so the result
    // is checked directly.
    if (allowed.role === "super_admin" && target.company_id) {
      const { error: grantErr } = await supabaseAdmin.from("kaizen_super_admin_companies")
        .upsert({ super_admin_id: userId, company_id: target.company_id }, { onConflict: "super_admin_id,company_id", ignoreDuplicates: true });
      if (grantErr) console.error("[kaizen-manage-users] super_admin grant upsert failed", userId, target.company_id, grantErr.message);
    }
    // MU-DEMOTE-01: the promotion path above has always maintained the grant row,
    // but nothing ever removed it on the way back down. kaizen_user_company_ids()
    // (20260604000002_tenant_isolation_rls.sql) unions the caller's own company_id
    // with every row in kaizen_super_admin_companies for their auth.uid(), with NO
    // role check — so a demoted super_admin kept every RLS policy in the app
    // treating them as still having cross-company access to every company they
    // were ever granted, indefinitely, via the browser. Demoting (or soft-deleting,
    // below) must revoke every grant row, not just change the profile's role.
    if (target.role === "super_admin" && allowed.role !== undefined && allowed.role !== "super_admin") {
      const { error: revokeErr } = await supabaseAdmin.from("kaizen_super_admin_companies")
        .delete().eq("super_admin_id", userId);
      if (revokeErr) console.error("[kaizen-manage-users] super_admin grant revoke failed", userId, revokeErr.message);
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

    if (callerRole === "manager" && callerDept === "human_resource") return json({ error: "HR Manager cannot delete users" }, 403);
    const check = await assertCanManage(userId);
    if (!check.ok) return json({ error: check.error }, 403);

    // 1) Mark the profile removed and deactivate it (blocks login via the app's is_active check).
    const nowIso = new Date().toISOString();
    const { error: softErr } = await supabaseAdmin.from("kaizen_profiles")
      .update({ deleted_at: nowIso, is_active: false }).eq("id", userId);
    if (softErr) return json({ error: softErr.message }, 400);

    // 2) Ban the auth user so they can't obtain a session either (best-effort).
    try { await supabaseAdmin.auth.admin.updateUserById(userId, { ban_duration: "876000h" }); } catch (_) { /* non-fatal */ }

    // MU-DEMOTE-01: banning blocks future SIGN-INS but does not revoke an
    // already-issued JWT, and the ban call above is itself best-effort. Grant
    // rows are the actual authority kaizen_user_company_ids() checks for
    // cross-company access, independent of is_active/ban, so they must be
    // revoked explicitly rather than relying on the ban as the only backstop.
    if (check.target.role === "super_admin") {
      const { error: revokeErr } = await supabaseAdmin.from("kaizen_super_admin_companies")
        .delete().eq("super_admin_id", userId);
      if (revokeErr) console.error("[kaizen-manage-users] super_admin grant revoke failed on delete", userId, revokeErr.message);
    }

    // 3) Remove them from In Charge on every case; fall back to the case's department manager.
    const { data: picCases } = await supabaseAdmin
      .from("kaizen_cases")
      .select("id, case_number, title, department, company_id, pic_ids")
      .eq("company_id", check.target.company_id)
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
      // Match a manager whose PRIMARY department is the case's department, OR who covers
      // it via managed_departments (mirrors callerEffectiveDepts). Two queries instead of
      // a single .or() avoid PostgREST or-filter escaping issues with custom dept labels
      // that contain commas, '&', etc.
      let mgr: { id: string; full_name: string } | null = null;
      {
        const { data } = await supabaseAdmin.from("kaizen_profiles")
          .select("id, full_name")
          .eq("company_id", c.company_id).eq("department", c.department).eq("role", "manager")
          .eq("is_active", true).is("deleted_at", null)
          .neq("id", userId)
          .limit(1).maybeSingle();
        mgr = data ?? null;
      }
      if (!mgr && c.department) {
        const { data } = await supabaseAdmin.from("kaizen_profiles")
          .select("id, full_name")
          .eq("company_id", c.company_id).eq("role", "manager")
          .contains("managed_departments", [c.department])
          .eq("is_active", true).is("deleted_at", null)
          .neq("id", userId)
          .limit(1).maybeSingle();
        mgr = data ?? null;
      }
      if (mgr) {
        await supabaseAdmin.from("kaizen_cases")
          .update({ pic_ids: [mgr.id], person_in_charge: mgr.id, updated_at: nowIso })
          .eq("id", c.id);
        await supabaseAdmin.from("kaizen_notifications").insert({
          user_id: mgr.id,
          case_id: c.id,
          // English fallback for older clients; localized via title_key/body_params.
          title: "Auto-assigned as In Charge",
          message: `A removed team member left case ${c.case_number} without an owner — you have been assigned as In Charge. You can reassign it anytime.`,
          notification_type: "assignment",
          title_key: "case_auto_pic",
          body_params: { caseNo: c.case_number },
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
    if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

    // Authorize EVERY caller (assertCanManage scopes super_admins to their accessible
    // companies too) — previously a super_admin could reset any user's password anywhere.
    const check = await assertCanManage(userId);
    if (!check.ok) return json({ error: check.error }, 403);

    const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { password });
    if (pwErr) return json({ error: pwErr.message }, 400);

    // AU-BUG-01 follow-up: must_change_password used to be set by the CALLER via
    // update_profile, which is super_admin-only server-side (MU-003-adjacent) — a
    // manager's reset silently never forced the flag, since update_profile there
    // only ever sends it when profile?.role === 'super_admin'. Set it here instead,
    // unconditionally, on every successful reset through this action: assertCanManage
    // above has already authorized the caller (manager or super_admin) to reset this
    // specific user's password, and forcing a change on next login is the correct
    // policy regardless of which authorized role performed the reset.
    const { error: mcpErr } = await supabaseAdmin.from("kaizen_profiles")
      .update({ must_change_password: true }).eq("id", userId);
    if (mcpErr) console.error("[kaizen-manage-users] must_change_password flag update failed", userId, mcpErr.message);

    return json({ success: true });
  }

  return json({ error: "Unknown action" }, 400);
});
