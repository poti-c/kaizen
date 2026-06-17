// Localization for DYNAMIC, persisted strings (case timeline actions + notifications).
// These are stored in the DB, so we localize at RENDER time to the reader's language.

type Lang = 'en' | 'th'

// ── Case-timeline action verbs ────────────────────────────────────────────────
const TIMELINE_ACTIONS: Record<string, { en: string; th: string }> = {
  created: { en: 'Case created', th: 'สร้างเคส' },
  case_created: { en: 'Case created', th: 'สร้างเคส' },
  info_corrected: { en: 'Registration info updated', th: 'แก้ไขข้อมูลการลงทะเบียน' },
  case_assigned: { en: 'Case assigned', th: 'มอบหมายเคส' },
  pic_changed: { en: 'Person in charge changed', th: 'เปลี่ยนผู้รับผิดชอบ' },
  dept_notified: { en: 'Departments notified', th: 'แจ้งแผนกที่เกี่ยวข้อง' },
  department_added: { en: 'Department added', th: 'เพิ่มแผนก' },
  due_date_set: { en: 'Due date set', th: 'กำหนดวันครบกำหนด' },
  resolved: { en: 'Resolved', th: 'แก้ไขเสร็จสิ้น' },
  manager_approved: { en: 'Approved by manager', th: 'ผู้จัดการอนุมัติ' },
  closed: { en: 'Closed', th: 'ปิดเคส' },
  reopened: { en: 'Reopened', th: 'เปิดเคสอีกครั้ง' },
  case_edited: { en: 'Case edited', th: 'แก้ไขเคส' },
  priority_changed: { en: 'Priority changed', th: 'เปลี่ยนระดับความสำคัญ' },
}

