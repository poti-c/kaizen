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

// Hotel-local (Asia/Bangkok) calendar date — stable regardless of the server's UTC
// clock, so subscription_end / invoice dates don't drift a day during the 00:00–07:00
// Bangkok window the way raw toISOString() (UTC) did.
function bangkokDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function addDays(unitDays: number): string {
  return bangkokDate(new Date(Date.now() + unitDays * 86400000));
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Best-effort SlipOK verification. Returns { verified, amount } or { verified:false }.
// expectAmount is the SERVER-derived plan price (never the client's declared amount):
// when set, the slip MUST report a matching amount, so an absent/zero SlipOK amount
// can no longer auto-pass.
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
    if (expectAmount != null) fd.append("amount", String(expectAmount));
    const res = await fetch(`https://api.slipok.com/api/line/apikey/${branch}`, {
      method: "POST", headers: { "x-authorization": key }, body: fd,
    });
    if (!res.ok) return { verified: false };
    const data = await res.json().catch(() => null);
    // SlipOK nests the slip-verification result under `data.data`. Trust that inner
    // result when present; only fall back to the top-level envelope flag when there is
    // no nested object. Do NOT OR the two — an outer `success:true` envelope with an
    // inner `success:false` (request OK, slip invalid) must NOT pass verification.
    const inner = data?.data;
    const ok = !!(inner && typeof inner === "object" ? inner.success === true : data?.success === true);
    const amount = Number(data?.data?.amount ?? data?.amount ?? 0) || null;
    if (!ok) return { verified: false };
    // If we know the expected price, the slip MUST carry a matching amount. A missing
    // amount or a mismatch is NOT auto-verifiable — fall through to manual review.
    if (expectAmount != null) {
      if (!amount || Math.abs(amount - expectAmount) > 1) return { verified: false };
    }
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
  if (currency !== "THB") return json({ error: "Unsupported currency." }, 400);
  // Guard against an oversized base64 proof data-URL bloating the row and spiking
  // edge-function memory (the whole string is SHA-256'd in memory below). ~2 MB image
  // ≈ ~2.8M base64 chars; cap at 4M to leave headroom for legitimate slips.
  if (typeof proof_url === "string" && proof_url.length > 4_000_000) {
    return json({ error: "Payment slip image is too large. Please upload a smaller image." }, 413);
  }

  // Verify the caller is a manager/owner of this company.
  const { data: prof, error: profErr } = await admin.from("kaizen_profiles").select("role, company_id").eq("id", uid).maybeSingle();
  if (profErr) return json({ error: "Authorisation check failed — please try again." }, 500);
  if (!prof || (prof.role !== "super_admin" && prof.role !== "manager")) return json({ error: "Not authorised" }, 403);
  const { data: linked, error: linkedErr } = await admin.from("kaizen_super_admin_companies").select("company_id").eq("super_admin_id", uid).eq("company_id", company_id).maybeSingle();
  // super_admin: use the link table as sole authority — prof.company_id is their primary company,
  // not their billing scope (super_admins can span multiple companies via the link table).
  if (prof.role === "super_admin") {
    if (linkedErr) return json({ error: "Authorisation check failed — please try again." }, 500);
    if (!linked) return json({ error: "Not authorised for this company" }, 403);
  } else {
    if (!prof.company_id || prof.company_id !== company_id) return json({ error: "Not authorised for this company" }, 403);
  }

  // The price is SERVER-authoritative — look it up from kaizen_products by key (works for
  // both 'subscription' packages and 'addon' keys). Never trust the client-declared amount.
  const { data: priceRow, error: priceErr } = await admin.from("kaizen_products").select("price, duration_days, kind").eq("key", target).maybeSingle();
  if (priceErr) return json({ error: "Price lookup failed — please try again." }, 500);

  // KP-004: `kind` is client-supplied and was never checked against the product's own
  // kind. Because the lookups above and in the activation branch below match on `key`
  // alone, a manager could POST { kind: "subscription", target: "<addon key>" }, pay the
  // add-on's price, and have kaizen_activate_subscription run with the ADD-ON row:
  // add-ons carry NULL seat caps (read as unlimited) and NULL duration_days (falling back
  // to `|| 365`). A ฿10,000 add-on therefore bought an unlimited-seat, 365-day plan that
  // should cost ฿79,000. The reverse — a package key sent as an add-on — merged a plan
  // key into the company's addons JSONB.
  //
  // The product's own kind is the only authority here.
  if (priceRow?.kind) {
    const wantsSubscription = kind === "subscription";
    const kindOk = wantsSubscription
      ? priceRow.kind === "package"
      : (priceRow.kind === "addon" || priceRow.kind === "custom");
    if (!kindOk) {
      return json({ error: "That item cannot be purchased that way. Please refresh and try again." }, 400);
    }
  }
  const expectedPrice = (priceRow?.price != null && priceRow.price > 0) ? Number(priceRow.price) : null;
  // Store the authoritative price when known, so submission/invoice records can't be
  // under-stated by the client.
  const clientAmount = (typeof amount === "number" && isFinite(amount) && amount > 0) ? amount : null;
  const storedAmount = expectedPrice != null ? expectedPrice : clientAmount;

  // Idempotency: the same slip (proof) must not create a second submission / duplicate
  // plan activation + invoice on retry or replay. Dedup on a hash of the proof.
  const proofHash = proof_url ? await sha256Hex(String(proof_url)) : null;
  // KP-001: a row left in 'activation_failed' (slip verified, but a downstream activation
  // step failed) must stay retryable with the SAME slip — otherwise the proof_hash dedup
  // returns the stale failure forever and the paying customer can never self-heal.
  // activation_failed only happens BEFORE the company/addon was actually changed (prod
  // lookup / company update / addon RPC all fail before committing the change), so
  // re-running activation on the reused row is safe (no double extension).
  let reuseId: string | null = null;
  if (proofHash) {
    const { data: dup } = await admin.from("kaizen_payment_submissions")
      .select("id, status, kind, target").eq("company_id", company_id).eq("proof_hash", proofHash).maybeSingle();
    if (dup) {
      if (dup.status === "activation_failed") {
        if (dup.kind !== kind || dup.target !== target) {
          return json({ error: "This payment slip was submitted for a different purchase. Please contact support." }, 409);
        }
        reuseId = dup.id;
      } else return json({ success: true, id: dup.id, status: dup.status, verified: dup.status === "approved", duplicate: true });
    }
  } else {
    // Slip-free: dedup on (company_id, kind, target) with pending status to prevent repeated
    // unverified submissions for the same purchase from reaching the approval queue multiple times.
    const { data: pendingDup } = await admin.from("kaizen_payment_submissions")
      .select("id, status").eq("company_id", company_id).eq("kind", kind).eq("target", target).eq("status", "pending").maybeSingle();
    if (pendingDup) return json({ success: true, id: pendingDup.id, status: "pending", verified: false, duplicate: true });
  }

  // Only auto-verify when the expected price is known and > 0. A null expectedPrice
  // means price=0 (seeded placeholder) or no product row — in that case skip SlipOK
  // entirely so an unchecked amount can never auto-activate a plan.
  const slip = expectedPrice != null ? await verifySlip(proof_url, expectedPrice) : { verified: false };

  // Always (re)set the row to 'pending' first — we update to 'approved' only after ALL side
  // effects succeed. This prevents an approved-but-unactivated orphan record if any
  // downstream step (product lookup, company update, invoice) fails after the insert.
  let sub: { id: string } | null = null;
  if (reuseId) {
    // KP-DBLEXT-01: claim the activation_failed row atomically (compare-and-set on status)
    // so two concurrent retries of the same slip cannot both proceed to activation and
    // stack a second paid term. Whoever flips activation_failed->pending wins; a retry that
    // claims 0 rows short-circuits to the duplicate response instead of re-activating.
    const { data: claimed, error: resetErr } = await admin.from("kaizen_payment_submissions")
      .update({ status: "pending" }).eq("id", reuseId).eq("status", "activation_failed").select("id");
    if (resetErr) return json({ error: "Could not retry activation — please contact support." }, 500);
    if (!claimed || claimed.length === 0) {
      return json({ success: true, id: reuseId, status: "pending", verified: false, duplicate: true });
    }
    sub = { id: reuseId };
  } else {
    const { data: inserted, error } = await admin.from("kaizen_payment_submissions").insert({
      company_id, kind, target, target_label, amount: storedAmount, currency, proof_url, proof_hash: proofHash,
      status: "pending", submitted_by: uid, reviewed_at: null,
    }).select("id").single();
    if (error) {
      // Unique-violation on proof_hash = concurrent request already recorded this slip.
      if (/duplicate key|unique/i.test(error.message) && proofHash) {
        const { data: existing } = await admin.from("kaizen_payment_submissions")
          .select("id, status").eq("company_id", company_id).eq("proof_hash", proofHash).maybeSingle();
        if (existing?.status === "activation_failed") {
          // KP-007: this used to reset the row unconditionally, with no
          // `.eq('status','activation_failed')` compare-and-set, no row-count
          // check, and no error capture — unlike the KP-DBLEXT-01 claim below,
          // which this branch bypasses entirely (it assigns `sub` directly
          // instead of going through `reuseId`). Two concurrent requests
          // carrying the SAME slip that both lose the insert race both read
          // status === 'activation_failed' here and would both have flipped it
          // to 'pending' and proceeded — both calling the row-locked
          // kaizen_activate_subscription EXTEND, so the company got two paid
          // terms and two invoice rows for one payment. Mirror the reuseId
          // claim exactly: only the request that actually flips the row wins.
          const { data: claimed, error: claimErr } = await admin.from("kaizen_payment_submissions")
            .update({ status: "pending" }).eq("id", existing.id).eq("status", "activation_failed").select("id");
          if (claimErr) return json({ error: "Could not retry activation — please contact support." }, 500);
          if (!claimed || claimed.length === 0) {
            return json({ success: true, id: existing.id, status: "pending", verified: false, duplicate: true });
          }
          sub = { id: existing.id };
        } else if (existing) {
          return json({ success: true, id: existing.id, status: existing.status, verified: existing.status === "approved", duplicate: true });
        } else {
          return json({ error: error.message }, 400);
        }
      } else if (/duplicate key|unique/i.test(error.message) && !proofHash) {
        // Unique-violation on slip-free partial index = concurrent slip-free submission.
        const { data: existing } = await admin.from("kaizen_payment_submissions")
          .select("id, status").eq("company_id", company_id).eq("kind", kind).eq("target", target).eq("status", "pending").maybeSingle();
        if (existing) return json({ success: true, id: existing.id, status: "pending", verified: false, duplicate: true });
        return json({ error: error.message }, 400);
      } else {
        console.error('[kaizen-pay] insert error:', error.message);
        return json({ error: "Submission could not be recorded — please try again." }, 400);
      }
    } else {
      sub = inserted;
    }
  }
  if (!sub) return json({ error: "Submission could not be recorded." }, 500);

  if (slip.verified) {
    let activationErr: string | null = null;
    if (kind === "subscription") {
      // Look up by key alone (matching the price lookup at the top). Filtering on
      // kind='package' here caused a silent activation failure whenever a product's
      // kind column held any other value — the slip verified and money was taken,
      // but the plan never activated.
      const { data: prod, error: prodErr } = await admin.from("kaizen_products")
        .select("max_super_admins, max_managers, max_staff, multi_company, features, duration_days")
        .eq("key", target).maybeSingle();
      if (prodErr || !prod) {
        activationErr = "Product lookup failed — payment recorded but plan not activated. Contact support.";
      } else {
        const term = Number(prod?.duration_days) || 365;
        // KP-002: extend the subscription atomically in-DB (row-locked) instead of a
        // read-modify-write, so two concurrent verified renewals stack rather than
        // clobbering each other (the loser previously overwrote the winner, losing a paid
        // term). The function extends from the existing expiry, or anchors a first-ever
        // subscription to today in Asia/Bangkok, and returns the prior plan + new end.
        // KP-006: this used to read current expiry via a SEPARATE, UNLOCKED select before
        // calling the row-locked RPC, to use as the invoice's period_start. Two verified
        // renewals landing close together could both read the same pre-renewal expiry that
        // way — the RPC itself still serialized/stacked subscription_end correctly, but the
        // second payment's invoice period_start ended up wrong. old_end is now read INSIDE
        // the RPC's own FOR UPDATE lock and returned, closing that window.
        const { data: actRows, error: updateErr } = await admin.rpc("kaizen_activate_subscription", {
          p_company_id: company_id,
          p_plan: target,
          p_term_days: term,
          p_max_super_admins: prod?.max_super_admins ?? null,
          p_max_managers: prod?.max_managers ?? null,
          p_max_staff: prod?.max_staff ?? null,
          p_multi_company: !!prod?.multi_company,
          p_features: prod?.features ?? {},
        });
        const act = Array.isArray(actRows) ? actRows[0] : actRows;
        if (updateErr || !act) {
          activationErr = "Plan activation failed — payment recorded, contact support to apply your plan.";
        } else {
          const fromPlan = act.from_plan ?? null;
          const end = act.new_end as string;
          const periodStart = act.old_end ? (act.old_end as string).slice(0, 10) : bangkokDate();
          if (fromPlan !== target) {
            const { error: pcErr } = await admin.from("kaizen_plan_changes").insert({ company_id, from_plan: fromPlan, to_plan: target, source: "payment" });
            if (pcErr) console.error("[kaizen-pay] plan_changes insert failed", sub.id, company_id, pcErr.message);
          }
          // KP-INVCHK-02: the subscription is ALREADY activated (row-locked RPC); re-running
          // it on a retry would double-extend (KP-DBLEXT-01), so we must NOT mark this
          // activation_failed on an invoice error. Instead log loudly with the identifiers
          // needed to reconcile the missing invoice manually.
          const { error: invErr } = await admin.from("kaizen_invoices").insert({
            company_id, payee: target_label ?? target, amount: storedAmount, currency,
            payment_date: bangkokDate(), period_start: periodStart, period_end: end,
            notes: "Auto-verified PromptPay payment (SlipOK)",
          });
          if (invErr) console.error("[kaizen-pay] ACCOUNTING GAP: subscription invoice insert failed after activation", sub.id, company_id, target, storedAmount, invErr.message);
        }
      }
    } else {
      // Atomic JSONB merge via SQL: avoids the read-modify-write race where two concurrent
      // payments for different add-ons clobber each other.
      const { error: rpcErr } = await admin.rpc("kaizen_merge_company_addon", { p_company_id: company_id, p_addon_key: target });
      if (rpcErr) {
        activationErr = "Add-on activation failed — payment recorded, contact support.";
      } else {
        const addonDays = priceRow?.duration_days ? Number(priceRow.duration_days) : null;
        const addonEnd = addonDays ? bangkokDate(new Date(Date.now() + addonDays * 86400000)) : '2099-12-31';
        const { error: invErr } = await admin.from("kaizen_invoices").insert({
          company_id, payee: target_label ?? target, amount: storedAmount, currency,
          payment_date: bangkokDate(), period_start: bangkokDate(), period_end: addonEnd,
          notes: "Auto-verified PromptPay payment (SlipOK) — addon",
        });
        // KP-INVCHK-02: kaizen_merge_company_addon is an idempotent JSONB merge, so a retry
        // is safe — surface the missing invoice so it doesn't become a silent accounting gap.
        if (invErr) console.error("[kaizen-pay] ACCOUNTING GAP: addon invoice insert failed after activation", sub.id, company_id, target, storedAmount, invErr.message);
      }
    }

    if (activationErr) {
      // Mark as activation_failed so the slip-free dedup doesn't permanently block retries.
      //
      // KP-006: this previously ended in `.catch(() => {})`. A PostgrestFilterBuilder is a
      // bare PromiseLike — it implements then() but has no catch() — so that call threw
      // TypeError synchronously, before the update was ever sent. The row therefore kept
      // its old status, the dedup guard went on blocking retries, and the customer was
      // left having paid with no plan and no way to resubmit. supabase-js resolves with
      // { error } rather than rejecting, so the result is checked instead.
      const { error: markErr } = await admin.from("kaizen_payment_submissions")
        .update({ status: "activation_failed" })
        .eq("id", sub.id);
      if (markErr) console.error("[kaizen-pay] could not mark submission activation_failed", sub.id, markErr.message);
      return json({ error: activationErr }, 500);
    }

    // All side effects succeeded — mark as approved now. Surface (log) an update
    // failure: the plan is already active, so a record left in 'pending' would be a
    // misleading state in the Console review queue.
    const { error: approveErr } = await admin.from("kaizen_payment_submissions")
      .update({ status: "approved", reviewed_at: new Date().toISOString() })
      .eq("id", sub.id);
    if (approveErr) {
      console.error("payment activated but status update to 'approved' failed", sub.id, approveErr.message);
    }
  }

  return json({ success: true, id: sub.id, status: slip.verified ? "approved" : "pending", verified: slip.verified });
});
