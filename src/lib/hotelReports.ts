// Parsers for the two PDFs in the daily "Daily Manager Reports" email.
//
// Deliberately pure: these take already-extracted text items and return plain
// objects, with no pdfjs import at module scope. That keeps them runnable in
// the browser (the upload page), in Deno (a future edge function doing the
// same job from a Gmail trigger) and in a plain node script for testing
// against real report files.
//
// WHY LINES ARE REBUILT FROM COORDINATES
// --------------------------------------
// The Manager Report's text layer does NOT come out in reading order — the PDF
// emits all the figures in one run and all the row labels in another. Parsing
// it in emission order pairs the wrong label with the wrong number, and the
// first value you reach for "% Rms Occupied today" is in fact LAST YEAR's. The
// numbers still look plausible, which is what makes it dangerous. Grouping text
// items by their y coordinate and sorting by x reconstructs the real table, the
// same thing `pdftotext -layout` does.

export interface PdfTextItem {
  str: string
  /** pdfjs transform matrix; [4] is x, [5] is y (origin bottom-left). */
  transform: number[]
}

export interface Triple { today: number; mtd: number; ytd: number }

export interface ManagerReport {
  /** The day the figures describe ("Statistic on"), NOT the day it was printed. */
  statDate: string
  /** The day the report was generated ("Date :"), normally statDate + 1. */
  reportDate: string
  occPct: Triple
  occExclCompHuPct: Triple
  roomsOccupied: Triple
  roomsAvailForSale: Triple
  hotelRevenue: Triple
  roomRevenue: Triple
  fbRevenue: Triple
  miscRevenue: Triple
  avgRatePerRoom: Triple
  lastYear: {
    occPct: Triple
    occExclCompHuPct: Triple
    hotelRevenue: Triple
  }
}

export interface ForecastDay {
  date: string
  dow: string
  arrivals: number
  departures: number
  /** Occupied rooms including allotment (the "Occ. Allt" column). */
  occupied: number
  occPct: number
  /** "TL Rm" — rooms in the hotel that day. */
  totalRooms: number
}

export interface ForecastMonth {
  month: string
  occupiedRoomNights: number
  totalRoomNights: number
  occPct: number
  /** False for the current month, whose subtotal covers only the days left. */
  wholeMonth: boolean
}

export interface ForecastReport {
  asAtDate: string
  days: ForecastDay[]
  months: ForecastMonth[]
}

export class ReportParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportParseError'
  }
}

// ── text reconstruction ─────────────────────────────────────────────────────

/**
 * Rebuild visual lines from positioned text items: group by y, order by x.
 * `tolerance` is in PDF units — items within it of each other are one line.
 */
export function linesFromItems(items: PdfTextItem[], tolerance = 2): string[] {
  const rows: { y: number; parts: { x: number; str: string }[] }[] = []
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue
    const x = it.transform[4]
    const y = it.transform[5]
    const row = rows.find(r => Math.abs(r.y - y) <= tolerance)
    if (row) row.parts.push({ x, str: it.str })
    else rows.push({ y, parts: [{ x, str: it.str }] })
  }
  // PDF y grows upwards, so descending y is top-to-bottom on the page.
  rows.sort((a, b) => b.y - a.y)
  return rows.map(r =>
    r.parts.sort((a, b) => a.x - b.x).map(p => p.str).join(' ').replace(/\s+/g, ' ').trim(),
  )
}

// ── shared helpers ──────────────────────────────────────────────────────────

const NUM = /-?[\d,]+(?:\.\d+)?%?/g

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, '').replace(/%$/, ''))
}

/** Every numeric token on a line, commas and % stripped. */
function numbersOn(line: string): number[] {
  return (line.match(NUM) ?? []).map(toNumber).filter(n => Number.isFinite(n))
}

function parseDMY(raw: string): string {
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!m) throw new ReportParseError(`expected a dd/mm/yyyy date in "${raw}"`)
  return `${m[3]}-${m[2]}-${m[1]}`
}

/**
 * Find a table row by its exact leading label and return its figures.
 *
 * Anchored at the start of the line so "Room Revenue" cannot match
 * "Total Room Revenue", and "% Rms Occupied" cannot match
 * "% Rms OccTl.Rm Avail". The label must be followed by a space or end of
 * label text, never by more label characters.
 */
