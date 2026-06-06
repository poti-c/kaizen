import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_USER   = Deno.env.get("CONSOLE_ADMIN_USER") ?? "";
const ADMIN_PASS   = Deno.env.get("CONSOLE_ADMIN_PASSWORD") ?? "";
const TOKEN_SECRET = Deno.env.get("CONSOLE_TOKEN_SECRET") ?? "";

const MAX_ATTEMPTS = 5;
const LOCKOUT_MIN  = 15;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const FOUNDER      = "poti@nanirand.com";
const INVOICE_BUCKET = "kaizen-invoices";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-console-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const enc = new TextEncoder();

function b64url(buf) {
  const s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.split("=").join("").split("+").join("-").split("/").join("_");
}
function b64urlStr(str) {
  const b = btoa(str);
  return b.split("=").join("").split("+").join("-").split("/").join("_");
}
function fromB64url(str) {
  return atob(str.split("-").join("+").split("_").join("/"));
}
function decodeBase64(b64) {
  const idx = b64.indexOf("base64,");
  const clean = idx >= 0 ? b64.slice(idx + 7) : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function normCode(s) {
  return String(s || "").toLowerCase().trim().split(" ").join("-").replace(/[^a-z0-9-]/g, "");
}
function normUser(u) {
  return String(u || "").trim().toLowerCase().split(" ").filter(Boolean).join(".");
}
function cleanStr(v) {
  return v === null ? null : String(v).trim() || null;
}

async function sha256(str) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return b64url(d);
}

function ctEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmac(data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
}

async function makeToken() {
  const payload = b64urlStr(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, iat: Date.now() }));
  const sig = await hmac(payload);
  return payload + "." + sig;
}

async function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = await hmac(parts[0]);
  if (!ctEq(parts[1], expected)) return false;
  try {
    const data = JSON.parse(fromB64url(parts[0]));
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch { return false; }
}

