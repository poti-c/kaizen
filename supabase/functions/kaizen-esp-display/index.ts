// kaizen-esp-display — read-only aggregate feed for the ESP32 wall panel.
//
// The panel (esp-display firmware, GUITION JC8048W550) has no browser and no
// Supabase session, so it cannot run /display. This function computes the same
// numbers DisplayPage.tsx draws for the Kaizen board and returns them as a small
// JSON document. Every rule below mirrors DisplayPage / src/lib/utils.ts; if you
// change one there, change it here (search for "mirrors").
//
// Auth: deployed with verify_jwt=false (supabase/config.toml) because the device
// holds no JWT. Instead it sends `Authorization: Bearer <device token>`. Only the
// SHA-256 of each token is stored, in the KAIZEN_ESP_DISPLAY_TOKEN_SHA256 secret
// (comma-separated, one per panel). The company is fixed server-side by
// KAIZEN_ESP_DISPLAY_COMPANY_ID — the device cannot choose it.
//   Revoke one panel: remove its hash from the secret.
//   Revoke all:       supabase secrets unset KAIZEN_ESP_DISPLAY_TOKEN_SHA256
// The service-role key never leaves Supabase.
//
// Output is aggregates plus, for Needs Attention, case number / department /
// age only — no titles, descriptions or names.

import { timingSafeEqual } from "node:crypto"
import { createClient } from "npm:@supabase/supabase-js@2"

const companyId = Deno.env.get("KAIZEN_ESP_DISPLAY_COMPANY_ID") ?? ""
const tokenHashes = (Deno.env.get("KAIZEN_ESP_DISPLAY_TOKEN_SHA256") ?? "")
  .split(",").map(s => s.trim().toLowerCase()).filter(s => /^[0-9a-f]{64}$/.test(s))
  .map(hex => Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16)))

const BKK = 7 * 3600 * 1000 // Asia/Bangkok has no DST
const HOUR = 3600 * 1000
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

// mirrors getSLAHours (utils.ts)
const SLA_HOURS: Record<string, number> = { critical: 4, high: 24, medium: 72, low: 168 }
// mirrors CATEGORIES + CATEGORY_LABELS_EN (utils.ts, types/index.ts)
const BUILTIN_CATEGORIES: [string, string][] = [
  ["cleanliness", "Cleanliness"], ["safety", "Safety"], ["guest_complaint", "Guest Complaint"],
  ["equipment", "Equipment"], ["other", "Other"],
]
// mirrors CAT_COLORS / CAT_FALLBACK (DisplayPage.tsx)
const CAT_COLORS: Record<string, string> = {
  maintenance: "#3b82f6", cleanliness: "#14b8a6", safety: "#ef4444",
  guest_complaint: "#a855f7", equipment: "#f97316", other: "#6b7280",
  preventive_maintenance: "#0ea5e9",
}
const CAT_FALLBACK = ["#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899", "#6366f1"]
// mirrors DEPARTMENT_LABELS (types/index.ts)
const DEPARTMENT_LABELS: Record<string, string> = {
  top_management: "Top Management", front_office: "Front Office", sales_team: "Sales Team",
  house_keeping: "House Keeping", human_resource: "Human Resource",
  engineering_team: "Engineering Team", restaurant: "Restaurant", kitchen: "Kitchen",
  accounting: "Accounting",
}

type Row = {
  id: string; case_number: string | null; status: string; priority: string
  category: string | null; department: string | null
  created_at: string; closed_at: string | null; due_date: string | null
}

function reply(status: number, body: unknown) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

async function authorized(request: Request): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? ""
  if (!header.startsWith("Bearer ")) return false
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(header.slice(7))))
  let ok = false
  for (const h of tokenHashes) ok = timingSafeEqual(digest, h) || ok
  return ok
}

// Bangkok calendar month index (year*12 + month0) of an instant.
const bkkMonthIndex = (ms: number) => {
  const d = new Date(ms + BKK)
  return d.getUTCFullYear() * 12 + d.getUTCMonth()
}
// date-fns differenceInHours: truncated toward zero.
const hoursBetween = (later: number, earlier: number) => Math.trunc((later - earlier) / HOUR)
const slug = (s: string | null) => (s || "").toLowerCase().replace(/ /g, "_")

// mirrors isSLABreached (utils.ts)
function isSLABreached(c: Row, now: number): boolean {
  if (c.status === "closed") return false
  if (c.status === "pending_manager_approval" || c.status === "pending_admin_approval") return false
  if (c.due_date) {
    const raw = String(c.due_date)
    const due = Date.parse(raw.length <= 10 ? `${raw}T23:59:59+07:00` : raw)
    if (!isNaN(due)) return now > due
  }
  return (SLA_HOURS[c.priority] ?? 72) - hoursBetween(now, Date.parse(c.created_at)) < 0
}

