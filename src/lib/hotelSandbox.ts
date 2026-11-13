// Device-local store for the hotel board, so the whole flow — parse, store,
// render — can be tried before the kaizen_hotel_daily migration is applied to
// a live project.
//
// It holds exactly the payload that WOULD be written to Postgres, so what the
// board draws here is what it will draw from the database. What it does NOT
// exercise: the migration SQL, the RLS policies, the upsert round-trip, and
// sharing between devices. A sandbox row lives in one browser and nowhere else.
import type { HotelRowPayload } from '@/lib/hotelReports'

const KEY = 'kaizen-hotel-sandbox'

export function loadSandboxRow(): HotelRowPayload | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as HotelRowPayload) : null
  } catch {
    return null
  }
}

export function saveSandboxRow(row: HotelRowPayload) {
  try { localStorage.setItem(KEY, JSON.stringify(row)) } catch { /* private mode */ }
}

export function clearSandboxRow() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
