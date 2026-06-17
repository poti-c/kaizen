// kaizen-push — delivers Web Push to a user's devices when a kaizen_notifications row
// is inserted. The DB trigger (kaizen_trigger_push_notification) POSTs the new row here
// with no Authorization header, so this function MUST be deployed with verify_jwt=false;
// it uses the service role internally and never trusts client input for auth.
//
// Required function secrets:
//   VAPID_PUBLIC_KEY   — same key as the client's VITE_VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY  — the matching private key (NEVER commit this)
//   VAPID_SUBJECT      — a mailto: or https: contact, e.g. mailto:ops@nanirand.com
// Without them the function no-ops gracefully (logs and returns 200) so the trigger
// never errors.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ── Localized notification templates ──────────────────────────────────────────
// Kept in sync with src/lib/i18nDynamic.ts (NOTIF_TEMPLATES). If you change one,
// change the other. Falls back to the row's stored English title/message.
type Lang = "en" | "th";
type P = Record<string, string | number>;
const th = (l: Lang) => l === "th";
const TEMPLATES: Record<string, { title: (p: P, l: Lang) => string; body: (p: P, l: Lang) => string }> = {
  case_new: {
    title: (_p, l) => th(l) ? "มีการแจ้งเคสใหม่" : "New Case Reported",
    body: (p, l) => th(l) ? `${p.reporter} แจ้งเคส "${p.title}" (${p.caseNo})` : `${p.reporter} reported: "${p.title}" (${p.caseNo})`,
  },
  case_assigned_pic: {
    title: (_p, l) => th(l) ? "ได้รับมอบหมายเป็นผู้รับผิดชอบ" : "Assigned as In Charge",
    body: (p, l) => th(l) ? `คุณได้รับมอบหมายให้รับผิดชอบเคส ${p.caseNo}` : `You have been assigned as In Charge for case ${p.caseNo}.`,
  },
  case_dept_update: {
    title: (_p, l) => th(l) ? "อัปเดตเคสของแผนก" : "Department Case Update",
    body: (p, l) => th(l) ? `${p.names} ได้รับมอบหมายให้รับผิดชอบเคส ${p.caseNo}` : `${p.names} assigned as In Charge for case ${p.caseNo}.`,
  },
  case_ready_approval: {
    title: (_p, l) => th(l) ? "เคสรอการอนุมัติ" : "Case Ready for Approval",
    body: (p, l) => th(l) ? `${p.actor} แก้ไขเคส ${p.caseNo} เสร็จแล้ว รอการอนุมัติจากคุณ` : `${p.actor} resolved case ${p.caseNo} — awaiting your approval.`,
  },
  case_resolved: {
    title: (_p, l) => th(l) ? "แก้ไขเคสแล้ว" : "Case Resolved",
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ได้รับการแก้ไขแล้ว รอผู้จัดการอนุมัติ` : `Case ${p.caseNo} resolved — pending manager approval.`,
  },
  case_ready_close: {
    title: (_p, l) => th(l) ? "เคสพร้อมปิด" : "Case Ready to Close",
    body: (p, l) => th(l) ? `เคส ${p.caseNo} รอการปิดโดยผู้บริหารระดับสูง` : `Case ${p.caseNo} — awaiting closure by Top Management.`,
  },
  case_awaiting_closure: {
    title: (_p, l) => th(l) ? "เคสรอการปิดขั้นสุดท้าย" : "Case Awaiting Final Closure",
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ได้รับการอนุมัติโดย ${p.actor} พร้อมให้ผู้บริหารระดับสูงตรวจสอบและปิด` : `Case ${p.caseNo} approved by ${p.actor} — ready for Top Management review and closure.`,
  },
  case_closed: {
    title: (_p, l) => th(l) ? "ปิดเคสแล้ว" : "Case Closed",
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ได้รับการตรวจสอบและปิดอย่างเป็นทางการโดยผู้บริหารระดับสูง` : `Case ${p.caseNo} has been reviewed and officially closed by Top Management.`,
  },
  case_reopened: {
    title: (_p, l) => th(l) ? "เปิดเคสอีกครั้ง" : "Case Reopened",
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ถูกเปิดอีกครั้งโดย ${p.actor} และต้องดำเนินการเพิ่มเติม` : `Case ${p.caseNo} has been reopened by ${p.actor} and requires further action.`,
  },
  case_mentioned: {
    title: (p, l) => th(l) ? `${p.actor} กล่าวถึงคุณใน ${p.caseNo}` : `${p.actor} mentioned you in ${p.caseNo}`,
    body: (p) => `${p.text}`,
  },
  case_mentioned_all: {
    title: (p, l) => th(l) ? `${p.actor} กล่าวถึงทุกคนใน ${p.caseNo}` : `${p.actor} mentioned everyone in ${p.caseNo}`,
    body: (p) => `${p.text}`,
  },
  case_dept_assigned: {
    title: (_p, l) => th(l) ? "เคสถูกมอบหมายให้แผนกของคุณ" : "Case Assigned to Your Department",
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ถูกมอบหมายเพิ่มเติมให้แผนกของคุณโดยผู้ดูแลระบบ` : `Case ${p.caseNo} additionally assigned to your department by Super Admin.`,
  },
  case_priority_changed: {
    title: (_p, l) => th(l) ? "เปลี่ยนระดับความสำคัญของเคส" : "Case Priority Changed",
    body: (p, l) => {
      const pr: Record<string, { en: string; th: string }> = {
        low: { en: "Low", th: "ต่ำ" }, medium: { en: "Medium", th: "ปานกลาง" },
        high: { en: "High", th: "สูง" }, critical: { en: "Critical", th: "วิกฤต" },
      };
      const w = pr[String(p.priority)] ? (th(l) ? pr[String(p.priority)].th : pr[String(p.priority)].en) : String(p.priority);
      return th(l) ? `ระดับความสำคัญของเคส ${p.caseNo} เปลี่ยนเป็น ${w}` : `Case ${p.caseNo} priority changed to ${w}.`;
    },
  },
  case_auto_pic: {
    title: (_p, l) => th(l) ? "ได้รับมอบหมายผู้รับผิดชอบโดยอัตโนมัติ" : "Auto-assigned as In Charge",
    body: (p, l) => th(l) ? `สมาชิกที่ถูกลบทำให้เคส ${p.caseNo} ไม่มีผู้รับผิดชอบ คุณจึงได้รับมอบหมาย สามารถมอบหมายใหม่ได้ทุกเมื่อ` : `A removed team member left case ${p.caseNo} without an owner — you have been assigned as In Charge. You can reassign it anytime.`,
  },
};

function localize(row: any, lang: Lang): { title: string; body: string } {
  const tpl = row.title_key ? TEMPLATES[row.title_key] : undefined;
  if (!tpl) return { title: row.title ?? "Kaizen", body: row.message ?? "" };
  const p = (row.body_params ?? {}) as P;
  return { title: tpl.title(p, lang), body: tpl.body(p, lang) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
  const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@nanirand.com";
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log("[kaizen-push] VAPID keys not configured — skipping push (no-op).");
    return json({ skipped: "vapid_not_configured" });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const row = await req.json().catch(() => null);
  const userId = row?.user_id;
  if (!userId) return json({ error: "missing user_id" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // Recipient language (persisted from the app); count their unread for the badge.
  const [{ data: prof }, { count: unread }, { data: subs }] = await Promise.all([
    admin.from("kaizen_profiles").select("preferred_lang").eq("id", userId).maybeSingle(),
    admin.from("kaizen_notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("is_read", false),
    admin.from("kaizen_push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId),
  ]);
  const lang: Lang = (prof?.preferred_lang === "th") ? "th" : "en";
  const subscriptions = subs ?? [];
  if (subscriptions.length === 0) return json({ sent: 0, reason: "no_subscriptions" });

  const { title, body } = localize(row, lang);
  const payload = JSON.stringify({
    title,
    body,
    url: row.case_id ? `/cases/${row.case_id}` : "/notifications",
    caseId: row.case_id ?? undefined,
    unreadCount: unread ?? 0,
  });

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(subscriptions.map(async (s: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
    } catch (err: any) {
      // 404/410 mean the subscription is gone — prune it so we stop trying.
      const code = err?.statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
      else console.log("[kaizen-push] send failed", code, err?.body ?? err?.message);
    }
  }));

  if (dead.length > 0) await admin.from("kaizen_push_subscriptions").delete().in("id", dead);

  return json({ sent, pruned: dead.length });
});
