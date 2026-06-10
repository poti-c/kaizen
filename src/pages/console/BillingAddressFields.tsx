import { useState, useRef } from 'react'
import { MapPin, Search, Loader2 } from 'lucide-react'

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

// Lazy-load the ~0.8 MB Thai geography only when the billing form is used.
let cachedLib: any = null
async function loadLib() {
  if (cachedLib) return cachedLib
  const m: any = await import('thai-address-database')
  cachedLib = m.default ?? m
  return cachedLib
}

interface Match { subdistrict: string; district: string; province: string; postcode: string }

export function BillingAddressFields({ officeType, branchCode, address, onChange }: Props) {
  const a = address || {}
  const setAddr = (patch: Partial<ThaiAddress>) => onChange({ officeType, branchCode, address: { ...a, ...patch } })
  const setOffice = (t: string) => onChange({ officeType: t, branchCode: t === 'head_office' ? '' : branchCode, address: a })
  const setBranch = (v: string) => onChange({ officeType, branchCode: v, address: a })

  const [q, setQ] = useState('')
  const [results, setResults] = useState<Match[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function onSearch(val: string) {
    setQ(val); setOpen(true)
    if (debRef.current) clearTimeout(debRef.current)
    if (!val.trim()) { setResults([]); return }
    debRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const lib = await loadLib()
        const term = val.trim()
        const raw = /^\d+$/.test(term) ? lib.searchAddressByZipcode(term) : lib.searchAddressByDistrict(term)
        // The library labels sub-district as `district` and district as `amphoe`.
        setResults((raw || []).slice(0, 12).map((r: any) => ({
          subdistrict: r.district, district: r.amphoe, province: r.province, postcode: r.zipcode,
        })))
      } catch { setResults([]) }
      setSearching(false)
    }, 200)
  }

  function pick(r: Match) {
    setAddr({ subdistrict: r.subdistrict, district: r.district, province: r.province, postcode: r.postcode, country: a.country || 'Thailand' })
    setQ(''); setResults([]); setOpen(false)
  }

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

      {/* Sub-district / postal-code lookup → fills the hierarchy */}
      <div className="relative">
        <label className={lbl}>Find sub-district / postal code <span className="text-amber-500/70">*</span></label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
          <input value={q} onChange={(e) => onSearch(e.target.value)} onFocus={() => q && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            className={`${inp} pl-8`} placeholder="Type ตำบล/แขวง or postal code…" />
          {searching && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 animate-spin" />}
        </div>
        {open && results.length > 0 && (
          <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
            {results.map((r, i) => (
              <button key={i} type="button" onMouseDown={(e) => { e.preventDefault(); pick(r) }}
                className="w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 flex items-center gap-2">
                <MapPin className="h-3 w-3 text-slate-500 shrink-0" />
                <span>{r.subdistrict} › {r.district} › {r.province} <span className="text-slate-500">{r.postcode}</span></span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* The selected hierarchy — auto-filled, still editable */}
      <div className="grid grid-cols-2 gap-2.5">
        <div><label className={lbl}>Sub-district · ตำบล/แขวง</label><input value={a.subdistrict ?? ''} onChange={(e) => setAddr({ subdistrict: e.target.value })} className={inp} /></div>
        <div><label className={lbl}>District · อำเภอ/เขต</label><input value={a.district ?? ''} onChange={(e) => setAddr({ district: e.target.value })} className={inp} /></div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <div><label className={lbl}>Province · จังหวัด</label><input value={a.province ?? ''} onChange={(e) => setAddr({ province: e.target.value })} className={inp} /></div>
        <div><label className={lbl}>Postal code</label><input value={a.postcode ?? ''} onChange={(e) => setAddr({ postcode: e.target.value.replace(/\D/g, '').slice(0, 5) })} className={inp} inputMode="numeric" /></div>
        <div><label className={lbl}>Country</label><input value={a.country ?? 'Thailand'} onChange={(e) => setAddr({ country: e.target.value })} className={inp} /></div>
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
