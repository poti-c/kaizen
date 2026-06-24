import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

// Structured address stored in kaizen_companies.billing_address (jsonb).
// Place names are kept in BOTH languages so the console can display English
// while a Thai tax invoice can still print proper Thai.
export interface ThaiAddress {
  house_no?: string; soi?: string; road?: string
  // Thai names (legal / back-compat with older records)
  subdistrict?: string; district?: string; province?: string
  // English (romanised) names
  subdistrict_en?: string; district_en?: string; province_en?: string
  postcode?: string; country?: string
}

interface Props {
  officeType: string
  branchCode: string
  address: ThaiAddress
  onChange: (next: { officeType: string; branchCode: string; address: ThaiAddress }) => void
}

const inp = 'w-full h-9 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50'
const lbl = 'text-xs font-medium text-slate-400'

// Bilingual geography: province → district → sub-district → postal code.
// The full dataset (~500 KB) is lazy-loaded the first time a billing form mounts.
interface GeoSub { en: string; th: string; z: string }
interface GeoDist { en: string; th: string; s: GeoSub[] }
interface GeoProv { en: string; th: string; d: GeoDist[] }
type GeoTree = GeoProv[]
let cachedGeo: GeoTree | null = null
let geoPromise: Promise<GeoTree> | null = null
function loadGeo(): Promise<GeoTree> {
  if (cachedGeo) return Promise.resolve(cachedGeo)
  if (!geoPromise) {
    geoPromise = import('../../lib/thai-geo.json').then((m) => {
      cachedGeo = (m.default ?? m) as GeoTree
      return cachedGeo
    }).catch((e) => {
      geoPromise = null  // allow retry on next call
      return Promise.reject(e)
    })
  }
  return geoPromise
}

