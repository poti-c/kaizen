import { deptLabel } from '@/types'
import { formatDueBy } from '@/lib/utils'
import { timelineActionLabel } from '@/lib/i18nDynamic'
import type { KaizenCase, KaizenProfile, KaizenCaseTimeline, KaizenCasePhoto } from '@/types'

export const CATEGORY_LABELS_EN: Record<string, string> = {
  maintenance: 'Maintenance', cleanliness: 'Cleanliness', safety: 'Safety',
  guest_complaint: 'Guest Complaint', equipment: 'Equipment', other: 'Other',
  preventive_maintenance: 'Preventive Maintenance',
}
const CATEGORY_LABELS_TH: Record<string, string> = {
  maintenance: 'งานซ่อมบำรุง', cleanliness: 'ความสะอาด', safety: 'ความปลอดภัย',
  guest_complaint: 'ข้อร้องเรียนจากแขก', equipment: 'อุปกรณ์', other: 'อื่นๆ',
  preventive_maintenance: 'บำรุงรักษาเชิงป้องกัน',
}

// Escape user-controlled values before interpolating into the print HTML. The result
// is fed to a same-origin window via document.write(), so an unescaped case title /
// description / photo URL / timeline note would be stored XSS. Safe for text and
// double-quoted attribute contexts.
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Build a standalone printable HTML document for a case.
 * Pure function — no DOM side effects; the caller handles window.open/print.
 */