function getIp(req) {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

async function audit(action, detail, ip, success) {
  try {
    await admin.from("kaizen_console_audit").insert({ action, detail: detail ?? {}, ip, success: success !== false });
  } catch { /* never block on audit */ }
}

// Limits/features/multi-company defaults for a given package key.
async function packageDefaults(planKey) {
  if (!planKey) return null;
  const { data } = await admin.from("kaizen_products")
    .select("max_managers, max_staff, multi_company, features")
    .eq("kind", "package").eq("key", planKey).maybeSingle();
  return data ?? null;
}

function subscriptionFromEnd(period_end) {
  if (!period_end) return { period_end: null, days_remaining: null, overdue: false, has_payment: false };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const end = new Date(period_end + "T00:00:00Z");
  const days = Math.ceil((end.getTime() - today.getTime()) / 86400000);
  return { period_end, days_remaining: days, overdue: days < 0, has_payment: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!TOKEN_SECRET) return json({ error: "Console not configured." }, 500);

  const ip = getIp(req);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const action = body?.action;

  if (action === "login") {
    const { data: rl } = await admin.from("kaizen_console_login_attempts").select("*").eq("ip", ip).maybeSingle();
    if (rl?.locked_until && new Date(rl.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(rl.locked_until).getTime() - Date.now()) / 60000);
      await audit("login_locked", { ip }, ip, false);
      return json({ error: `Too many attempts. Try again in ${mins} minute(s).` }, 429);
    }
    const uIn = String(body.username ?? "");
    const pIn = String(body.password ?? "");
    let ok = false;
    try {
      const { data: vid } = await admin.rpc("kaizen_console_verify_login", { p_username: uIn, p_password: pIn });
      if (vid) ok = true;
    } catch { /* fall through to env */ }
    if (!ok && ADMIN_USER && ADMIN_PASS) {
      const [uOk, pOk] = await Promise.all([
        (async () => ctEq(await sha256(uIn), await sha256(ADMIN_USER)))(),
        (async () => ctEq(await sha256(pIn), await sha256(ADMIN_PASS)))(),
      ]);
      ok = uOk && pOk;
    }
    if (!ok) {
      const attempts = (rl?.attempts ?? 0) + 1;
      const locked = attempts >= MAX_ATTEMPTS;
      await admin.from("kaizen_console_login_attempts").upsert({
        ip, attempts: locked ? 0 : attempts,
        locked_until: locked ? new Date(Date.now() + LOCKOUT_MIN * 60000).toISOString() : null,
        last_attempt: new Date().toISOString(),
      });
      await audit("login_failed", { ip, attempts }, ip, false);
      return json({ error: "Invalid credentials." }, 401);
    }
    await admin.from("kaizen_console_login_attempts").delete().eq("ip", ip);
    const token = await makeToken();
    await audit("login_success", { ip }, ip, true);
    return json({ token, expiresAt: Date.now() + TOKEN_TTL_MS });
  }

  const token = req.headers.get("x-console-token") || body?.token;
  if (!(await verifyToken(token))) return json({ error: "Unauthorized" }, 401);

  if (action === "verify") return json({ ok: true });

  if (action === "get_settings") {
    const [adminsRes, settingsRes] = await Promise.all([
      admin.from("kaizen_console_admins").select("id, username, email, is_active, created_at").order("created_at", { ascending: true }),
      admin.from("kaizen_console_settings").select("*").eq("id", true).maybeSingle(),
    ]);
    return json({ admins: adminsRes.data ?? [], company: settingsRes.data ?? null });
  }

  if (action === "add_admin") {
    const username = normUser(body.username);
    const password = String(body.password ?? "");
    const email = cleanStr(body.email);
    if (!username) return json({ error: "Username is required." }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const { data: dup } = await admin.from("kaizen_console_admins").select("id").eq("username", username).maybeSingle();
    if (dup) return json({ error: "That username is already in use." }, 400);
    const { error } = await admin.rpc("kaizen_console_create_admin", { p_username: username, p_password: password, p_email: email });
    if (error) return json({ error: error.message }, 400);
    await audit("add_admin", { username }, ip, true);
    return json({ success: true });
  }

  if (action === "update_admin") {
    const admin_id = String(body.admin_id ?? "");
    if (!admin_id) return json({ error: "admin_id required" }, 400);
    const newUsername = body.username !== undefined ? normUser(body.username) : null;
    const newPassword = body.password ? String(body.password) : null;
    const newEmail = body.email !== undefined ? (cleanStr(body.email) ?? "") : null;
    if (newPassword !== null && newPassword.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    if (newUsername) {
      const { data: dup } = await admin.from("kaizen_console_admins").select("id").eq("username", newUsername).neq("id", admin_id).maybeSingle();
      if (dup) return json({ error: "That username is already in use." }, 400);
    }
    const { error } = await admin.rpc("kaizen_console_update_admin", { p_id: admin_id, p_username: newUsername, p_password: newPassword, p_email: newEmail });
    if (error) return json({ error: error.message }, 400);
    await audit("update_admin", { admin_id, username: newUsername, password_changed: !!newPassword }, ip, true);
    return json({ success: true });
  }

  if (action === "delete_admin") {
    const admin_id = String(body.admin_id ?? "");
    if (!admin_id) return json({ error: "admin_id required" }, 400);
    const { count } = await admin.from("kaizen_console_admins").select("id", { count: "exact", head: true }).eq("is_active", true);
    if ((count ?? 0) <= 1) return json({ error: "Cannot delete the last admin account." }, 400);
    const { error } = await admin.from("kaizen_console_admins").delete().eq("id", admin_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_admin", { admin_id }, ip, true);
    return json({ success: true });
  }

  if (action === "update_settings") {
    const patch = { updated_at: new Date().toISOString() };
    if (body.company_name !== undefined) patch.company_name = cleanStr(body.company_name);
    if (body.office_type !== undefined) patch.office_type = (body.office_type === "branch") ? "branch" : "head_office";
    if (body.branch_name !== undefined) patch.branch_name = cleanStr(body.branch_name);
    if (body.address !== undefined) patch.address = cleanStr(body.address);
    if (body.tax_id !== undefined) patch.tax_id = cleanStr(body.tax_id);
    if (body.logo_url !== undefined) patch.logo_url = body.logo_url ? String(body.logo_url) : null;
    const { error } = await admin.from("kaizen_console_settings").update(patch).eq("id", true);
    if (error) return json({ error: error.message }, 400);
    await audit("update_settings", { patch }, ip, true);
    return json({ success: true });
  }

  if (action === "list") {
    const [ownersRes, companiesRes, linksRes, countsRes, invRes] = await Promise.all([
      admin.from("kaizen_profiles").select("id, full_name, email, job_title, is_active, created_at, company_id").eq("role", "super_admin").order("created_at", { ascending: true }),
      admin.from("kaizen_companies").select("*").order("name"),
      admin.from("kaizen_super_admin_companies").select("super_admin_id, company_id"),
      admin.from("kaizen_profiles").select("company_id, role"),
      admin.from("kaizen_invoices").select("company_id, period_end"),
    ]);
    const owners = ownersRes.data ?? [];
    const companies = companiesRes.data ?? [];
    const links = linksRes.data ?? [];
    const profiles = countsRes.data ?? [];
    const invoices = invRes.data ?? [];
    const latestEnd = {};
    for (const r of invoices) {
      if (!latestEnd[r.company_id] || r.period_end > latestEnd[r.company_id]) latestEnd[r.company_id] = r.period_end;
    }
    const companyStats = companies.map((c) => ({
      ...c,
      live_managers: profiles.filter(p => p.company_id === c.id && p.role === "manager").length,
      live_staff: profiles.filter(p => p.company_id === c.id && p.role === "staff").length,
      subscription: subscriptionFromEnd(latestEnd[c.id] ?? null),
    }));
    const ownersOut = owners.map((o) => {
      const ids = links.filter(l => l.super_admin_id === o.id).map(l => l.company_id);
      return { ...o, companies: companyStats.filter(c => ids.includes(c.id)) };
    });
    return json({ owners: ownersOut, companies: companyStats });
  }

  if (action === "list_company_users") {
    const company_id = String(body.company_id ?? "");
    if (!company_id) return json({ error: "company_id required" }, 400);
    const { data } = await admin.from("kaizen_profiles")
      .select("id, full_name, email, username, role, department, is_active, avatar_url")
      .eq("company_id", company_id).in("role", ["manager", "staff"])
      .order("role").order("department").order("full_name");
    return json({ users: data ?? [] });
  }

  if (action === "delete_user") {
    const user_id = String(body.user_id ?? "");
    if (!user_id) return json({ error: "user_id required" }, 400);
    const { data: prof } = await admin.from("kaizen_profiles").select("role, email, full_name").eq("id", user_id).maybeSingle();
    if (!prof) return json({ error: "User not found." }, 400);
    if (prof.role === "super_admin") return json({ error: "Use owner management to delete owner accounts." }, 400);
    const { error } = await admin.auth.admin.deleteUser(user_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_user", { user_id, role: prof.role, name: prof.full_name }, ip, true);
    return json({ success: true });
  }

  if (action === "create_company") {
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "Company name is required." }, 400);
    const slug = normCode(body.slug || name);
    if (!slug) return json({ error: "Invalid slug." }, 400);
    const login_code = normCode(body.login_code || slug);
    const plan = body.plan ? String(body.plan) : "trial";
    const max_managers = (body.max_managers !== undefined && body.max_managers !== null && body.max_managers !== "") ? Number(body.max_managers) : null;
    const max_staff = (body.max_staff !== undefined && body.max_staff !== null && body.max_staff !== "") ? Number(body.max_staff) : null;
    const { data: dup } = await admin.from("kaizen_companies").select("id").eq("login_code", login_code).maybeSingle();
    if (dup) return json({ error: "That login code is already in use." }, 400);
    const pkg = await packageDefaults(plan);
    const { data, error } = await admin.from("kaizen_companies").insert({
      name, slug, plan, login_code,
      max_managers: max_managers ?? (pkg?.max_managers ?? null),
      max_staff: max_staff ?? (pkg?.max_staff ?? null),
      multi_company: !!(pkg?.multi_company),
      features: pkg?.features ?? {},
    }).select("id").single();
    if (error) return json({ error: error.message.includes("duplicate") ? "A company with that slug already exists." : error.message }, 400);
    await audit("create_company", { name, slug, plan, login_code }, ip, true);
    return json({ success: true, id: data.id });
  }

  if (action === "create_owner") {
    const full_name = String(body.full_name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const job_title = (String(body.job_title ?? "").trim()) || null;
    const is_active = body.is_active !== false;
    let company_ids = Array.isArray(body.company_ids) ? body.company_ids : [];
    const nc = body.new_company;
    if (!full_name || !email || password.length < 6) return json({ error: "Full name, email, and a password (min 6 chars) are required." }, 400);
    const atParts = email.split("@");
    if (atParts.length !== 2 || !atParts[1].includes(".") || email.includes(" ")) return json({ error: "Invalid email address." }, 400);

    let newCompanyId = null;
    if (nc?.name) {
      const slug = normCode(nc.slug || nc.name);
      const login_code = normCode(nc.login_code || slug);
      const { data: dupc } = await admin.from("kaizen_companies").select("id").eq("login_code", login_code).maybeSingle();
      if (dupc) return json({ error: "That company login code is already in use." }, 400);
      const ncPlan = nc.plan ?? "trial";
      const ncPkg = await packageDefaults(ncPlan);
      const { data: co, error: coErr } = await admin.from("kaizen_companies").insert({
        name: String(nc.name).trim(), slug, login_code,
        max_managers: nc.max_managers ?? (ncPkg?.max_managers ?? null),
        max_staff: nc.max_staff ?? (ncPkg?.max_staff ?? null),
        multi_company: !!(ncPkg?.multi_company),
        features: ncPkg?.features ?? {},
        plan: ncPlan,
      }).select("id").single();
      if (coErr) return json({ error: "Company: " + (coErr.message.includes("duplicate") ? "slug already exists" : coErr.message) }, 400);
      newCompanyId = co.id;
      company_ids = [...company_ids, co.id];
    }
    if (company_ids.length === 0) return json({ error: "Assign at least one company to the owner." }, 400);

    const { data: existing } = await admin.from("kaizen_profiles").select("id, role, full_name, company_id").eq("email", email).maybeSingle();
    if (existing) {
      if (existing.role !== "super_admin") {
        if (newCompanyId) await admin.from("kaizen_companies").delete().eq("id", newCompanyId);
        return json({ error: "That email is already used by a non-owner account." }, 400);
      }
      if (!nc?.name && !body.confirm_link) {
        let existing_company = null;
        if (existing.company_id) {
          const { data: hc } = await admin.from("kaizen_companies").select("name").eq("id", existing.company_id).maybeSingle();
          existing_company = hc?.name ?? null;
        }
        return json({ requires_confirmation: true, existing_name: existing.full_name, existing_company }, 200);
      }
      for (const cid of company_ids) {
        await admin.from("kaizen_super_admin_companies").upsert({ super_admin_id: existing.id, company_id: cid }, { onConflict: "super_admin_id,company_id", ignoreDuplicates: true });
      }
      await audit("link_existing_owner", { email, company_ids, confirmed: !nc?.name }, ip, true);
      return json({ success: true, id: existing.id, company_id: company_ids[0], linked_existing: true, owner_name: existing.full_name });
    }

    const { data: newUser, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (createErr) {
      if (newCompanyId) await admin.from("kaizen_companies").delete().eq("id", newCompanyId);
      return json({ error: createErr.message }, 400);
    }
    const uid = newUser.user.id;
    const { error: profErr } = await admin.from("kaizen_profiles").insert({
      id: uid, full_name, email, role: "super_admin", department: "top_management",
      job_title, is_active, company_id: company_ids[0],
    });
    if (profErr) {
      await admin.auth.admin.deleteUser(uid);
      if (newCompanyId) await admin.from("kaizen_companies").delete().eq("id", newCompanyId);
      return json({ error: profErr.message }, 400);
    }
    const crossLinks = company_ids.slice(1);
    if (crossLinks.length) {
      await admin.from("kaizen_super_admin_companies").insert(crossLinks.map((cid) => ({ super_admin_id: uid, company_id: cid })));
    }
    await audit("create_owner", { email, company_id: company_ids[0], cross: crossLinks }, ip, true);
    return json({ success: true, id: uid, company_id: company_ids[0] });
  }

  if (action === "set_owner_status") {
    const owner_id = String(body.owner_id ?? "");
    const is_active = body.is_active === true;
    if (!owner_id) return json({ error: "owner_id required" }, 400);
    const { data: prof } = await admin.from("kaizen_profiles").select("email").eq("id", owner_id).maybeSingle();
    if (prof?.email === FOUNDER && !is_active) return json({ error: "The founder account cannot be disabled." }, 403);
    const { error } = await admin.from("kaizen_profiles").update({ is_active }).eq("id", owner_id).eq("role", "super_admin");
    if (error) return json({ error: error.message }, 400);
    await audit("set_owner_status", { owner_id, is_active }, ip, true);
    return json({ success: true });
  }

  if (action === "delete_owner") {
    const owner_id = String(body.owner_id ?? "");
    if (!owner_id) return json({ error: "owner_id required" }, 400);
    const { data: prof } = await admin.from("kaizen_profiles").select("email").eq("id", owner_id).maybeSingle();
    if (prof?.email === FOUNDER) return json({ error: "The founder account cannot be deleted." }, 403);
    const { error } = await admin.auth.admin.deleteUser(owner_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_owner", { owner_id, email: prof?.email }, ip, true);
    return json({ success: true });
  }

  if (action === "link_owner_company") {
    const owner_id = String(body.owner_id ?? "");
    const company_id = String(body.company_id ?? "");
    if (!owner_id || !company_id) return json({ error: "owner_id and company_id required" }, 400);
    const { data: prof } = await admin.from("kaizen_profiles").select("id, company_id").eq("id", owner_id).eq("role", "super_admin").maybeSingle();
    if (!prof) return json({ error: "Member not found." }, 400);
    // Multi-company access requires the owner's home-company package to include it.
    if (prof.company_id) {
      const { data: homeCo } = await admin.from("kaizen_companies").select("multi_company, name, plan").eq("id", prof.company_id).maybeSingle();
      if (homeCo && homeCo.multi_company !== true) {
        return json({ error: `The ${homeCo.plan ?? "current"} package on ${homeCo.name ?? "this owner's home company"} does not include the multi-company feature. Upgrade to a package with multi-company to grant access to more companies.` }, 400);
      }
    }
    const { error } = await admin.from("kaizen_super_admin_companies").upsert({ super_admin_id: owner_id, company_id }, { onConflict: "super_admin_id,company_id", ignoreDuplicates: true });
    if (error) return json({ error: error.message }, 400);
    await audit("link_owner_company", { owner_id, company_id }, ip, true);
    return json({ success: true });
  }

  if (action === "unlink_owner_company") {
    const owner_id = String(body.owner_id ?? "");
    const company_id = String(body.company_id ?? "");
    if (!owner_id || !company_id) return json({ error: "owner_id and company_id required" }, 400);
    const { error } = await admin.from("kaizen_super_admin_companies").delete().eq("super_admin_id", owner_id).eq("company_id", company_id);
    if (error) return json({ error: error.message }, 400);
    await audit("unlink_owner_company", { owner_id, company_id }, ip, true);
    return json({ success: true });
  }

  if (action === "update_company") {
    const company_id = String(body.company_id ?? "");
    if (!company_id) return json({ error: "company_id required" }, 400);
    const patch = {};
    if (body.max_managers !== undefined) patch.max_managers = body.max_managers;
    if (body.max_staff !== undefined) patch.max_staff = body.max_staff;
    if (body.plan !== undefined) {
      patch.plan = String(body.plan);
      // Assigning a package applies its limits, multi-company flag and features.
      const pkg = await packageDefaults(patch.plan);
      if (pkg) {
        if (body.max_managers === undefined) patch.max_managers = pkg.max_managers;
        if (body.max_staff === undefined) patch.max_staff = pkg.max_staff;
        patch.multi_company = !!pkg.multi_company;
        patch.features = pkg.features ?? {};
      }
    }
    if (body.is_active !== undefined) patch.is_active = body.is_active;
    if (body.name !== undefined) patch.name = String(body.name).trim();
    if (body.contact_person !== undefined) patch.contact_person = cleanStr(body.contact_person);
    if (body.contact_phone !== undefined) patch.contact_phone = cleanStr(body.contact_phone);
    if (body.contact_email !== undefined) patch.contact_email = cleanStr(body.contact_email);
    if (body.address !== undefined) patch.address = cleanStr(body.address);
    if (body.tax_id !== undefined) patch.tax_id = cleanStr(body.tax_id);

    let repointed = 0;
    if (body.login_code !== undefined) {
      const newCode = normCode(body.login_code);
      if (!newCode) return json({ error: "Login code cannot be empty." }, 400);
      const { data: dup } = await admin.from("kaizen_companies").select("id").eq("login_code", newCode).neq("id", company_id).maybeSingle();
      if (dup) return json({ error: "That login code is already in use by another company." }, 400);
      const { data: cur } = await admin.from("kaizen_companies").select("login_code, slug").eq("id", company_id).maybeSingle();
      const oldCode = cur?.login_code ?? cur?.slug;
      patch.login_code = newCode;
      if (oldCode && oldCode !== newCode) {
        const { data: staff } = await admin.from("kaizen_profiles").select("id, username").eq("company_id", company_id).eq("role", "staff");
        for (const s of staff ?? []) {
          const newEmail = normUser(s.username || "") + "@" + newCode + ".staff.kaizen.internal";
          await admin.auth.admin.updateUserById(s.id, { email: newEmail, email_confirm: true });
          repointed++;
        }
      }
    }

    const { error } = await admin.from("kaizen_companies").update(patch).eq("id", company_id);
    if (error) return json({ error: error.message }, 400);
    await audit("update_company", { company_id, patch, repointed }, ip, true);
    return json({ success: true, repointed });
  }

  if (action === "delete_company") {
    const company_id = String(body.company_id ?? "");
    const password = String(body.password ?? "");
    if (!company_id) return json({ error: "company_id required" }, 400);
    if (!password) return json({ error: "Password is required to confirm removal." }, 400);
    let pwOk = false;
    try {
      const { data } = await admin.rpc("kaizen_console_password_matches", { p_password: password });
      if (data === true) pwOk = true;
    } catch { /* fall through */ }
    if (!pwOk && ADMIN_PASS) { pwOk = ctEq(await sha256(password), await sha256(ADMIN_PASS)); }
    if (!pwOk) { await audit("delete_company_bad_password", { company_id }, ip, false); return json({ error: "Incorrect password." }, 401); }
    const { data: co } = await admin.from("kaizen_companies").select("id, name, is_active").eq("id", company_id).maybeSingle();
    if (!co) return json({ error: "Company not found." }, 400);
    if (co.is_active) return json({ error: "Suspend the company before removing it." }, 400);
    const { data: profs } = await admin.from("kaizen_profiles").select("id, email").eq("company_id", company_id);
    if ((profs ?? []).some((p) => p.email === FOUNDER)) return json({ error: "This company cannot be removed." }, 403);
    const { data: invs } = await admin.from("kaizen_invoices").select("proof_path").eq("company_id", company_id);
    const paths = (invs ?? []).map((i) => i.proof_path).filter(Boolean);
    if (paths.length) { try { await admin.storage.from(INVOICE_BUCKET).remove(paths); } catch { /* ignore */ } }
    await admin.from("kaizen_cases").delete().eq("company_id", company_id);
    await admin.from("kaizen_settings").delete().eq("company_id", company_id);
    for (const p of profs ?? []) { try { await admin.auth.admin.deleteUser(p.id); } catch { /* ignore */ } }
    const { error } = await admin.from("kaizen_companies").delete().eq("id", company_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_company", { company_id, name: co.name, removed_accounts: (profs ?? []).length }, ip, true);
    return json({ success: true });
  }

  if (action === "list_invoices") {
    const company_id = String(body.company_id ?? "");
    if (!company_id) return json({ error: "company_id required" }, 400);
    const { data } = await admin.from("kaizen_invoices").select("*").eq("company_id", company_id).order("payment_date", { ascending: false });
    const rows = data ?? [];
    const invoices = [];
    for (const row of rows) {
      let proof_url = null;
      if (row.proof_path) {
        const { data: s } = await admin.storage.from(INVOICE_BUCKET).createSignedUrl(row.proof_path, 3600);
        proof_url = s?.signedUrl ?? null;
      }
      invoices.push({ ...row, proof_url });
    }
    let period_end = null;
    for (const r of rows) { if (!period_end || r.period_end > period_end) period_end = r.period_end; }
    return json({ invoices, subscription: subscriptionFromEnd(period_end) });
  }

  if (action === "add_invoice") {
    const company_id = String(body.company_id ?? "");
    const payment_date = String(body.payment_date ?? "");
    if (!company_id || !payment_date) return json({ error: "company_id and payment_date are required." }, 400);
    const pd = new Date(payment_date + "T00:00:00Z");
    if (isNaN(pd.getTime())) return json({ error: "Invalid payment date." }, 400);
    const pe = new Date(pd); pe.setUTCFullYear(pe.getUTCFullYear() + 1);
    const period_end = pe.toISOString().slice(0, 10);
    const payee = body.payee ? String(body.payee).trim() : null;
    const amount = (body.amount !== undefined && body.amount !== null && body.amount !== "") ? Number(body.amount) : null;
    const currency = body.currency ? String(body.currency) : "THB";
    const notes = body.notes ? String(body.notes).trim() : null;
    let proof_path = null;
    if (body.proof_base64) {
      const ext = (String(body.proof_ext || "jpg")).toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const bytes = decodeBase64(String(body.proof_base64));
      const path = company_id + "/" + crypto.randomUUID() + "." + ext;
      const { error: upErr } = await admin.storage.from(INVOICE_BUCKET).upload(path, bytes, { contentType: ct, upsert: false });
      if (upErr) return json({ error: "Proof upload: " + upErr.message }, 400);
      proof_path = path;
    }
    const { error } = await admin.from("kaizen_invoices").insert({
      company_id, payee, amount, currency, payment_date, period_start: payment_date, period_end, proof_path, notes,
    });
    if (error) return json({ error: error.message }, 400);
    await audit("add_invoice", { company_id, payment_date, amount }, ip, true);
    return json({ success: true, period_end });
  }

  if (action === "delete_invoice") {
    const invoice_id = String(body.invoice_id ?? "");
    if (!invoice_id) return json({ error: "invoice_id required" }, 400);
    const { data: inv } = await admin.from("kaizen_invoices").select("proof_path").eq("id", invoice_id).maybeSingle();
    if (inv?.proof_path) { await admin.storage.from(INVOICE_BUCKET).remove([inv.proof_path]); }
    const { error } = await admin.from("kaizen_invoices").delete().eq("id", invoice_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_invoice", { invoice_id }, ip, true);
    return json({ success: true });
  }

  // ── Form Generator (Quotation / Invoice / Tax Invoice-Receipt / Receipt) ──────
  const FORM_PREFIX = { quotation: "QT", invoice: "INV", tax_invoice_receipt: "TAX", receipt: "RC" };

  if (action === "list_forms") {
    const [formsRes, companiesRes, settingsRes, productsRes, promosRes] = await Promise.all([
      admin.from("kaizen_generated_forms").select("*").order("created_at", { ascending: false }),
      admin.from("kaizen_companies").select("id, name, address, tax_id, contact_person, contact_phone, contact_email").order("name"),
      admin.from("kaizen_console_settings").select("*").eq("id", true).maybeSingle(),
      admin.from("kaizen_products").select("*").eq("is_active", true).order("sort_order"),
      admin.from("kaizen_promo_codes").select("*").eq("is_active", true).order("created_at", { ascending: false }),
    ]);
    return json({
      forms: formsRes.data ?? [], companies: companiesRes.data ?? [], issuer: settingsRes.data ?? null,
      products: productsRes.data ?? [], promos: promosRes.data ?? [],
    });
  }

  // ── Products catalog ──────────────────────────────────────────────────────
  if (action === "list_products") {
    const { data } = await admin.from("kaizen_products").select("*").order("kind").order("sort_order");
    return json({ products: data ?? [] });
  }

  if (action === "upsert_product") {
    const p = body.product ?? {};
    const kind = ["package", "addon", "custom"].includes(p.kind) ? p.kind : "custom";
    const name = cleanStr(p.name);
    if (!name) return json({ error: "Product name is required." }, 400);
    const row = {
      kind, name,
      key: cleanStr(p.key),
      description: cleanStr(p.description),
      price: Number(p.price) || 0,
      currency: cleanStr(p.currency) ?? "THB",
      duration_label: cleanStr(p.duration_label),
      duration_days: (p.duration_days === null || p.duration_days === undefined || p.duration_days === "") ? null : Number(p.duration_days),
      max_managers: (p.max_managers === null || p.max_managers === undefined || p.max_managers === "") ? null : Number(p.max_managers),
      max_staff: (p.max_staff === null || p.max_staff === undefined || p.max_staff === "") ? null : Number(p.max_staff),
      multi_company: !!p.multi_company,
      features: (p.features && typeof p.features === "object") ? p.features : {},
      sort_order: Number(p.sort_order) || 0,
      is_active: p.is_active === undefined ? true : !!p.is_active,
      updated_at: new Date().toISOString(),
    };
    let res;
    if (p.id) res = await admin.from("kaizen_products").update(row).eq("id", String(p.id)).select("*").single();
    else res = await admin.from("kaizen_products").insert(row).select("*").single();
    if (res.error) return json({ error: res.error.message }, 400);
    // Keep companies on this package in sync with edited limits/authorities.
    if (res.data.kind === "package" && res.data.key) {
      await admin.from("kaizen_companies").update({
        max_managers: res.data.max_managers,
        max_staff: res.data.max_staff,
        multi_company: !!res.data.multi_company,
        features: res.data.features ?? {},
      }).eq("plan", res.data.key);
    }
    await audit("upsert_product", { id: res.data.id, name, kind }, ip, true);
    return json({ success: true, product: res.data });
  }

  if (action === "delete_product") {
    const product_id = String(body.product_id ?? "");
    if (!product_id) return json({ error: "product_id required" }, 400);
    const { error } = await admin.from("kaizen_products").delete().eq("id", product_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_product", { product_id }, ip, true);
    return json({ success: true });
  }

  // ── Promo codes ───────────────────────────────────────────────────────────
  if (action === "list_promos") {
    const { data } = await admin.from("kaizen_promo_codes").select("*").order("created_at", { ascending: false });
    return json({ promos: data ?? [] });
  }

  if (action === "upsert_promo") {
    const p = body.promo ?? {};
    const code = cleanStr(p.code);
    if (!code) return json({ error: "Promo code is required." }, 400);
    const row = {
      code: code.toUpperCase(),
      discount_percent: Math.max(0, Math.min(100, Number(p.discount_percent) || 0)),
      valid_from: cleanStr(p.valid_from),
      valid_to: cleanStr(p.valid_to),
      is_active: p.is_active === undefined ? true : !!p.is_active,
      notes: cleanStr(p.notes),
      updated_at: new Date().toISOString(),
    };
    let res;
    if (p.id) res = await admin.from("kaizen_promo_codes").update(row).eq("id", String(p.id)).select("*").single();
    else res = await admin.from("kaizen_promo_codes").insert(row).select("*").single();
    if (res.error) return json({ error: res.error.message }, 400);
    await audit("upsert_promo", { id: res.data.id, code: row.code }, ip, true);
    return json({ success: true, promo: res.data });
  }

  if (action === "delete_promo") {
    const promo_id = String(body.promo_id ?? "");
    if (!promo_id) return json({ error: "promo_id required" }, 400);
    const { error } = await admin.from("kaizen_promo_codes").delete().eq("id", promo_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_promo", { promo_id }, ip, true);
    return json({ success: true });
  }

  if (action === "create_form") {
    const form_type = String(body.form_type ?? "");
    if (!FORM_PREFIX[form_type]) return json({ error: "Invalid form type." }, 400);

    // Normalise + recompute totals server-side from the line items (never trust client maths).
    const items = Array.isArray(body.line_items) ? body.line_items : [];
    const cleanItems = items
      .map((it) => ({
        description: cleanStr(it?.description) ?? "",
        qty: Number(it?.qty) || 0,
        unit_price: Number(it?.unit_price) || 0,
      }))
      .filter((it) => it.description || it.qty || it.unit_price);
    if (cleanItems.length === 0) return json({ error: "Add at least one line item." }, 400);

    const vat_rate = (body.vat_rate !== undefined && body.vat_rate !== null && body.vat_rate !== "") ? Number(body.vat_rate) : 7;
    const non_vat_amount = Number(body.non_vat_amount) || 0;
    const subtotal = Math.round(cleanItems.reduce((s, it) => s + it.qty * it.unit_price, 0) * 100) / 100;
    // Promo discount applies to the subtotal BEFORE VAT.
    const discount_percent = Math.max(0, Math.min(100, Number(body.discount_percent) || 0));
    const discount_code = cleanStr(body.discount_code);
    const discount_amount = Math.round(subtotal * (discount_percent / 100) * 100) / 100;
    const net = Math.round((subtotal - discount_amount) * 100) / 100;
    const vat_amount = Math.round(net * (vat_rate / 100) * 100) / 100;
    const total = Math.round((net + vat_amount + non_vat_amount) * 100) / 100;

    const issue_date = String(body.issue_date || new Date().toISOString().slice(0, 10));
    const year = issue_date.slice(0, 4);
    const prefix = FORM_PREFIX[form_type];
    const { count } = await admin.from("kaizen_generated_forms")
      .select("id", { count: "exact", head: true })
      .eq("form_type", form_type)
      .like("doc_number", `${prefix}-${year}-%`);
    const doc_number = `${prefix}-${year}-${String((count ?? 0) + 1).padStart(4, "0")}`;

    const row = {
      form_type, doc_number,
      company_id: cleanStr(body.company_id),
      client_name: cleanStr(body.client_name),
      client_address: cleanStr(body.client_address),
      client_tax_id: cleanStr(body.client_tax_id),
      client_contact: cleanStr(body.client_contact),
      client_phone: cleanStr(body.client_phone),
      client_email: cleanStr(body.client_email),
      issue_date,
      due_date: cleanStr(body.due_date),
      line_items: cleanItems,
      currency: cleanStr(body.currency) ?? "THB",
      non_vat_amount, subtotal, vat_rate, vat_amount, total,
      discount_code, discount_percent, discount_amount,
      notes: cleanStr(body.notes),
      status: cleanStr(body.status) ?? "draft",
    };
    const { data: inserted, error } = await admin.from("kaizen_generated_forms").insert(row).select("*").single();
    if (error) return json({ error: error.message }, 400);
    await audit("create_form", { form_type, doc_number, company_id: row.company_id, total }, ip, true);
    return json({ success: true, form: inserted });
  }

  if (action === "update_form_status") {
    const form_id = String(body.form_id ?? "");
    const status = cleanStr(body.status);
    if (!form_id || !status) return json({ error: "form_id and status required" }, 400);
    const { error } = await admin.from("kaizen_generated_forms")
      .update({ status, updated_at: new Date().toISOString() }).eq("id", form_id);
    if (error) return json({ error: error.message }, 400);
    await audit("update_form_status", { form_id, status }, ip, true);
    return json({ success: true });
  }

  if (action === "delete_form") {
    const form_id = String(body.form_id ?? "");
    if (!form_id) return json({ error: "form_id required" }, 400);
    const { error } = await admin.from("kaizen_generated_forms").delete().eq("id", form_id);
    if (error) return json({ error: error.message }, 400);
    await audit("delete_form", { form_id }, ip, true);
    return json({ success: true });
  }

  if (action === "audit_log") {
    const { data } = await admin.from("kaizen_console_audit").select("*").order("created_at", { ascending: false }).limit(50);
    return json({ entries: data ?? [] });
  }

  return json({ error: "Unknown action" }, 400);
});