Deno.serve(async (request) => {
  if (request.method !== "GET") return reply(405, { error: "Method not allowed" })
  if (!companyId || tokenHashes.length === 0) return reply(503, { error: "Display is unavailable" })
  if (!(await authorized(request))) return reply(401, { error: "Unauthorized" })

  const now = Date.now()
  const current = bkkMonthIndex(now)
  const firstMonth = current - 8 // trailing nine months, current last
  const monthStart = (idx: number) =>
    new Date(Date.UTC(Math.floor(idx / 12), idx % 12, 1) - BKK).toISOString()

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const [{ data: company }, { data: catRow }] = await Promise.all([
    db.from("kaizen_companies").select("name, org_title").eq("id", companyId).maybeSingle(),
    db.from("kaizen_settings").select("value")
      .eq("company_id", companyId).eq("key", "custom_categories").maybeSingle(),
  ])
  if (!company) return reply(503, { error: "Display is unavailable" })

  // Only the nine-month window is needed: the KPIs use the current month, the
  // trend uses all nine. Keyset pagination keeps us under PostgREST's max-rows.
  const rows: Row[] = []
  for (let cursor = ""; ;) {
    let q = db.from("kaizen_cases")
      .select("id,case_number,status,priority,category,department,created_at,closed_at,due_date")
      .eq("company_id", companyId)
      .gte("created_at", monthStart(firstMonth))
      .lt("created_at", monthStart(current + 1))
      .order("id").limit(500)
    if (cursor) q = q.gt("id", cursor)
    const { data, error } = await q
    if (error) return reply(502, { error: "Case metrics unavailable" })
    rows.push(...(data as Row[]))
    if (data.length < 500) break
    cursor = data[data.length - 1].id
  }

  // mirrors monthlyData
  const monthly = Array.from({ length: 9 }, (_, i) => ({
    month: MONTH_SHORT[(firstMonth + i) % 12], count: 0,
  }))
  const monthCases: Row[] = []
  for (const c of rows) {
    const i = bkkMonthIndex(Date.parse(c.created_at)) - firstMonth
    if (i < 0 || i > 8) continue
    monthly[i].count++
    if (i === 8) monthCases.push(c)
  }

  // mirrors stats
  const count = (pred: (c: Row) => boolean) => monthCases.filter(pred).length
  const stats = {
    total: monthCases.length,
    open: count(c => c.status === "open"),
    reopened: count(c => c.status === "reopened"),
    inProgress: count(c => c.status === "assigned" || c.status === "in_progress"),
    pending: count(c => c.status === "pending_manager_approval" || c.status === "pending_admin_approval"),
    closed: count(c => c.status === "closed"),
    overdue: count(c => isSLABreached(c, now)),
  }
  const resolutionRate = stats.total > 0 ? Math.round((stats.closed / stats.total) * 100) : 0

  // mirrors avgResolution
  let avgResolution: string | null = null
  const closed = monthCases.filter(c => c.status === "closed" && c.closed_at)
  if (closed.length) {
    const h = Math.round(closed.reduce((s, c) =>
      s + hoursBetween(Date.parse(c.closed_at!), Date.parse(c.created_at)), 0) / closed.length)
    avgResolution = h < 24 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`
  }

  // mirrors allCats + categoryRows: the company's own list, else the built-ins;
  // preventive_maintenance appended when cases use it; unknown slugs → "Other".
  const labels = Array.isArray(catRow?.value) ? (catRow!.value as string[]) : []
  const cats: [string, string][] = labels.length
    ? labels.map(l => [l.toLowerCase().replace(/ /g, "_"), l])
    : [...BUILTIN_CATEGORIES]
  if (rows.some(c => c.category === "preventive_maintenance")
      && !cats.some(([s]) => s === "preventive_maintenance")) {
    cats.push(["preventive_maintenance", "Preventive Maintenance"])
  }
  const catCounts = new Map(cats.map(([s]) => [s, 0]))
  let other = 0
  for (const c of monthCases) {
    const s = slug(c.category)
    if (catCounts.has(s)) catCounts.set(s, catCounts.get(s)! + 1)
    else other++
  }
  const catRows = cats.map(([s, label], i) => ({
    label, count: catCounts.get(s)!, color: CAT_COLORS[s] || CAT_FALLBACK[i % CAT_FALLBACK.length],
  }))
  if (other > 0) {
    catRows.push({ label: "Other", count: other, color: CAT_FALLBACK[cats.length % CAT_FALLBACK.length] })
  }
  const categories = catRows.filter(r => r.count > 0).sort((a, b) => b.count - a.count).slice(0, 4)

  // mirrors attention: open cases that are overdue or critical; overdue first,
  // then critical, then oldest. The board lists three.
  const flagged = monthCases
    .filter(c => c.status !== "closed")
    .map(c => ({ c, overdue: isSLABreached(c, now), critical: c.priority === "critical" }))
    .filter(x => x.overdue || x.critical)
    .sort((a, b) => (Number(b.overdue) - Number(a.overdue))
      || (Number(b.critical) - Number(a.critical))
      || (Date.parse(a.c.created_at) - Date.parse(b.c.created_at)))
  const attentionItems = flagged.slice(0, 3).map(({ c, overdue }) => ({
    caseNumber: c.case_number ?? "",
    department: DEPARTMENT_LABELS[c.department ?? ""] ?? c.department ?? "",
    hours: hoursBetween(now, Date.parse(c.created_at)),
    overdue,
  }))

  return reply(200, {
    title: company.org_title || company.name || "Kaizen",
    month: `${MONTH_SHORT[current % 12]} ${Math.floor(current / 12)}`,
    ...stats,
    resolutionRate,
    avgResolution,
    monthly,
    categories,
    attention: flagged.length,
    attentionItems,
    updatedAt: new Date(now).toISOString(),
  })
})
