/**
 * Whether a recipe line is seeded OFF (unticked) on a new order, so the requester opts in.
 * Driven by the per-line `default_off` preference; when unset, receipts/tax invoices default
 * off (issued on demand) and everything else defaults on.
 */
export function recipeSeedOff(l: { slot: string; default_off?: boolean | null }): boolean {
  return l.default_off ?? /receipt|tax invoice|ใบเสร็จ|ใบกำกับภาษี/i.test(l.slot)
}