// A native <select> styled to match the dark inputs, with a chevron.
function Select({ value, onChange, disabled, placeholder, options }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; placeholder: string
  options: { v: string; label: string }[]
}) {
  // Keep an out-of-list current value selectable so existing data is never lost.
  const opts = value && !options.some((o) => o.v === value) ? [{ v: value, label: value }, ...options] : options
  return (
    <div className="relative">
      <select
        value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className={`${inp} appearance-none pr-8 ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${value ? 'text-white' : 'text-slate-500'}`}>
        <option value="" className="text-slate-500">{placeholder}</option>
        {opts.map((o) => <option key={o.v} value={o.v} className="text-white bg-slate-800">{o.label}</option>)}
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
  const [geoError, setGeoError] = useState(false)
  useEffect(() => { if (!geo) loadGeo().then(setGeo).catch(() => setGeoError(true)) }, [geo])

  // Resolve the current selection against the dataset, matching by English OR
  // Thai name (so records saved before the bilingual upgrade still display).
  const prov = useMemo(() => geo?.find((p) => p.en === a.province_en || p.th === a.province) ?? null, [geo, a.province_en, a.province])
  const dist = useMemo(() => prov?.d.find((d) => d.en === a.district_en || d.th === a.district) ?? null, [prov, a.district_en, a.district])
  const sub = useMemo(() => dist?.s.find((s) => s.en === a.subdistrict_en || s.th === a.subdistrict) ?? null, [dist, a.subdistrict_en, a.subdistrict])

  const provinceOpts = useMemo(() => (geo ? geo.map((p) => ({ v: p.en, label: p.en })) : []), [geo])
  // Use Thai names as option values (unique within province/district) to prevent
  // duplicate English names (e.g. two "Mueang" districts) from being unselectable.
  const districtOpts = useMemo(() => (prov ? prov.d.map((d) => ({ v: d.th, label: d.en })) : []), [prov])
  const subOpts = useMemo(() => (dist ? dist.s.map((s) => ({ v: s.th, label: s.en })) : []), [dist])

  // Cascade: picking a level fills both languages and resets everything below it.
  const onProvince = (en: string) => {
    const p = geo?.find((x) => x.en === en)
    // Fall back to existing stored Thai name so old records don't lose their province on re-save.
    setAddr({ province_en: p?.en ?? en, province: p?.th ?? a.province ?? '', district_en: '', district: '', subdistrict_en: '', subdistrict: '', postcode: '' })
  }
  const onDistrict = (thName: string) => {
    const d = prov?.d.find((x) => x.th === thName)
    setAddr({ district_en: d?.en ?? a.district_en ?? '', district: d?.th ?? thName, subdistrict_en: '', subdistrict: '', postcode: '' })
  }
  const onSubdistrict = (thName: string) => {
    const s = dist?.s.find((x) => x.th === thName)
    setAddr({ subdistrict_en: s?.en ?? a.subdistrict_en ?? '', subdistrict: s?.th ?? thName, postcode: s?.z ?? a.postcode ?? '', country: a.country ?? 'Thailand' })
  }

  const loading = !geo

  if (geoError) {
    return (
      <div className="text-sm text-red-400 py-2">
        Failed to load address data.{' '}
        <button onClick={() => { setGeoError(false); loadGeo().then(setGeo).catch(() => setGeoError(true)) }}
          className="underline hover:text-red-300">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {/* Head Office / Branch (required on a Thai tax invoice) */}
      <div>
        <label className={lbl}>Head Office / Branch <span className="text-amber-500/70">*</span></label>
        <div className="flex gap-2 mt-1">
          {([['head_office', 'Head Office'], ['branch', 'Branch']] as const).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setOffice(v)}
              className={`flex-1 h-9 rounded-lg border text-xs font-medium transition-colors ${officeType === v ? 'bg-amber-500/15 border-amber-500/60 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'}`}>
              {label}
            </button>
          ))}
          {officeType === 'branch' && (
            <div className="relative">
              <input value={branchCode} onChange={(e) => setBranch(e.target.value.replace(/\D/g, '').slice(0, 5))}
                placeholder="00000" className={`${inp} w-28 ${branchCode.length !== 5 ? 'border-red-500/60' : ''}`} inputMode="numeric" maxLength={5} />
              {branchCode.length !== 5 && <p className="text-[10px] text-red-400 mt-0.5">Must be 5 digits</p>}
            </div>
          )}
        </div>
      </div>

      {/* Street-level (free text) */}
      <div className="grid grid-cols-3 gap-2.5">
        <div><label className={lbl}>House no. / Moo</label><input value={a.house_no ?? ''} onChange={(e) => setAddr({ house_no: e.target.value })} className={inp} placeholder="No. / Moo" /></div>
        <div><label className={lbl}>Soi</label><input value={a.soi ?? ''} onChange={(e) => setAddr({ soi: e.target.value })} className={inp} placeholder="Soi" /></div>
        <div><label className={lbl}>Road</label><input value={a.road ?? ''} onChange={(e) => setAddr({ road: e.target.value })} className={inp} placeholder="Road" /></div>
      </div>

      {/* Cascading Province → District → Sub-district → postal code */}
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={lbl}>Province <span className="text-amber-500/70">*</span></label>
          <Select value={prov?.en ?? a.province_en ?? ''} onChange={onProvince} placeholder={loading ? 'Loading…' : 'Select province'} options={provinceOpts} disabled={loading} />
        </div>
        <div>
          <label className={lbl}>District <span className="text-amber-500/70">*</span></label>
          <Select value={dist?.th ?? a.district ?? ''} onChange={onDistrict} placeholder={prov ? 'Select district' : 'Select province first'} options={districtOpts} disabled={loading || !prov} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <div className="col-span-2">
          <label className={lbl}>Sub-district <span className="text-amber-500/70">*</span></label>
          <Select value={sub?.th ?? a.subdistrict ?? ''} onChange={onSubdistrict} placeholder={dist ? 'Select sub-district' : 'Select district first'} options={subOpts} disabled={loading || !dist} />
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

// Compose a one-line address string in the chosen language.
// Thai: ต./อ./จ. (or แขวง/เขต for Bangkok). English: Tambon/Amphoe (Khwaeng/Khet for Bangkok).
export function composeAddress(a: ThaiAddress | null | undefined, lang: 'en' | 'th'): string {
  if (!a) return ''
  const bkk = a.province === 'กรุงเทพมหานคร' || a.province_en === 'Bangkok'
  if (lang === 'en') {
    // Only use English romanised names — fall back to empty rather than embedding Thai
    // script in an English address (e.g. on printed EN tax invoices).
    const sub = a.subdistrict_en || ''
    const dist = a.district_en || ''
    const prov = a.province_en || ''
    const parts = [
      a.house_no,
      a.soi ? `Soi ${a.soi}` : '',
      a.road ? `${a.road} Rd.` : '',
      sub ? `${bkk ? 'Khwaeng' : 'Tambon'} ${sub}` : '',
      dist ? `${bkk ? 'Khet' : 'Amphoe'} ${dist}` : '',
      prov || '',
      a.postcode,
      a.country && a.country !== 'Thailand' ? a.country : '',
    ].filter(Boolean)
    return parts.join(' ')
  }
  const parts = [
    a.house_no,
    a.soi ? `ซ.${a.soi}` : '',
    a.road ? `ถ.${a.road}` : '',
    a.subdistrict ? `${bkk ? 'แขวง' : 'ต.'}${a.subdistrict}` : '',
    a.district ? `${bkk ? 'เขต' : 'อ.'}${a.district}` : '',
    a.province ? (bkk ? a.province : `จ.${a.province}`) : '',
    a.postcode,
    a.country && a.country !== 'Thailand' ? a.country : '',
  ].filter(Boolean)
  return parts.join(' ')
}

// Back-compat helper — Thai one-liner (used for the stored `address` snapshot).
export function composeThaiAddress(a: ThaiAddress | null | undefined): string {
  return composeAddress(a, 'th')
}
