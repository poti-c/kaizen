// The configurable noun for a bookable unit (Room / Hut / Resort / Villa …).
// Kept in its own module so the Room Setup, recipes, room-order, and page all
// share it without tripping react-refresh's component-only-export rule.

export interface UnitNoun {
  one: string
  many: string
  one_th: string
  many_th: string
}

export const DEFAULT_UNIT: UnitNoun = { one: 'Room', many: 'Rooms', one_th: 'ห้อง', many_th: 'ห้อง' }

/** Capitalise the first character (no-op for Thai, which has no case). */
export function capFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

export function unitOne(u: UnitNoun | undefined, lang: string): string {
  const n = u ?? DEFAULT_UNIT
  return capFirst((lang === 'th' ? (n.one_th || n.one) : n.one) || DEFAULT_UNIT.one)
}

export function unitMany(u: UnitNoun | undefined, lang: string): string {
  const n = u ?? DEFAULT_UNIT
  return capFirst((lang === 'th' ? (n.many_th || n.many) : n.many) || DEFAULT_UNIT.many)
}
