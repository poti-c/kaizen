import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

// Structured Thai address parts stored in kaizen_companies.billing_address (jsonb).
export interface ThaiAddress {
  house_no?: string; soi?: string; road?: string
  subdistrict?: string; district?: string; province?: string; postcode?: string; country?: string
}

interface Props {
  officeType: string
  branchCode: string
  address: ThaiAddress
  onChange: (next: { officeType: string; branchCode: string; address: ThaiAddress }) => void
}

const inp = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50'
const lbl = 'text-xs font-medium text-slate-400'

// province → district → sub-district → postal code. The full Thai geography
// (~270 KB) is lazy-loaded the first time a billing form mounts, then cached.
type GeoTree = Record<string, Record<string, Record<string, string>>>
let cachedGeo: GeoTree | null = null
let geoPromise: Promise<GeoTree> | null = null
function loadGeo(): Promise<GeoTree> {
  if (cachedGeo) return Promise.resolve(cachedGeo)
  if (!geoPromise) {
    geoPromise = import('../../lib/thai-geo.json').then((m) => {
      cachedGeo = (m.default ?? m) as GeoTree
      return cachedGeo
    })
  }
  return geoPromise
}

// Sort provinces with Bangkok first, then by Thai collation.
function sortProvinces(list: string[]): string[] {
  return [...list].sort((x, y) => {
    if (x === 'กรุงเทพมหานคร') return -1
    if (y === 'กรุงเทพมหานคร') return 1
    return x.localeCompare(y, 'th')
  })
}