/** Localized header for a case-timeline action; falls back to the de-slugified slug. */
export function timelineActionLabel(action: string, lang: string): string {
  const hit = TIMELINE_ACTIONS[action]
  if (hit) return lang === 'th' ? hit.th : hit.en
  return action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Notifications (structured key + params) ───────────────────────────────────
// Inserts store a stable `title_key` and `body_params` jsonb; we render the
// reader's language here. `title`/`message` remain on the row as an English
// fallback (for older clients and push payloads).
export type NotifParams = Record<string, string | number>

interface NotifTemplate { title: (p: NotifParams, l: Lang) => string; body: (p: NotifParams, l: Lang) => string }
const th = (l: Lang) => l === 'th'

export const NOTIF_TEMPLATES: Record<string, NotifTemplate> = {
  case_new: {
    title: (_p, l) => th(l) ? 'มีการแจ้งเคสใหม่' : 'New Case Reported',
    body: (p, l) => th(l) ? `${p.reporter} แจ้งเคส "${p.title}" (${p.caseNo})` : `${p.reporter} reported: "${p.title}" (${p.caseNo})`,
  },
  case_assigned_pic: {
    title: (_p, l) => th(l) ? 'ได้รับมอบหมายเป็นผู้รับผิดชอบ' : 'Assigned as In Charge',
    body: (p, l) => th(l) ? `คุณได้รับมอบหมายให้รับผิดชอบเคส ${p.caseNo}` : `You have been assigned as In Charge for case ${p.caseNo}.`,
  },
  case_dept_update: {
    title: (_p, l) => th(l) ? 'อัปเดตเคสของแผนก' : 'Department Case Update',
    body: (p, l) => th(l) ? `${p.names} ได้รับมอบหมายให้รับผิดชอบเคส ${p.caseNo}` : `${p.names} assigned as In Charge for case ${p.caseNo}.`,
  },
  case_ready_approval: {
    title: (_p, l) => th(l) ? 'เคสรอการอนุมัติ' : 'Case Ready for Approval',
    body: (p, l) => th(l) ? `${p.actor} แก้ไขเคส ${p.caseNo} เสร็จแล้ว รอการอนุมัติจากคุณ` : `${p.actor} resolved case ${p.caseNo} — awaiting your approval.`,
  },
  case_resolved: {
    title: (_p, l) => th(l) ? 'แก้ไขเคสแล้ว' : 'Case Resolved',
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ได้รับการแก้ไขแล้ว รอผู้จัดการอนุมัติ` : `Case ${p.caseNo} resolved — pending manager approval.`,
  },
  case_ready_close: {
    title: (_p, l) => th(l) ? 'เคสพร้อมปิด' : 'Case Ready to Close',
    body: (p, l) => th(l) ? `เคส ${p.caseNo} รอการปิดโดยผู้บริหารระดับสูง` : `Case ${p.caseNo} — awaiting closure by Top Management.`,
  },
  case_awaiting_closure: {
    title: (_p, l) => th(l) ? 'เคสรอการปิดขั้นสุดท้าย' : 'Case Awaiting Final Closure',
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ได้รับการอนุมัติโดย ${p.actor} พร้อมให้ผู้บริหารระดับสูงตรวจสอบและปิด` : `Case ${p.caseNo} approved by ${p.actor} — ready for Top Management review and closure.`,
  },
  case_closed: {
    title: (_p, l) => th(l) ? 'ปิดเคสแล้ว' : 'Case Closed',
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ได้รับการตรวจสอบและปิดอย่างเป็นทางการโดยผู้บริหารระดับสูง` : `Case ${p.caseNo} has been reviewed and officially closed by Top Management.`,
  },
  case_reopened: {
    title: (_p, l) => th(l) ? 'เปิดเคสอีกครั้ง' : 'Case Reopened',
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ถูกเปิดอีกครั้งโดย ${p.actor} และต้องดำเนินการเพิ่มเติม` : `Case ${p.caseNo} has been reopened by ${p.actor} and requires further action.`,
  },
  case_mentioned: {
    title: (p, l) => th(l) ? `${p.actor} กล่าวถึงคุณใน ${p.caseNo}` : `${p.actor} mentioned you in ${p.caseNo}`,
    body: (p, l) => th(l) ? `${p.text}` : `${p.text}`,
  },
  case_mentioned_all: {
    title: (p, l) => th(l) ? `${p.actor} กล่าวถึงทุกคนใน ${p.caseNo}` : `${p.actor} mentioned everyone in ${p.caseNo}`,
    body: (p) => `${p.text}`,
  },
  case_dept_assigned: {
    title: (_p, l) => th(l) ? 'เคสถูกมอบหมายให้แผนกของคุณ' : 'Case Assigned to Your Department',
    body: (p, l) => th(l) ? `เคส ${p.caseNo} ถูกมอบหมายเพิ่มเติมให้แผนกของคุณโดยผู้ดูแลระบบ` : `Case ${p.caseNo} additionally assigned to your department by Super Admin.`,
  },
  case_priority_changed: {
    title: (_p, l) => th(l) ? 'เปลี่ยนระดับความสำคัญของเคส' : 'Case Priority Changed',
    body: (p, l) => {
      const pr: Record<string, { en: string; th: string }> = {
        low: { en: 'Low', th: 'ต่ำ' }, medium: { en: 'Medium', th: 'ปานกลาง' },
        high: { en: 'High', th: 'สูง' }, critical: { en: 'Critical', th: 'วิกฤต' },
      }
      const w = pr[String(p.priority)] ? (th(l) ? pr[String(p.priority)].th : pr[String(p.priority)].en) : String(p.priority)
      return th(l) ? `ระดับความสำคัญของเคส ${p.caseNo} เปลี่ยนเป็น ${w}` : `Case ${p.caseNo} priority changed to ${w}.`
    },
  },
  settings_items_removed: {
    title: (_p, l) => th(l) ? 'พบเคสที่ข้อมูลไม่สมบูรณ์' : 'Incomplete cases detected',
    body: (p, l) => {
      const kind = th(l)
        ? ({ location: 'สถานที่', category: 'หมวดหมู่', department: 'แผนก' }[String(p.kind)] ?? String(p.kind))
        : String(p.kind)
      return th(l)
        ? `มี ${p.count} เคสที่เปิดอยู่ซึ่งมี${kind}ที่ถูกลบ: ${p.items} กรุณาอัปเดตเคสที่เกี่ยวข้อง`
        : `${p.count} open case${Number(p.count) > 1 ? 's' : ''} have a ${kind} that was removed: ${p.items}. Please update the affected cases.`
    },
  },
  case_auto_pic: {
    title: (_p, l) => th(l) ? 'ได้รับมอบหมายผู้รับผิดชอบโดยอัตโนมัติ' : 'Auto-assigned as In Charge',
    body: (p, l) => th(l) ? `สมาชิกที่ถูกลบทำให้เคส ${p.caseNo} ไม่มีผู้รับผิดชอบ คุณจึงได้รับมอบหมาย สามารถมอบหมายใหม่ได้ทุกเมื่อ` : `A removed team member left case ${p.caseNo} without an owner — you have been assigned as In Charge. You can reassign it anytime.`,
  },
}

/** Resolve a notification to the reader's language; falls back to stored title/message. */
export function localizeNotif(
  n: { title: string; message: string; title_key?: string | null; body_params?: NotifParams | null },
  lang: string,
): { title: string; message: string } {
  const tpl = n.title_key ? NOTIF_TEMPLATES[n.title_key] : undefined
  if (!tpl) return { title: n.title, message: n.message }
  const l: Lang = lang === 'th' ? 'th' : 'en'
  const p = n.body_params ?? {}
  return { title: tpl.title(p, l), message: tpl.body(p, l) }
}
