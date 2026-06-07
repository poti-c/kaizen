// App-facing payment submission + optional SlipOK auto-verification.
// Called by the hotel app with the user's JWT. Inserts a payment submission and,
// when SLIPOK is configured and the slip verifies, activates the plan/add-on
// instantly; otherwise leaves it pending for manual approval in the Console.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

function addDays(unitDays: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + unitDays);
  return d.toISOString().slice(0, 10);
}

// Best-effort SlipOK verification. Returns { verified, amount } or { verified:false }.
// NOTE: finalise the exact request once a SlipOK account + branch id exist.
async function verifySlip(proofDataUrl: string, expectAmount: number | null) {
  const key = Deno.env.get("SLIPOK_API_KEY");
  const branch = Deno.env.get("SLIPOK_BRANCH_ID");
  if (!key || !branch || !proofDataUrl) return { verified: false };
  try {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(proofDataUrl);
    if (!m) return { verified: false };
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append("files", new Blob([bytes], { type: m[1] }), "slip.jpg");
    if (expectAmount) fd.append("amount", String(expectAmount));
    const res = await fetch(`https://api.slipok.com/api/line/apikey/${branch}`, {
      method: "POST", headers: { "x-authorization": key }, body: fd,
    });
    if (!res.ok) return { verified: false };
    const data = await res.json().catch(() => null);
    const ok = !!(data && (data.success === true || data?.data?.success === true));
    const amount = Number(data?.data?.amount ?? data?.amount ?? 0) || null;
    if (!ok) return { verified: false };
    if (expectAmount && amount && Math.abs(amount - expectAmount) > 1) return { verified: false }; // amount mismatch
    return { verified: true, amount };
  } catch (_) { return { verified: false }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userRes } = await userClient.auth.getUser();
  const uid = userRes?.user?.id;
  if (!uid) return json({ error: "Not authenticated" }, 401);

  const body = await req.json().catch(() => ({}));
  const { company_id, kind, target, target_label, amount, currency = "THB", proof_url } = body;
  if (!company_id || !kind || !target) return json({ error: "Missing fields" }, 400);

  // Verify the caller is a manager/owner of this company.
  const { data: prof } = await admin.from("kaizen_profiles").select("role, company_id").eq("id", uid).maybeSingle();
  if (!prof || (prof.role !== "super_admin" && prof.role !== "manager")) return json({ error: "Not authorised" }, 403);
  const { data: linked } = await admin.from("kaizen_super_admin_companies").select("company_id").eq("super_admin_id", uid).eq("company_id", company_id).maybeSingle();
  if (prof.company_id !== company_id && !linked) return json({ error: "Not authorised for this company" }, 403);

  const slip = await verifySlip(proof_url, amount ?? null);
  const status = slip.verified ? "approved" : "pending";

  const { data: sub, error } = await admin.from("kaizen_payment_submissions").insert({
    company_id, kind, target, target_label, amount, currency, proof_url, status,
    submitted_by: uid, reviewed_at: slip.verified ? new Date().toISOString() : null,
  }).select("id").single();
  if (error) return json({ error: error.message }, 400);

  if (slip.verified) {
    if (kind === "subscription") {
      const { data: prod } = await admin.from("kaizen_products").select("max_super_admins, max_managers, max_staff, multi_company, features, duration_days").eq("kind", "package").eq("key", target).maybeSingle();
      const term = Number(prod?.duration_days) || 365;
      const end = addDays(term);
      await admin.from("kaizen_companies").update({
        plan: target, subscription_end: end,
        max_super_admins: prod?.max_super_admins ?? null, max_managers: prod?.max_managers ?? null,
        max_staff: prod?.max_staff ?? null, multi_company: !!prod?.multi_company, features: prod?.features ?? {},
      }).eq("id", company_id);
      await admin.from("kaizen_invoices").insert({
        company_id, payee: target_label ?? target, amount, currency,
        payment_date: new Date().toISOString().slice(0, 10), period_start: new Date().toISOString().slice(0, 10), period_end: end,
        notes: "Auto-verified PromptPay payment (SlipOK)",
      });
    } else {
      const { data: co } = await admin.from("kaizen_companies").select("addons").eq("id", company_id).maybeSingle();
      const addons = (co?.addons && typeof co.addons === "object") ? co.addons : {};
      addons[target] = true;
      await admin.from("kaizen_companies").update({ addons }).eq("id", company_id);
    }
  }

  return json({ success: true, id: sub.id, status, verified: slip.verified });
});
