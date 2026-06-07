import { DEPARTMENT_LABELS } from '@/types'
import type { KaizenCase, KaizenProfile, KaizenCaseTimeline, KaizenCasePhoto } from '@/types'

export const CATEGORY_LABELS_EN: Record<string, string> = {
  maintenance: 'Maintenance', cleanliness: 'Cleanliness', safety: 'Safety',
  guest_complaint: 'Guest Complaint', equipment: 'Equipment', other: 'Other',
  preventive_maintenance: 'Preventive Maintenance',
}

/**
 * Build a standalone printable HTML document for a case.
 * Pure function — no DOM side effects; the caller handles window.open/print.
 */
export function buildCasePrintHtml(
  kcase: KaizenCase,
  photos: KaizenCasePhoto[],
  timeline: KaizenCaseTimeline[],
): string {
  const problemPhotosList = photos.filter((p) => p.photo_type === 'problem')
  const resolutionPhotosList = photos.filter((p) => p.photo_type === 'resolution')

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Case ${kcase.case_number} — Na Nirand Kaizen</title>
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
        <div class="brand">Na Nirand Kaizen System</div>
        <h1>${kcase.title}</h1>
        <div>
          <span class="badge">${kcase.case_number}</span>
          <span class="badge">${kcase.priority.toUpperCase()}</span>
          <span class="badge">${kcase.status.replace(/_/g, ' ').toUpperCase()}</span>
          ${kcase.category ? `<span class="badge">${CATEGORY_LABELS_EN[kcase.category] || kcase.category}</span>` : ''}
          ${kcase.is_recurring ? `<span class="badge">Recurring</span>` : ''}
        </div>
        <div class="meta">
          <div class="meta-item"><span class="meta-label">Department</span><span class="meta-value">${DEPARTMENT_LABELS[kcase.department]}</span></div>
          <div class="meta-item"><span class="meta-label">Created</span><span class="meta-value">${new Date(kcase.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
          ${kcase.due_date ? `<div class="meta-item"><span class="meta-label">Due Date</span><span class="meta-value">${new Date(kcase.due_date).toLocaleDateString('en-GB')}</span></div>` : ''}
          <div class="meta-item"><span class="meta-label">Reporter</span><span class="meta-value">${(kcase.creator as KaizenProfile)?.full_name || 'Unknown'}</span></div>
        </div>
      </div>

      <div class="section">
        <h2>Description</h2>
        <p>${kcase.description.replace(/\n/g, '<br>')}</p>
      </div>

      ${kcase.proposed_solution ? `
      <div class="section">
        <h2>Proposed Solution</h2>
        <p>${kcase.proposed_solution.replace(/\n/g, '<br>')}</p>
      </div>` : ''}

      ${kcase.assigned_departments && kcase.assigned_departments.length > 0 ? `
      <div class="section">
        <h2>Assigned Departments</h2>
        <p>${kcase.assigned_departments.map((d) => DEPARTMENT_LABELS[d]).join(', ')}</p>
      </div>` : ''}

      ${problemPhotosList.length > 0 ? `
      <div class="section">
        <h2>Problem Photos</h2>
        <div class="photos">
          ${problemPhotosList.map((p) => `<img src="${p.photo_url}" alt="Problem photo" />`).join('')}
        </div>
      </div>` : ''}

      ${resolutionPhotosList.length > 0 ? `
      <div class="section">
        <h2>Resolution Photos</h2>
        <div class="photos">
          ${resolutionPhotosList.map((p) => `<img src="${p.photo_url}" alt="Resolution photo" />`).join('')}
        </div>
      </div>` : ''}

      ${timeline.length > 0 ? `
      <div class="section">
        <h2>Timeline</h2>
        ${timeline.map((e) => `
          <div class="timeline-item">
            <div class="timeline-dot"></div>
            <div class="timeline-content">
              <p class="action">${e.action.replace(/_/g, ' ')}</p>
              ${e.description ? `<p>${e.description}</p>` : ''}
              <p class="time">${new Date(e.created_at).toLocaleString('en-GB')}</p>
            </div>
          </div>
        `).join('')}
      </div>` : ''}

      <div class="footer">
        <span>Case ${kcase.case_number} — Na Nirand Kaizen System</span>
        <span>Printed: ${new Date().toLocaleString('en-GB')}</span>
      </div>
    </body>
    </html>
  `
}
