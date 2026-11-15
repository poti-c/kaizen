// Cities for the World Clock board. Keep in step with CITIES in
// supabase/functions/kaizen-ambient/index.ts (which fetches their weather).
export interface CityOption {
  key: string
  name: string
  nameTh: string
  tz: string
}

export const CITY_OPTIONS: CityOption[] = [
  { key: 'chiangmai',  name: 'Chiang Mai',  nameTh: 'เชียงใหม่',   tz: 'Asia/Bangkok' },
  { key: 'bangkok',    name: 'Bangkok',     nameTh: 'กรุงเทพฯ',    tz: 'Asia/Bangkok' },
  { key: 'tokyo',      name: 'Tokyo',       nameTh: 'โตเกียว',     tz: 'Asia/Tokyo' },
  { key: 'osaka',      name: 'Osaka',       nameTh: 'โอซากา',      tz: 'Asia/Tokyo' },
  { key: 'taipei',     name: 'Taipei',      nameTh: 'ไทเป',        tz: 'Asia/Taipei' },
  { key: 'seoul',      name: 'Seoul',       nameTh: 'โซล',         tz: 'Asia/Seoul' },
  { key: 'hongkong',   name: 'Hong Kong',   nameTh: 'ฮ่องกง',      tz: 'Asia/Hong_Kong' },
  { key: 'shanghai',   name: 'Shanghai',    nameTh: 'เซี่ยงไฮ้',    tz: 'Asia/Shanghai' },
  { key: 'singapore',  name: 'Singapore',   nameTh: 'สิงคโปร์',     tz: 'Asia/Singapore' },
  { key: 'dubai',      name: 'Dubai',       nameTh: 'ดูไบ',        tz: 'Asia/Dubai' },
  { key: 'london',     name: 'London',      nameTh: 'ลอนดอน',      tz: 'Europe/London' },
  { key: 'paris',      name: 'Paris',       nameTh: 'ปารีส',       tz: 'Europe/Paris' },
  { key: 'newyork',    name: 'New York',    nameTh: 'นิวยอร์ก',     tz: 'America/New_York' },
  { key: 'losangeles', name: 'Los Angeles', nameTh: 'ลอสแอนเจลิส', tz: 'America/Los_Angeles' },
  { key: 'sydney',     name: 'Sydney',      nameTh: 'ซิดนีย์',      tz: 'Australia/Sydney' },
]

export const DEFAULT_CLOCKS = ['chiangmai', 'tokyo', 'taipei']
export const DEFAULT_AIR_HOME = 'chiangmai'

export interface ClockCity {
  key: string; name: string; nameTh: string; country: string; countryTh: string; tz: string
  offsetMin: number; temp: number | null
  icon: string | null; label: string | null; labelTh: string | null
}
export interface AirReading {
  source: string
  scale: 'TH' | 'US'
  station: { id: string; name: string; nameTh: string; km: number } | null
  time: string
  aqi: number | null
  level: { label: string; labelTh: string; color: string } | null
  pollutants: { key: string; value: number; unit: string }[]
}
export interface AmbientData {
  clocks: ClockCity[]
  home: { key: string; name: string; nameTh: string }
  air: AirReading | null
  fetchedAt: string
}

// Thai AQI bands (Pollution Control Department) and US AQI bands, for the scale bar.
export const THAI_AQI_BANDS = [
  { upTo: 25, color: '#3bccff' }, { upTo: 50, color: '#92d050' }, { upTo: 100, color: '#ffff00' },
  { upTo: 200, color: '#ffa200' }, { upTo: 300, color: '#f04646' },
]
export const US_AQI_BANDS = [
  { upTo: 50, color: '#22c55e' }, { upTo: 100, color: '#facc15' }, { upTo: 150, color: '#f97316' },
  { upTo: 200, color: '#ef4444' }, { upTo: 300, color: '#a855f7' }, { upTo: 400, color: '#9f1239' },
]