// A native <select> styled to match the dark inputs, with a chevron.
function Select({ value, onChange, disabled, placeholder, options }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; placeholder: string; options: string[]
}) {
  // Keep an out-of-list current value selectable so existing data is never lost.
  const opts = value && !options.includes(value) ? [value, ...options] : options
  return (
    <div className="relative">
      <select
        value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className={`${inp} appearance-none pr-8 ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${value ? 'text-white' : 'text-slate-500'}`}>
        <option value="" className="text-slate-500">{placeholder}</option>
        {opts.map((o) => <option key={o} value={o} className="text-white bg-slate-800">{o}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
    </div>
  )
}

export function BillingAddressFields({ officeType, branchCode, address, onChange }: Props) {
  const a = address || {}
  const setAddr = (patch: Partial<ThaiAddress>) => onChange({ officeType, branchCode, address: { ...a, ...patch } })
  const setOffice = (t: string) => onChange({ officeType: t, branchCode: t === 'head_office' ? '' : branchCode, address: a })
  const setBranch = (v: string) => onChange({ officeType, branchCode: v, address: a })

  const [geo, setGeo] = useState<GeoTree | null>(cachedGeo)
  useEffect(() => { if (!geo) loadGeo().then(setGeo) }, [geo])

  const provinces = useMemo(() => (geo ? sortProvinces(Object.keys(geo)) : []), [geo])
  const districts = useMemo(
    () => (geo && a.province && geo[a.province] ? Object.keys(geo[a.province]).sort((x, y) => x.localeCompare(y, 'th')) : []),
    [geo, a.province])
  const subdistricts = useMemo(
    () => (geo && a.province && a.district && geo[a.province]?.[a.district] ? Object.keys(geo[a.province][a.district]).sort((x, y) => x.localeCompare(y, 'th')) : []),
    [geo, a.province, a.district])

  // Cascade: picking a level resets everything below it.
  const onProvince = (p: string) => setAddr({ province: p, district: '', subdistrict: '', postcode: '' })
  const onDistrict = (d: string) => setAddr({ district: d, subdistrict: '', postcode: '' })
  const onSubdistrict = (s: string) => {
    const zip = geo?.[a.province ?? '']?.[a.district ?? '']?.[s] ?? a.postcode ?? ''
    setAddr({ subdistrict: s, postcode: zip, country: a.country || 'Thailand' })
  }

  const loading = !geo

  return (
    <div className="space-y-2.5">
      {/* Head Office / Branch (required on a Thai tax invoice) */}
      <div>
        <label className={lbl}>Head Office / Branch <span className="text-amber-500/70">*</span></label>
        <div className="flex gap-2 mt-1">
          {([['head_office', 'Head Office · สำนักงานใหญ่'], ['branch', 'Branch · สาขา']] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setOffice(v)}
              className={`flex-1 h-9 rounded-lg border text-xs font-medium transition-colors ${officeType === v ? 'bg-amber-500/15 border-amber-500/60 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'}`}>
              {label}
            </button>
          ))}
          {officeType === 'branch' && (
            <input value={branchCode} onChange={(e) => setBranch(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="Branch code (5 digits)" className={`${inp} w-44`} inputMode="numeric" />
          )}
        </div>
      </div>

      {/* Street-level (free text) */}
      <div className="grid grid-cols-3 gap-2.5">
        <div><label className={lbl}>House no. / Moo</label><input value={a.house_no ?? ''} onChange={(e) => setAddr({ house_no: e.target.value })} className={inp} placeholder="เลขที่ / หมู่" /></div>
        <div><label className={lbl}>Soi</label><input value={a.soi ?? ''} onChange={(e) => setAddr({ soi: e.target.value })} className={inp} placeholder="ซอย" /></div>
        <div><label className={lbl}>Road</label><input value={a.road ?? ''} onChange={(e) => setAddr({ road: e.target.value })} className={inp} placeholder="ถนน" /></div>
      </div>

      {/* Cascading Province → District → Sub-district → postal code */}
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={lbl}>Province · จังหวัด <span className="text-amber-500/70">*</span></label>
          <Select value={a.province ?? ''} onChange={onProvince} placeholder={loading ? 'Loading…' : 'Select province'} options={provinces} disabled={loading} />
        </div>
        <div>
          <label className={lbl}>District · อำเภอ/เขต <span className="text-amber-500/70">*</span></label>
          <Select value={a.district ?? ''} onChange={onDistrict} placeholder={a.province ? 'Select district' : 'Select province first'} options={districts} disabled={loading || !a.province} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <div className="col-span-2">
          <label className={lbl}>Sub-district · ตำบล/แขวง <span className="text-amber-500/70">*</span></label>
          <Select value={a.subdistrict ?? ''} onChange={onSubdistrict} placeholder={a.district ? 'Select sub-district' : 'Select district first'} options={subdistricts} disabled={loading || !a.district} />
        </div>
        <div>
          <label className={lbl}>Postal code</label>
          <input value={a.postcode ?? ''} onChange={(e) => setAddr({ postcode: e.target.value.replace(/\D/g, '').slice(0, 5) })} className={inp} inputMode="numeric" placeholder="auto" />
        </div>
      </div>
      <div>
        <label className={lbl}>Country</label>
        <input value={a.country ?? 'Thailand'} onChange={(e) => setAddr({ country: e.target.value })} className={inp} />
      </div>
    </div>
  )
}

// Compose a one-line address string for display / printing on the tax invoice.
// Bangkok uses แขวง/เขต; other provinces use ตำบล/อำเภอ.
export function composeThaiAddress(a: ThaiAddress | null | undefined): string {
  if (!a) return ''
  const bkk = a.province === 'กรุงเทพมหานคร'
  const parts = [
    a.house_no,
    a.soi ? `ซ.${a.soi}` : '',
    a.road ? `ถ.${a.road}` : '',
    a.subdistrict ? `${bkk ? 'แขวง' : 'ต.'}${a.subdistrict}` : '',
    a.district ? `${bkk ? 'เขต' : 'อ.'}${a.district}` : '',
    a.province ? `จ.${a.province}` : '',
    a.postcode,
    a.country && a.country !== 'Thailand' ? a.country : '',
  ].filter(Boolean)
  return parts.join(' ')
}