export function buildCasePrintHtml(
  kcase: KaizenCase,
  photos: KaizenCasePhoto[],
  timeline: KaizenCaseTimeline[],
  lang: 'en' | 'th' = 'en',
): string {
  const problemPhotosList = photos.filter((p) => p.photo_type === 'problem')
  const resolutionPhotosList = photos.filter((p) => p.photo_type === 'resolution')
  const th = lang === 'th'
  const loc = th ? 'th-TH' : 'en-GB'
  const L = {
    brand: th ? 'ระบบไคเซ็น นา นิรันดร์' : 'Na Nirand Kaizen System',
    recurring: th ? 'เกิดซ้ำ' : 'Recurring',
    department: th ? 'แผนก' : 'Department',
    created: th ? 'วันที่สร้าง' : 'Created',
    dueDate: th ? 'วันครบกำหนด' : 'Due Date',
    reporter: th ? 'ผู้แจ้ง' : 'Reporter',
    unknown: th ? 'ไม่ทราบ' : 'Unknown',
    description: th ? 'รายละเอียด' : 'Description',
    proposedSolution: th ? 'แนวทางแก้ไขที่เสนอ' : 'Proposed Solution',
    assignedDepartments: th ? 'แผนกที่ได้รับมอบหมาย' : 'Assigned Departments',
    problemPhotos: th ? 'รูปปัญหา' : 'Problem Photos',
    resolutionPhotos: th ? 'รูปการแก้ไข' : 'Resolution Photos',
    timeline: th ? 'ไทม์ไลน์' : 'Timeline',
    printed: th ? 'พิมพ์เมื่อ' : 'Printed',
  }
  const catLabel = kcase.category ? ((th ? CATEGORY_LABELS_TH[kcase.category] : CATEGORY_LABELS_EN[kcase.category]) || kcase.category) : ''

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${th ? 'เคส' : 'Case'} ${esc(kcase.case_number)} — Na Nirand Kaizen</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; padding: 40px; font-size: 13px; }
        h1 { font-size: 22px; margin-bottom: 6px; }
        h2 { font-size: 15px; font-weight: 600; margin: 24px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
        .header { border-bottom: 2px solid #111; padding-bottom: 16px; margin-bottom: 20px; }
        .brand { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #666; margin-bottom: 8px; }
        .meta { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 8px; }
        .meta-item { display: flex; flex-direction: column; }
        .meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
        .meta-value { font-weight: 600; margin-top: 2px; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; border: 1px solid #ddd; margin-right: 4px; }
        p { line-height: 1.6; color: #333; }
        .section { margin-bottom: 16px; }
        .timeline-item { display: flex; gap: 12px; margin-bottom: 10px; }
        .timeline-dot { width: 8px; height: 8px; border-radius: 50%; background: #333; margin-top: 5px; flex-shrink: 0; }
        .timeline-content p { font-size: 12px; }
        .timeline-content .action { font-weight: 600; text-transform: capitalize; }
        .timeline-content .time { color: #888; font-size: 11px; margin-top: 2px; }
        .photos { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
        .photos img { width: 180px; height: 120px; object-fit: cover; border-radius: 4px; border: 1px solid #eee; }
        .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; font-size: 11px; color: #999; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="brand">${L.brand}</div>
        <h1>${esc(kcase.title)}</h1>
        <div>
          <span class="badge">${esc(kcase.case_number)}</span>
          <span class="badge">${esc(kcase.priority.toUpperCase())}</span>
          <span class="badge">${esc(kcase.status.replace(/_/g, ' ').toUpperCase())}</span>
          ${catLabel ? `<span class="badge">${esc(catLabel)}</span>` : ''}
          ${kcase.is_recurring ? `<span class="badge">${L.recurring}</span>` : ''}
        </div>
        <div class="meta">
          <div class="meta-item"><span class="meta-label">${L.department}</span><span class="meta-value">${esc(deptLabel(kcase.department, lang))}</span></div>
          <div class="meta-item"><span class="meta-label">${L.created}</span><span class="meta-value">${new Date(kcase.created_at).toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
          ${kcase.due_date ? `<div class="meta-item"><span class="meta-label">${L.dueDate}</span><span class="meta-value">${esc(formatDueBy(kcase.due_date, lang))}</span></div>` : ''}
          <div class="meta-item"><span class="meta-label">${L.reporter}</span><span class="meta-value">${esc((kcase.creator as KaizenProfile)?.full_name || L.unknown)}</span></div>
        </div>
      </div>

      <div class="section">
        <h2>${L.description}</h2>
        <p>${esc(kcase.description).replace(/\n/g, '<br>')}</p>
      </div>

      ${kcase.proposed_solution ? `
      <div class="section">
        <h2>${L.proposedSolution}</h2>
        <p>${esc(kcase.proposed_solution).replace(/\n/g, '<br>')}</p>
      </div>` : ''}

      ${kcase.assigned_departments && kcase.assigned_departments.length > 0 ? `
      <div class="section">
        <h2>${L.assignedDepartments}</h2>
        <p>${esc(kcase.assigned_departments.map((d) => deptLabel(d, lang)).join(', '))}</p>
      </div>` : ''}

      ${problemPhotosList.length > 0 ? `
      <div class="section">
        <h2>${L.problemPhotos}</h2>
        <div class="photos">
          ${problemPhotosList.map((p) => `<img src="${esc(p.photo_url)}" alt="Problem photo" />`).join('')}
        </div>
      </div>` : ''}

      ${resolutionPhotosList.length > 0 ? `
      <div class="section">
        <h2>${L.resolutionPhotos}</h2>
        <div class="photos">
          ${resolutionPhotosList.map((p) => `<img src="${esc(p.photo_url)}" alt="Resolution photo" />`).join('')}
        </div>
      </div>` : ''}

      ${timeline.length > 0 ? `
      <div class="section">
        <h2>${L.timeline}</h2>
        ${timeline.map((e) => `
          <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <p class="action">${esc(timelineActionLabel(e.action, lang))}</p>
              ${e.description ? `<p>${esc(e.description)}</p>` : ''}
              <p class="time">${new Date(e.created_at).toLocaleString(loc)}</p>
            </div>
          </div>
        `).join('')}
      </div>` : ''}

      <div class="footer">
        <span>${th ? 'เคส' : 'Case'} ${esc(kcase.case_number)} — ${L.brand}</span>
        <span>${L.printed}: ${new Date().toLocaleString(loc)}</span>
      </div>
    </body>
    </html>
  `
}
