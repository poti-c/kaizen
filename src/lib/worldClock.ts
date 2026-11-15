// Cities for the World Clock board. Keep in step with CITIES in
// supabase/functions/kaizen-ambient/index.ts (which fetches their weather).
export interface CityOption {
  key: string
  name: string
  nameTh: string
  country: string
  countryTh: string
  tz: string
}

export const CITY_OPTIONS: CityOption[] = [
  { key: 'chiangmai',  name: 'Chiang Mai',  nameTh: 'เชียงใหม่',   country: 'Thailand', countryTh: 'ไทย', tz: 'Asia/Bangkok' },
  { key: 'bangkok',    name: 'Bangkok',     nameTh: 'กรุงเทพฯ',    country: 'Thailand', countryTh: 'ไทย', tz: 'Asia/Bangkok' },
  { key: 'tokyo',      name: 'Tokyo',       nameTh: 'โตเกียว',     country: 'Japan', countryTh: 'ญี่ปุ่น', tz: 'Asia/Tokyo' },
  { key: 'osaka',      name: 'Osaka',       nameTh: 'โอซากา',      country: 'Japan', countryTh: 'ญี่ปุ่น', tz: 'Asia/Tokyo' },
  { key: 'taipei',     name: 'Taipei',      nameTh: 'ไทเป',        country: 'Taiwan', countryTh: 'ไต้หวัน', tz: 'Asia/Taipei' },
  { key: 'seoul',      name: 'Seoul',       nameTh: 'โซล',         country: 'South Korea', countryTh: 'เกาหลีใต้', tz: 'Asia/Seoul' },
  { key: 'hongkong',   name: 'Hong Kong',   nameTh: 'ฮ่องกง',      country: 'Hong Kong', countryTh: 'ฮ่องกง', tz: 'Asia/Hong_Kong' },
  { key: 'shanghai',   name: 'Shanghai',    nameTh: 'เซี่ยงไฮ้',    country: 'China', countryTh: 'จีน', tz: 'Asia/Shanghai' },
  { key: 'singapore',  name: 'Singapore',   nameTh: 'สิงคโปร์',     country: 'Singapore', countryTh: 'สิงคโปร์', tz: 'Asia/Singapore' },
  { key: 'dubai',      name: 'Dubai',       nameTh: 'ดูไบ',        country: 'UAE', countryTh: 'สหรัฐอาหรับเอมิเรตส์', tz: 'Asia/Dubai' },
  { key: 'london',     name: 'London',      nameTh: 'ลอนดอน',      country: 'UK', countryTh: 'สหราชอาณาจักร', tz: 'Europe/London' },
  { key: 'paris',      name: 'Paris',       nameTh: 'ปารีส',       country: 'France', countryTh: 'ฝรั่งเศส', tz: 'Europe/Paris' },
  { key: 'newyork',    name: 'New York',    nameTh: 'นิวยอร์ก',     country: 'USA', countryTh: 'สหรัฐอเมริกา', tz: 'America/New_York' },
  { key: 'losangeles', name: 'Los Angeles', nameTh: 'ลอสแอนเจลิส', country: 'USA', countryTh: 'สหรัฐอเมริกา', tz: 'America/Los_Angeles' },
  { key: 'sydney',     name: 'Sydney',      nameTh: 'ซิดนีย์',      country: 'Australia', countryTh: 'ออสเตรเลีย', tz: 'Australia/Sydney' },
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