function rowFigures(lines: string[], label: string): number[] {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc}(?=\\s|$)`)
  const line = lines.find(l => re.test(l.trim()))
  if (!line) throw new ReportParseError(`row "${label}" not found`)
  const nums = numbersOn(line.trim().slice(label.length))
  if (nums.length < 3) {
    throw new ReportParseError(`row "${label}" has ${nums.length} figures, expected at least 3`)
  }
  return nums
}

function triple(nums: number[], offset = 0): Triple {
  return { today: nums[offset], mtd: nums[offset + 1], ytd: nums[offset + 2] }
}

// ── Manager Report with Revenue (S070) ──────────────────────────────────────

export function parseManagerReport(lines: string[]): ManagerReport {
  const statLine = lines.find(l => /Statistic on\s*:/.test(l))
  if (!statLine) throw new ReportParseError('"Statistic on :" not found — is this the Manager Report?')
  // The title and the date can land on separate reconstructed lines, so match
  // the date on its own. "As at date :" belongs to the forecast report, and
  // "Statistic on :" is the business date — neither is the print date.
  const dateLine = lines.find(l =>
    /(^|\s)Date\s*:\s*\d{2}\/\d{2}\/\d{4}/.test(l) && !/As at date/.test(l))

  // Room-count rows carry no account code, so This Year is figures 0–2 and
  // Last Year 3–5. Revenue rows DO carry a code (e.g. "Room Charge 1000"),
  // but the summary rows we read here (Hotel Revenue, Room Revenue, …) do not.
  const occ = rowFigures(lines, '% Rms Occupied')
  const occExcl = rowFigures(lines, '% Rms without Comp & HU')
  const hotelRev = rowFigures(lines, 'Hotel Revenue')

  const report: ManagerReport = {
    statDate: parseDMY(statLine),
    reportDate: dateLine ? parseDMY(dateLine.split(/Date\s*:/)[1]) : parseDMY(statLine),
    occPct: triple(occ),
    occExclCompHuPct: triple(occExcl),
    roomsOccupied: triple(rowFigures(lines, 'Rooms Occupied')),
    roomsAvailForSale: triple(rowFigures(lines, 'Total Rooms Avail for Sale')),
    hotelRevenue: triple(hotelRev),
    roomRevenue: triple(rowFigures(lines, 'Room Revenue')),
    fbRevenue: triple(rowFigures(lines, 'F&B Revenue')),
    miscRevenue: triple(rowFigures(lines, 'Miscellaneous')),
    avgRatePerRoom: triple(rowFigures(lines, 'Avg.Rate/Room')),
    lastYear: {
      occPct: triple(occ, 3),
      occExclCompHuPct: triple(occExcl, 3),
      hotelRevenue: triple(hotelRev, 3),
    },
  }

  // A percentage outside 0–100 means the columns were misread. Fail loudly:
  // a wrong number on a revenue board is worse than no board.
  for (const [name, t] of [['% Rms Occupied', report.occPct], ['% Rms without Comp & HU', report.occExclCompHuPct]] as const) {
    for (const [period, v] of Object.entries(t)) {
      if (!(v >= 0 && v <= 100)) {
        throw new ReportParseError(`${name} ${period} = ${v}, which is not a percentage — column mapping is wrong`)
      }
    }
  }
  if (report.hotelRevenue.today < 0 || report.hotelRevenue.mtd < report.hotelRevenue.today) {
    throw new ReportParseError(
      `Hotel Revenue today ${report.hotelRevenue.today} / M-T-D ${report.hotelRevenue.mtd} is inconsistent`,
    )
  }
  return report
}

// ── Forecast and Availability Report (R010) ─────────────────────────────────

// Columns after the date and weekday:
// Arr, Dep, Net Occ, Net Occ%, Allt, Occ.Allt, Occ%Allt, TL Rm, VC, OOO, Wait, Min, Max
const F_OCC = 5
const F_OCC_PCT = 6
const F_TL_RM = 7

const DAY_ROW = /^(\d{2}\/\d{2}\/\d{4})\s+(\S{3})\s+(.+)$/

export function parseForecastReport(lines: string[]): ForecastReport {
  const asAt = lines.find(l => /As at date\s*:/.test(l))
  if (!asAt) throw new ReportParseError('"As at date :" not found — is this the Forecast report?')
  const asAtDate = parseDMY(asAt.split(/As at date\s*:/)[1])

  const days: ForecastDay[] = []
  const months: ForecastMonth[] = []
  let currentMonth = ''
  let daysInCurrentMonth = 0

  for (const raw of lines) {
    const line = raw.trim()

    const monthHeader = line.match(/^Month\s*:\s*(\S+)/)
    if (monthHeader) {
      currentMonth = monthHeader[1]
      daysInCurrentMonth = 0
      continue
    }

    const sub = line.match(/^Sub Total\s+(.+)$/)
    if (sub) {
      const n = numbersOn(sub[1])
      if (n.length > F_TL_RM && currentMonth) {
        // A subtotal is only a whole month if the report covered every one of
        // its days. The first month starts at "as at", so it never is.
        const monthIndex = months.length
        months.push({
          month: currentMonth,
          occupiedRoomNights: n[F_OCC],
          totalRoomNights: n[F_TL_RM],
          occPct: n[F_OCC_PCT],
          wholeMonth: monthIndex > 0 && daysInCurrentMonth >= 28,
        })
      }
      continue
    }

    const day = line.match(DAY_ROW)
    if (!day) continue
    const n = numbersOn(day[3])
    if (n.length <= F_TL_RM) continue
    days.push({
      date: parseDMY(day[1]),
      dow: day[2],
      arrivals: n[0],
      departures: n[1],
      occupied: n[F_OCC],
      occPct: n[F_OCC_PCT],
      totalRooms: n[F_TL_RM],
    })
    daysInCurrentMonth++
  }

  if (!days.length) throw new ReportParseError('no daily rows found in the forecast report')
  if (!months.length) throw new ReportParseError('no monthly subtotals found in the forecast report')
  return { asAtDate, days, months }
}

// ── derived figures for the dashboard ───────────────────────────────────────

export interface Window { label: string; occupied: number; available: number; pct: number }

function windowOf(days: ForecastDay[], label: string): Window {
  const occupied = days.reduce((s, d) => s + d.occupied, 0)
  const available = days.reduce((s, d) => s + d.totalRooms, 0)
  return { label, occupied, available, pct: available ? (occupied / available) * 100 : 0 }
}

/** The next `count` days starting at the report's as-at date. */
export function weekWindow(f: ForecastReport, label = 'This week', count = 7): Window {
  return windowOf(f.days.slice(0, count), label)
}

/**
 * Month windows. The first entry is the CURRENT month and is forecast-only —
 * it covers the days from "as at" to month end, not the whole month. Combine
 * it with the Manager Report's M-T-D actuals for a true full-month figure.
 */
export function monthWindows(f: ForecastReport, count = 3): Window[] {
  return f.months.slice(0, count).map(m => ({
    label: m.month,
    occupied: m.occupiedRoomNights,
    available: m.totalRoomNights,
    pct: m.occPct,
  }))
}

/**
 * Full current month = month-to-date actuals + the rest of the month forecast.
 * Neither report gives this on its own: the Manager Report stops at yesterday,
 * the forecast starts today.
 */
export function currentMonthCombined(m: ManagerReport, f: ForecastReport): Window {
  const rest = f.months[0]
  return windowOfParts(
    m.roomsOccupied.mtd + (rest?.occupiedRoomNights ?? 0),
    m.roomsAvailForSale.mtd + (rest?.totalRoomNights ?? 0),
  )
}

function windowOfParts(occupied: number, available: number): Window {
  return { label: 'This month', occupied, available, pct: available ? (occupied / available) * 100 : 0 }
}

// ── storage shape ───────────────────────────────────────────────────────────

/**
 * The parsed reports as one `kaizen_hotel_daily` row (minus the columns the
 * caller owns: company_id, uploaded_by, updated_at).
 *
 * Shared by the real upsert and the sandbox store on purpose — the sandbox is
 * only worth anything if it exercises the exact payload that would be written
 * to Postgres, not a convenient approximation of it.
 */
export function toHotelRow(m: ManagerReport, f: ForecastReport) {
  return {
    stat_date: m.statDate,
    report_date: m.reportDate,
    occ_pct_today: m.occPct.today, occ_pct_mtd: m.occPct.mtd, occ_pct_ytd: m.occPct.ytd,
    occ_excl_pct_today: m.occExclCompHuPct.today,
    occ_excl_pct_mtd: m.occExclCompHuPct.mtd,
    occ_excl_pct_ytd: m.occExclCompHuPct.ytd,
    rooms_occupied_today: m.roomsOccupied.today,
    rooms_occupied_mtd: m.roomsOccupied.mtd,
    rooms_occupied_ytd: m.roomsOccupied.ytd,
    rooms_avail_today: m.roomsAvailForSale.today,
    rooms_avail_mtd: m.roomsAvailForSale.mtd,
    rooms_avail_ytd: m.roomsAvailForSale.ytd,
    hotel_revenue_today: m.hotelRevenue.today,
    hotel_revenue_mtd: m.hotelRevenue.mtd,
    hotel_revenue_ytd: m.hotelRevenue.ytd,
    room_revenue_today: m.roomRevenue.today, room_revenue_mtd: m.roomRevenue.mtd, room_revenue_ytd: m.roomRevenue.ytd,
    fb_revenue_today: m.fbRevenue.today, fb_revenue_mtd: m.fbRevenue.mtd, fb_revenue_ytd: m.fbRevenue.ytd,
    misc_revenue_today: m.miscRevenue.today, misc_revenue_mtd: m.miscRevenue.mtd, misc_revenue_ytd: m.miscRevenue.ytd,
    adr_today: m.avgRatePerRoom.today, adr_mtd: m.avgRatePerRoom.mtd, adr_ytd: m.avgRatePerRoom.ytd,
    ly_occ_pct_today: m.lastYear.occPct.today,
    ly_occ_pct_mtd: m.lastYear.occPct.mtd,
    ly_occ_pct_ytd: m.lastYear.occPct.ytd,
    ly_hotel_rev_today: m.lastYear.hotelRevenue.today,
    ly_hotel_rev_mtd: m.lastYear.hotelRevenue.mtd,
    ly_hotel_rev_ytd: m.lastYear.hotelRevenue.ytd,
    forecast: { asAtDate: f.asAtDate, days: f.days, months: f.months },
  }
}

export type HotelRowPayload = ReturnType<typeof toHotelRow>
