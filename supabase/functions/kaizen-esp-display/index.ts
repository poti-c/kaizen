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
// The default response is aggregates plus the three Needs Attention rows
// (number, title, department, age). `?view=cases` returns this month's cases
// with the fields the web drill-down shows (title, description, proposed
// solution, location, PIC and reporter names), for the panel's case lists. Both
// need the device token; the panel shows what /display shows a signed-in user.

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
// mirrors DEPARTMENT_LABELS_TH (types/index.ts)
const DEPARTMENT_LABELS_TH: Record<string, string> = {
  top_management: "ผู้บริหารระดับสูง", front_office: "แผนกต้อนรับ", sales_team: "ฝ่ายขาย",
  house_keeping: "แผนกแม่บ้าน", human_resource: "ฝ่ายบุคคล", engineering_team: "ฝ่ายช่าง",
  restaurant: "ห้องอาหาร", kitchen: "ครัว", accounting: "ฝ่ายบัญชี",
}
const clip = (s: string | null | undefined, n: number) => {
  const chars = Array.from((s ?? "").trim())
  return chars.length > n ? chars.slice(0, n).join("") + "…" : chars.join("")
}
const DEPARTMENT_LABELS: Record<string, string> = {
  top_management: "Top Management", front_office: "Front Office", sales_team: "Sales Team",
  house_keeping: "House Keeping", human_resource: "Human Resource",
  engineering_team: "Engineering Team", restaurant: "Restaurant", kitchen: "Kitchen",
  accounting: "Accounting",
}

type Row = {
  id: string; case_number: string | null; title?: string | null; status: string; priority: string
  category: string | null; department: string | null
  created_at: string; closed_at: string | null; due_date: string | null
}

// ── Hotel board: mirrors src/components/HotelBoard.tsx ─────────────────────
// Values are formatted here, exactly as the web board formats them, so the
// panel only prints strings. "-" stands in for the web's em dash (the panel
// font is ASCII); "฿" is kept and the firmware draws it as a glyph.
const HOTEL_COLS = "stat_date, updated_at, occ_pct_today, occ_pct_mtd, occ_pct_ytd, occ_excl_pct_today, occ_excl_pct_mtd, "
  + "rooms_occupied_today, rooms_occupied_mtd, rooms_avail_today, rooms_avail_mtd, "
  + "hotel_revenue_today, hotel_revenue_mtd, hotel_revenue_ytd, "
  + "room_revenue_today, fb_revenue_today, misc_revenue_today, adr_today, "
  + "ly_occ_pct_today, ly_hotel_rev_today, ly_hotel_rev_ytd, forecast"
const PANEL_TEXT = "#e8edf3", PANEL_IN_PROGRESS = "#3b82f6", PANEL_RESOLVED = "#22c55e"
const PANEL_PENDING = "#f59e0b", PANEL_CRITICAL = "#ef4444"

type ForecastDay = { date: string; occPct: number; occupied: number; totalRooms: number }
type ForecastMonth = { month: string; occupiedRoomNights: number; totalRoomNights: number }
type HotelRow = Record<string, unknown> & {
  stat_date: string
  updated_at: string
  forecast: { days: ForecastDay[]; months: ForecastMonth[] } | null
}

