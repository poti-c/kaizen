import { linesFromItems, type PdfTextItem } from './hotelReports'

export type TypeAvailability = { date: string; roomType: string; available: number }
export type R052 = { reportDate: string; types: { id: string; name: string; capacity: number }[]; values: TypeAvailability[] }
const names: Record<string,string> = { DLXK:'Deluxe King', DLT:'Deluxe Twin', GDK:'Grand King', GDT:'Grand Twin', RDK:'Royal King', RDT:'Royal Twin', CSK:'Corner Suite', RCK:'Riverfront Suite' }
const iso = (d: string) => { const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (!m) throw new Error(`Invalid date: ${d}`); const date = `${m[3]}-${m[2]}-${m[1]}`; if (new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) throw new Error(`Invalid date: ${d}`); return date }
const nextDay = (d:string) => new Date(new Date(d+'T00:00:00Z').getTime()+86400000).toISOString().slice(0,10)
export function parseR052Pdf(items: PdfTextItem[]): R052 {
  const lines = linesFromItems(items)
  if (!lines.some(l=>/R052|Room Type Availability Report/i.test(l))) throw new Error('Not an R052 Room Type Availability Report.')
  const printed=lines.filter(l=>!/As at date/i.test(l)).map(l=>l.match(/(?:^|\s)Date\s*:\s*(\d{2}\/\d{2}\/\d{4})/i)).find(m=>m)
  const footer=lines.map(l=>l.match(/Printed by.*?(\d{2}\/\d{2}\/\d{4})/i)).find(m=>m)
  const reportDate=iso(printed?.[1] ?? footer?.[1] ?? '')
  // R052's room-type names sit above the vertically centered Date/Day and
  // OCC/OOO/Availability labels. PDF text extraction puts them on separate
  // lines even though the printed header appears to be a single row.
  const header=lines.find((l,i)=>/\b[A-Z][A-Z0-9]+\s*\(\s*\d+\s*\)/.test(l) && lines.slice(Math.max(0,i-1),i+3).some(h=>/\bOCC\b/i.test(h)&&/\bOOO\b/i.test(h)&&/Availability/i.test(h)))
  if (!header) throw new Error('Could not locate the room-type column headers.')
  const types=Array.from(header.matchAll(/\b([A-Z][A-Z0-9]+)\s*\(\s*(\d+)\s*\)/g), m=>({id:m[1],name:names[m[1]] || m[1],capacity:Number(m[2])}))
  if (!types.length || new Set(types.map(t=>t.id)).size!==types.length) throw new Error('Invalid room types.')
  const capacity=types.reduce((a,t)=>a+t.capacity,0), values:TypeAvailability[]=[], dates=new Set<string>()
  for (const line of lines) {
    const m=line.match(/^(\d{2}\/\d{2}\/\d{4})\s+\S{3}\s+(.+)$/)
    if (!m) continue
    const date=iso(m[1]), tokens=m[2].trim().split(/\s+/)
    if (dates.has(date) || tokens.length!==types.length+3 || tokens.some(n=>! /^-?\d+$/.test(n))) throw new Error(`Invalid or duplicate row: ${date}`)
    const nums=tokens.map(Number), avail=nums.slice(0,types.length), [occ,ooo,total]=nums.slice(-3)
    if (avail.reduce((a,n)=>a+n,0)!==total || capacity-occ-ooo!==total || avail.some((n,i)=>n>types[i].capacity)) throw new Error(`Totals do not reconcile for ${date}.`)
    dates.add(date); avail.forEach((available,i)=>values.push({date,roomType:types[i].id,available}))
  }
  if (!values.length) throw new Error('No daily rows found.')
  return {reportDate,types,values}
}
export function mergeR052(current:R052,next:R052):R052 {
  if (current.reportDate!==next.reportDate) throw new Error('Both reports must have the same printed date.')
  if (JSON.stringify(current.types)!==JSON.stringify(next.types)) throw new Error('The room-type columns or inventory differ between reports.')
  const a=[...new Set(current.values.map(v=>v.date))].sort(), b=[...new Set(next.values.map(v=>v.date))].sort()
  const month=current.reportDate.slice(0,7), nextMonth=nextDay(`${month}-${new Date(Date.UTC(+month.slice(0,4),+month.slice(5),0)).getUTCDate()}`).slice(0,7)
  if (!a.every(d=>d.startsWith(month)) || !b.every(d=>d.startsWith(nextMonth)) || nextDay(a[a.length-1])!==b[0]) throw new Error('Select consecutive current-month and next-month reports in that order.')
  const dates=[...a,...b]; if (dates.some((d,i)=>i>0 && nextDay(dates[i-1])!==d)) throw new Error('Report contains missing forecast dates.')
  if (dates[0]>current.reportDate || dates.filter(d=>d>=current.reportDate).length<10) throw new Error('Reports must cover at least ten consecutive days from the report date.')
  return {...current,values:[...current.values,...next.values]}
}
