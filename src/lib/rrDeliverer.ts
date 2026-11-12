/**
 * Sentinel deliverer: "whoever orders it". A cookie box ordered by HR goes back to HR,
 * the same box ordered by Sales goes to Sales — one company-wide setting, resolved
 * against the ordering user's department at the moment the line is filed.
 */
export const DELIVER_TO_ORDERER = '__orderer__'

/**
 * The department that delivers `item` when `ordererDept` files it; null = the maker
 * delivers it itself. Generic over the department type so it works whether a catalog
 * item's departments are typed as the fixed `Department` union or as free text.
 */
export function resolveDeliverer<D extends string>(
  item: { department: D; deliver_department?: D | null } | undefined,
  ordererDept: D | null | undefined,
): D | null {
  const d = item?.deliver_department as string | null | undefined
  if (!d) return null
  const dept = (d === DELIVER_TO_ORDERER ? (ordererDept || null) : d) as D | null
  return dept && dept !== item!.department ? dept : null
}