const num = (v: unknown) => (v == null ? null : Number(v))
const pct = (v: number | null) => (v == null ? "-" : `${v.toFixed(2)}%`)
function money(v: number | null): string {
  if (v == null) return "-"
  const abs = Math.abs(v)
  if (abs >= 10_000_000) return `฿${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000_000) return `฿${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `฿${(v / 1_000).toFixed(1)}K`
  return `฿${v.toFixed(0)}`
}
const exact = (v: number | null) =>
  v == null ? "-" : v.toLocaleString("en-US", { maximumFractionDigits: 0 })
const orDash = (v: unknown) => (v == null ? "-" : String(v))

function hotelBoard(row: HotelRow, now: number) {
  const occToday = num(row.occ_pct_today)
  const lyOcc = num(row.ly_occ_pct_today)
  const revToday = num(row.hotel_revenue_today)
  const tiles = [
    { label: "Occupancy today", labelTh: "เข้าพักวันนี้", value: pct(occToday), color: PANEL_IN_PROGRESS,
      sub: `${orDash(row.rooms_occupied_today)} / ${orDash(row.rooms_avail_today)} rooms`,
      subTh: `${orDash(row.rooms_occupied_today)} / ${orDash(row.rooms_avail_today)} ห้อง` },
    { label: "Occupancy M-T-D", labelTh: "เข้าพัก M-T-D", value: pct(num(row.occ_pct_mtd)), color: PANEL_TEXT,
      sub: `${orDash(row.rooms_occupied_mtd)} / ${orDash(row.rooms_avail_mtd)}` },
    { label: "Excl Comp & HU", labelTh: "ไม่รวม Comp & HU", value: pct(num(row.occ_excl_pct_today)), color: PANEL_TEXT,
      sub: `M-T-D ${pct(num(row.occ_excl_pct_mtd))}` },
    { label: "Revenue today", labelTh: "รายได้วันนี้", value: money(revToday), color: PANEL_RESOLVED,
      sub: `LY ${money(num(row.ly_hotel_rev_today))}`, subTh: `ปีก่อน ${money(num(row.ly_hotel_rev_today))}` },
    { label: "Revenue M-T-D", labelTh: "รายได้ M-T-D", value: money(num(row.hotel_revenue_mtd)), color: PANEL_TEXT,
      sub: exact(num(row.hotel_revenue_mtd)) },
    { label: "Revenue Y-T-D", labelTh: "รายได้ Y-T-D", value: money(num(row.hotel_revenue_ytd)), color: PANEL_TEXT,
      sub: `LY ${money(num(row.ly_hotel_rev_ytd))}`, subTh: `ปีก่อน ${money(num(row.ly_hotel_rev_ytd))}` },
  ]
  const days = row.forecast?.days ?? []
  // Rooms occupied out of rooms in the hotel, as the web chart draws it.
  const forecast = days.slice(0, 14).map(d => ({
    label: d.date.slice(8, 10), pct: d.occPct, rooms: d.occupied, total: d.totalRooms,
  }))
  const today = [
    { label: "Rooms occupied", labelTh: "ห้องที่ขายได้", value: `${orDash(row.rooms_occupied_today)} / ${orDash(row.rooms_avail_today)}`, color: PANEL_TEXT },
    { label: "ADR", labelTh: "ADR", value: exact(num(row.adr_today)), color: PANEL_TEXT },
    { label: "Hotel revenue", labelTh: "รายได้รวม", value: exact(revToday), color: PANEL_TEXT },
    {
      label: "vs last year", labelTh: "เทียบปีก่อน",
      value: lyOcc != null && occToday != null ? `${(occToday - lyOcc).toFixed(2)} pt` : "-",
      color: lyOcc != null && occToday != null ? (occToday >= lyOcc ? PANEL_RESOLVED : PANEL_CRITICAL) : PANEL_TEXT,
    },
  ]
  let outlook: { label: string; labelTh: string; pct: number; pctText: string; occ: number; avail: number }[] = []
  if (row.forecast) {
    const { months } = row.forecast
    const week = days.slice(0, 7)
    const rest = months[0]
    outlook = [
      { label: "This week", labelTh: "สัปดาห์นี้", occ: week.reduce((s, d) => s + d.occupied, 0), avail: week.reduce((s, d) => s + d.totalRooms, 0) },
      {
        label: "This month", labelTh: "เดือนนี้",
        occ: (num(row.rooms_occupied_mtd) ?? 0) + (rest?.occupiedRoomNights ?? 0),
        avail: (num(row.rooms_avail_mtd) ?? 0) + (rest?.totalRoomNights ?? 0),
      },
      ...months.slice(1, 3).map(m => ({ label: m.month, labelTh: m.month, occ: m.occupiedRoomNights, avail: m.totalRoomNights })),
    ].map(w => {
      const p = w.avail ? (w.occ / w.avail) * 100 : 0
      return { ...w, pct: p, pctText: `${p.toFixed(1)}%` }
    })
  }
  const split = [
    { label: "Rooms", labelTh: "ห้องพัก", value: num(row.room_revenue_today) ?? 0, color: PANEL_IN_PROGRESS },
    { label: "F&B", labelTh: "อาหารและเครื่องดื่ม", value: num(row.fb_revenue_today) ?? 0, color: PANEL_RESOLVED },
    { label: "Other", labelTh: "อื่น ๆ", value: num(row.misc_revenue_today) ?? 0, color: PANEL_PENDING },
  ]
  const revMax = Math.max(1, ...split.map(r => r.value))
  return {
    state: "ready",
    statDate: row.stat_date,
    uploadDateLabel: new Date(row.updated_at).toLocaleDateString("en-US", {timeZone:"Asia/Bangkok",month:"short",day:"numeric",year:"numeric"}),
    uploadAgeDays: Math.max(0, Math.round((Date.parse(new Date(now+BKK).toISOString().slice(0,10))-Date.parse(new Date(Date.parse(row.updated_at)+BKK).toISOString().slice(0,10)))/86400000)),
    statDateLabel: new Date(`${row.stat_date}T00:00:00Z`).toLocaleDateString("en-GB",
      { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" }).replace(/,/g, ""),
    ageDays: Math.round((Date.parse(new Date(now + BKK).toISOString().slice(0, 10)) - Date.parse(row.stat_date)) / 86_400_000),
    tiles, forecast, today, outlook,
    revenue: split.map(r => ({ label: r.label, labelTh: r.labelTh, value: exact(r.value), ratio: r.value / revMax, color: r.color })),
  }
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

  const [{ data: company }, { data: catRow }, hotelResult, roomResult] = await Promise.all([
    db.from("kaizen_companies").select("name, org_title").eq("id", companyId).maybeSingle(),
    db.from("kaizen_settings").select("value")
      .eq("company_id", companyId).eq("key", "custom_categories").maybeSingle(),
    db.from("kaizen_hotel_daily").select(HOTEL_COLS)
      .eq("company_id", companyId).order("stat_date", { ascending: false }).limit(1).maybeSingle(),
    db.from("kaizen_room_availability").select("report,updated_at").eq("company_id",companyId).maybeSingle(),
  ])
  // mirrors HotelBoard's load states: error / empty / ready
  const hotel = hotelResult.error ? { state: "error" }
    : !hotelResult.data ? { state: "empty" }
    : hotelBoard(hotelResult.data as unknown as HotelRow, now)
  const rr = roomResult.data?.report as {reportDate:string;types:{id:string;name:string;capacity:number}[];values:{date:string;roomType:string;available:number}[]} | undefined
  const roomAvailability = rr && Array.isArray(rr.types) && Array.isArray(rr.values) ? {
    reportDate: rr.reportDate, updatedAt: roomResult.data?.updated_at, types: rr.types,
    days: [...new Set(rr.values.map(v=>v.date))].sort().map(date=>({date,available:rr.types.map(t=>rr.values.find(v=>v.date===date&&v.roomType===t.id)?.available??null)})),
  } : null
  if (!company) return reply(503, { error: "Display is unavailable" })

  // ── ?view=cases: the drill-down list (mirrors DisplayPage's drill overlay) ──
  // Fetched only when someone opens a list on the panel, so the per-minute
  // poll stays small. Newest first, like the web board.
  if (new URL(request.url).searchParams.get("view") === "cases") {
    const labels = Array.isArray(catRow?.value) ? (catRow!.value as string[]) : []
    const known = new Set([
      ...(labels.length ? labels.map(l => l.toLowerCase().replace(/ /g, "_")) : BUILTIN_CATEGORIES.map(([s]) => s)),
      "preventive_maintenance",
    ])
    const [{ data: caseRows, error }, { data: people }] = await Promise.all([
      db.from("kaizen_cases")
        .select("id,case_number,title,description,proposed_solution,location,status,priority,category,department,created_at,due_date,pic_ids,person_in_charge,created_by,closed_at")
        .eq("company_id", companyId)
        .gte("created_at", monthStart(current))
        .lt("created_at", monthStart(current + 1))
        .order("created_at", { ascending: false })
        .limit(1000),
      db.from("kaizen_profiles").select("id, full_name").eq("company_id", companyId),
    ])
    if (error) return reply(502, { error: "Cases unavailable" })
    const names = new Map((people ?? []).map(p => [p.id as string, p.full_name as string]))
    const cases = (caseRows ?? []).map(c => {
      const ids: string[] = c.pic_ids?.length ? c.pic_ids : (c.person_in_charge ? [c.person_in_charge] : [])
      const s = slug(c.category)
      return {
        id: c.id,
        n: c.case_number ?? "",
        title: clip(c.title, 80),
        status: c.status,
        priority: c.priority,
        cat: known.has(s) ? s : "__other__",
        deptEn: DEPARTMENT_LABELS[c.department ?? ""] ?? c.department ?? "",
        deptTh: DEPARTMENT_LABELS_TH[c.department ?? ""] ?? DEPARTMENT_LABELS[c.department ?? ""] ?? c.department ?? "",
        hours: hoursBetween(now, Date.parse(c.created_at)),
        overdue: isSLABreached(c as Row, now),
        desc: clip(c.description, 280),
        proposed: clip(c.proposed_solution, 160),
        location: clip(c.location, 40),
        pic: ids.map(id => names.get(id)).filter(Boolean).join(", "),
        by: names.get(c.created_by) ?? "",
      }
    })
    return reply(200, { cases })
  }

  // Only the nine-month window is needed: the KPIs use the current month, the
  // trend uses all nine. Keyset pagination keeps us under PostgREST's max-rows.
  const rows: Row[] = []
  for (let cursor = ""; ;) {
    let q = db.from("kaizen_cases")
      .select("id,case_number,title,status,priority,category,department,created_at,closed_at,due_date")
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
    slug: s, label, count: catCounts.get(s)!, color: CAT_COLORS[s] || CAT_FALLBACK[i % CAT_FALLBACK.length],
  }))
  if (other > 0) {
    catRows.push({ slug: "__other__", label: "Other", count: other, color: CAT_FALLBACK[cats.length % CAT_FALLBACK.length] })
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
    id: c.id,
    caseNumber: c.case_number ?? "",
    title: clip(c.title, 60),
    department: DEPARTMENT_LABELS[c.department ?? ""] ?? c.department ?? "",
    departmentTh: DEPARTMENT_LABELS_TH[c.department ?? ""] ?? DEPARTMENT_LABELS[c.department ?? ""] ?? c.department ?? "",
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
    hotel,
    roomAvailability,
    updatedAt: new Date(now).toISOString(),
  })
})
