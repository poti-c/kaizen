import { useEffect, useState } from 'react'
import { FileUp, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { pdfTextItems } from '@/lib/pdfText'
import { parseR052Pdf, mergeR052, type R052 } from '@/lib/roomAvailabilityReports'
import { Button } from '@/components/ui/button'

export function RoomAvailabilityUpload() {
  const {profile}=useAuth(), {activeCompany}=useCompany(), {lang}=useLanguage(), th=lang==='th'
  const companyId=activeCompany?.id
  const [current,setCurrent]=useState<File|null>(null), [next,setNext]=useState<File|null>(null)
  const [parsed,setParsed]=useState<R052|null>(null), [busy,setBusy]=useState(false), [saving,setSaving]=useState(false), [error,setError]=useState(''), [saved,setSaved]=useState('')
  const [last,setLast]=useState<{report_date:string;updated_at:string}|null>(null)
  useEffect(()=>{setCurrent(null);setNext(null);setParsed(null);setSaved('');setError('');setLast(null);if(!companyId)return;let cancelled=false;void supabase.from('kaizen_room_availability').select('report_date,updated_at').eq('company_id',companyId).maybeSingle().then(({data})=>{if(!cancelled)setLast(data)});return()=>{cancelled=true}},[companyId])
  useEffect(()=>{let cancelled=false;setParsed(null);setError('');setBusy(false);if(!current||!next)return;setSaved('');setBusy(true);void Promise.all([pdfTextItems(current),pdfTextItems(next)]).then(([a,b])=>mergeR052(parseR052Pdf(a),parseR052Pdf(b))).then(r=>{if(!cancelled)setParsed(r)}).catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(!cancelled)setBusy(false)});return()=>{cancelled=true}},[current,next])
  async function save(){if(!parsed||!companyId||!profile)return;setSaving(true);setError('');try{const updated_at=new Date().toISOString();const {error:err}=await supabase.from('kaizen_room_availability').upsert({company_id:companyId,report_date:parsed.reportDate,report:parsed,uploaded_by:profile.id,updated_at},{onConflict:'company_id'});if(err)throw err;setLast({report_date:parsed.reportDate,updated_at});setSaved(th?'บันทึกรายงานแล้ว':'Room availability report saved.');setCurrent(null);setNext(null)}catch(e){setError((e as Error).message||'Could not save report.')}finally{setSaving(false)}}
  const dates=parsed?[...new Set(parsed.values.map(v=>v.date))].sort():[]
  return <>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{([
      [th?'รายงานห้องว่างเดือนปัจจุบัน':'Current Month Room Availability Report',current,setCurrent],
      [th?'รายงานห้องว่างเดือนถัดไป':'Next Month Room Availability Report',next,setNext],
    ] as const).map(([label,file,set])=><label key={label} className={`flex items-center gap-3 rounded-xl border-2 border-dashed p-3.5 cursor-pointer ${file?'border-green-300 bg-green-50':'border-gray-200 bg-white hover:border-[var(--brand-primary)]'}`}><input type="file" accept="application/pdf,.pdf" className="hidden" disabled={saving} onClick={e=>{e.currentTarget.value=''}} onChange={e=>set(e.target.files?.[0]??null)}/>{file?<CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0"/>:<FileUp className="h-5 w-5 text-gray-400 flex-shrink-0"/>}<div className="min-w-0"><div className="text-sm font-medium text-gray-900">{label}</div><div className="text-xs text-gray-500 truncate">{file?.name??'Click to choose PDF'}</div></div></label>)}</div>
    {last&&<p className="text-xs text-gray-600">{th?'อัปโหลดห้องว่างล่าสุด:':'Last room availability upload:'} {new Date(last.updated_at).toLocaleString(th?'th-TH':'en-GB',{timeZone:'Asia/Bangkok'})} · R052 {last.report_date}</p>}
    {busy&&<p className="text-sm text-gray-600 flex gap-2"><Loader2 className="h-4 w-4 animate-spin"/>Reading PDFs…</p>}{error&&<p role="alert" className="text-sm text-red-700 flex gap-2"><AlertTriangle className="h-4 w-4"/>{error}</p>}{saved&&<p className="text-sm text-green-700">{saved}</p>}
    {parsed&&<div className="rounded-xl border border-gray-200 p-4"><h3 className="text-sm font-semibold">{th?'ตรวจสอบก่อนบันทึก':'Check before saving'}</h3><p className="text-xs text-gray-500 mt-1">R052 {parsed.reportDate} · {dates[0]} – {dates[dates.length-1]} · {parsed.types.length} room types · {parsed.types.reduce((a,t)=>a+t.capacity,0)} rooms</p><div className="overflow-auto mt-3"><table className="text-xs w-full text-left"><thead><tr><th>Room type</th><th>Stock</th>{dates.slice(0,10).map(d=><th key={d}>{d.slice(5)}</th>)}</tr></thead><tbody>{parsed.types.map(t=><tr key={t.id} className="border-t"><td className="py-1">{t.name}</td><td>{t.capacity}</td>{dates.slice(0,10).map(d=><td key={d}>{parsed.values.find(v=>v.date===d&&v.roomType===t.id)?.available??'—'}</td>)}</tr>)}</tbody></table></div><Button onClick={save} disabled={saving} className="mt-3">{saving?'Saving…':th?'บันทึกรายงาน':'Save room availability reports'}</Button></div>}
    </>
}
