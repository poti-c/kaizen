// kaizen-ambient — weather and air quality for the World Clock board.
//
// Serves both the web /display board and the nnr_esp wall panel:
//   GET ?clocks=chiangmai,tokyo,taipei&home=chiangmai
// returns, for each clock city, its current UTC offset (so the panel needs no
// time-zone tables), temperature and weather; and air quality at `home`.
//
// Air quality comes from Air4Thai (Thailand's Pollution Control Department
// monitoring stations): the nearest station with a valid PM2.5 reading, in the
// Thai AQI that people here know. Outside Thailand, or when Air4Thai is down,
// it falls back to Open-Meteo's modelled values (US AQI). Air4Thai sends no
// CORS headers, which is why the browser comes through here too.
//
// Auth: the panel's device token (same hashed secret as kaizen-esp-display) or
// a signed-in Kaizen user's session. Deployed with verify_jwt=false because the
// device token is not a JWT. Only cities from CITIES are accepted, so this is
// not an open weather relay. No Kaizen data is involved.

import { timingSafeEqual } from "node:crypto"
import { createClient } from "npm:@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
}
const reply = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { ...cors, "Cache-Control": "no-store" } })

// Cities offered on the board. Keep in step with src/lib/worldClock.ts.
type City = { name: string; nameTh: string; country: string; countryTh: string; tz: string; lat: number; lon: number }
const CITIES: Record<string, City> = {
  // Na Nirand, Charoen Rat Road (approximate; city-level is all weather/AQ need)
  chiangmai: { name: "Chiang Mai", nameTh: "เชียงใหม่", country: "Thailand", countryTh: "ไทย", tz: "Asia/Bangkok", lat: 18.787, lon: 99.001 },
  bangkok: { name: "Bangkok", nameTh: "กรุงเทพฯ", country: "Thailand", countryTh: "ไทย", tz: "Asia/Bangkok", lat: 13.7563, lon: 100.5018 },
  tokyo: { name: "Tokyo", nameTh: "โตเกียว", country: "Japan", countryTh: "ญี่ปุ่น", tz: "Asia/Tokyo", lat: 35.6762, lon: 139.6503 },
  osaka: { name: "Osaka", nameTh: "โอซากา", country: "Japan", countryTh: "ญี่ปุ่น", tz: "Asia/Tokyo", lat: 34.6937, lon: 135.5023 },
  taipei: { name: "Taipei", nameTh: "ไทเป", country: "Taiwan", countryTh: "ไต้หวัน", tz: "Asia/Taipei", lat: 25.033, lon: 121.5654 },
  seoul: { name: "Seoul", nameTh: "โซล", country: "South Korea", countryTh: "เกาหลีใต้", tz: "Asia/Seoul", lat: 37.5665, lon: 126.978 },
  hongkong: { name: "Hong Kong", nameTh: "ฮ่องกง", country: "Hong Kong", countryTh: "ฮ่องกง", tz: "Asia/Hong_Kong", lat: 22.3193, lon: 114.1694 },
  shanghai: { name: "Shanghai", nameTh: "เซี่ยงไฮ้", country: "China", countryTh: "จีน", tz: "Asia/Shanghai", lat: 31.2304, lon: 121.4737 },
  singapore: { name: "Singapore", nameTh: "สิงคโปร์", country: "Singapore", countryTh: "สิงคโปร์", tz: "Asia/Singapore", lat: 1.3521, lon: 103.8198 },
  dubai: { name: "Dubai", nameTh: "ดูไบ", country: "UAE", countryTh: "สหรัฐอาหรับเอมิเรตส์", tz: "Asia/Dubai", lat: 25.2048, lon: 55.2708 },
  london: { name: "London", nameTh: "ลอนดอน", country: "UK", countryTh: "สหราชอาณาจักร", tz: "Europe/London", lat: 51.5072, lon: -0.1276 },
  paris: { name: "Paris", nameTh: "ปารีส", country: "France", countryTh: "ฝรั่งเศส", tz: "Europe/Paris", lat: 48.8566, lon: 2.3522 },
  newyork: { name: "New York", nameTh: "นิวยอร์ก", country: "USA", countryTh: "สหรัฐอเมริกา", tz: "America/New_York", lat: 40.7128, lon: -74.006 },
  losangeles: { name: "Los Angeles", nameTh: "ลอสแอนเจลิส", country: "USA", countryTh: "สหรัฐอเมริกา", tz: "America/Los_Angeles", lat: 34.0522, lon: -118.2437 },
  sydney: { name: "Sydney", nameTh: "ซิดนีย์", country: "Australia", countryTh: "ออสเตรเลีย", tz: "Australia/Sydney", lat: -33.8688, lon: 151.2093 },
}

// WMO weather codes (Open-Meteo) -> icon + label
function weather(code: number, isDay: boolean) {
  const w = (icon: string, en: string, th: string) => ({ icon, label: en, labelTh: th })
  if (code === 0) return isDay ? w("sun", "Clear", "ท้องฟ้าแจ่มใส") : w("moon", "Clear", "ท้องฟ้าแจ่มใส")
  if (code <= 2) return w(isDay ? "partly" : "partly-night", "Partly cloudy", "มีเมฆบางส่วน")
  if (code === 3) return w("cloud", "Cloudy", "มีเมฆมาก")
  if (code === 45 || code === 48) return w("fog", "Fog", "หมอก")
  if (code >= 51 && code <= 57) return w("drizzle", "Drizzle", "ฝนปรอย")
  if (code >= 61 && code <= 67) return w("rain", "Rain", "ฝนตก")
  if (code >= 71 && code <= 77) return w("snow", "Snow", "หิมะ")
  if (code >= 80 && code <= 82) return w("rain", "Showers", "ฝนเป็นช่วง")
  if (code >= 85 && code <= 86) return w("snow", "Snow showers", "หิมะเป็นช่วง")
  if (code >= 95) return w("storm", "Thunderstorm", "พายุฝนฟ้าคะนอง")
  return w("cloud", "Cloudy", "มีเมฆมาก")
}

// Current UTC offset of a time zone, in minutes (handles DST).
function offsetMinutes(tz: string, at = new Date()): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at).find(p => p.type === "timeZoneName")?.value ?? "GMT"
  const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/)
  if (!m) return 0
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
}

// Thai AQI levels (Pollution Control Department), by Air4Thai's color_id.
const THAI_LEVELS = [
  null,
  { label: "Very good", labelTh: "คุณภาพอากาศดีมาก", color: "#3bccff" },
  { label: "Good", labelTh: "คุณภาพอากาศดี", color: "#92d050" },
  { label: "Moderate", labelTh: "ปานกลาง", color: "#ffff00" },
  { label: "Starting to affect health", labelTh: "เริ่มมีผลกระทบต่อสุขภาพ", color: "#ffa200" },
  { label: "Affects health", labelTh: "มีผลกระทบต่อสุขภาพ", color: "#f04646" },
]
function usLevel(aqi: number) {
  if (aqi <= 50) return { label: "Good", labelTh: "ดี", color: "#22c55e" }
  if (aqi <= 100) return { label: "Moderate", labelTh: "ปานกลาง", color: "#facc15" }
  if (aqi <= 150) return { label: "Unhealthy for sensitive groups", labelTh: "มีผลต่อกลุ่มเสี่ยง", color: "#f97316" }
  if (aqi <= 200) return { label: "Unhealthy", labelTh: "มีผลกระทบต่อสุขภาพ", color: "#ef4444" }
  if (aqi <= 300) return { label: "Very unhealthy", labelTh: "มีผลกระทบต่อสุขภาพมาก", color: "#a855f7" }
  return { label: "Hazardous", labelTh: "อันตราย", color: "#9f1239" }
}

function km(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}
const reading = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Air4Thai's server sends the wrong intermediate certificates: its certificate
// is from Let's Encrypt's new "Generation Y" chain (issuer YR1, root ISRG Root
// YR, not yet in common trust stores), but it serves an unrelated Sectigo
// chain. Browsers and macOS patch over that; Deno (rustls) rejects it. So for
// Air4Thai only, trust Let's Encrypt's YR1-YR3 intermediates (from
// http://yr{1,2,3}.i.lencr.org/, valid to 2028-09-02).
const LENCR_YR = `-----BEGIN CERTIFICATE-----
MIIE2zCCAsOgAwIBAgIRAKICU/FfJpHAXcHOE7m8yk4wDQYJKoZIhvcNAQELBQAw
LjELMAkGA1UEBhMCVVMxDTALBgNVBAoTBElTUkcxEDAOBgNVBAMTB1Jvb3QgWVIw
HhcNMjUwOTAzMDAwMDAwWhcNMjgwOTAyMjM1OTU5WjAzMQswCQYDVQQGEwJVUzEW
MBQGA1UEChMNTGV0J3MgRW5jcnlwdDEMMAoGA1UEAxMDWVIxMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoVi8X2xCYgMXvJxNPKp/oF13UMgmPABB07VC
LNDtoXmt9luEZNJSBV10VyT1Pz6LD8Zq1d2gc43WNl1AdRrj4sEnazbOiz0nPpmG
Bp2hui49oZtDIY6wdKeZAi5BbNU20CH6RSBBMLSQ9cXrH8dxdv4PAJ45ssGML68U
SE3BsjC2a6cAN9L5CgXVIQi5tfNiTPoFZZ3S0OlXqLmmtdV95udWAb5b6e/F49Di
CsH0Y00Ag72BVIb1hzynmKe+X0mERBTtsb3BwmpV9ipeBjMLoR/D9cHxHQCWoi5l
TmXwY015J5rGelz1nZjJuxc2kioaX29XJBnhMkP531rSdG5uMwIDAQABo4HuMIHr
MA4GA1UdDwEB/wQEAwIBhjATBgNVHSUEDDAKBggrBgEFBQcDATASBgNVHRMBAf8E
CDAGAQH/AgEAMB0GA1UdDgQWBBQfLzW+RhSCzUCxrnksVXj699Ro+zAfBgNVHSME
GDAWgBTe51tg0CJtQCh9Pw0B/qS1UrRRlDAyBggrBgEFBQcBAQQmMCQwIgYIKwYB
BQUHMAKGFmh0dHA6Ly95ci5pLmxlbmNyLm9yZy8wEwYDVR0gBAwwCjAIBgZngQwB
AgEwJwYDVR0fBCAwHjAcoBqgGIYWaHR0cDovL3lyLmMubGVuY3Iub3JnLzANBgkq
hkiG9w0BAQsFAAOCAgEA0+zvMq3kHig1ddTmmm+RibTr9/RpX7k4buanMMRqbV/y
IvP82zAHN3mvaw+cASuVsdpd0ikjhr4hnhJQLQOzOp2ccKrsdGOAgo0vddeISFAq
EWEV4lmUM3vFF796up+bSgmJ1u6RupDCMxDgF8M3eLvGuj6L0lu3zkQ0KuQLnKxL
tB0oQqn1Idg5CuuGpMvQzk29Pa3D/qHurc0EIM9SxukQuJqq63lxsYyRQFU8yMBO
hq1w5LbfaWNRrz1uklOfI/pYkAb2E2MTZrAMQkBIE2S8Jt1F8gRc96o/xOsrgvSk
a84AisX6xq1lz1Z7jGvrnXc4TMcjxZTjiTaihcYI1JIXZiLtEMSCa5l3cu8YWd6z
dLRQlqRdclVjuQfNHawRJ6GWlkK0QJosivTKwdBw3KxEtzGo8yMHERbsy57gP1UX
HOMcmZYQC0gtyR3SxfenIM/MxC3Ia2Ypab/kQ/CTnlIn2KQ5JUC6NYrGCbhFN9bp
5lKJStEwCUnLpntcrXk5XVDCNv/5RyWpRThkGOV7GetKkQ0qAY8hCzWK6oqnAhDZ
cjlYVdWfqOw3DIOX6EDNBgAqHarRVxyF9QZdOaXSyPJ0ueD2BYJEBgaCGQ8rAaU/
Qc123V5LTXDZW4CcsPBDyhy4v+c8hClAyw/IkJlfBqxB9D+/wvIMHgECZ4ptP6o=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIE2jCCAsKgAwIBAgIQTr0klH4k05SALYSlL9WzGTANBgkqhkiG9w0BAQsFADAu
MQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZUjAe
Fw0yNTA5MDMwMDAwMDBaFw0yODA5MDIyMzU5NTlaMDMxCzAJBgNVBAYTAlVTMRYw
FAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZUjIwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQDZ0LxwBppqh84luqMerV/eeL/fXQ7mLQQv1Lnp
WKZbyvGpx6wh6AfnslAnF6ewTkcHA+gSOoBvm3Dfm06AuGiF+KRut4fAcowqnAQQ
CW98+QPP/eOv/wug7Iyk4NkOxf2I6g2f55T6nJoOTLFcukeRq80JGQEYan+dPFr9
OGUgQK2hGKgNkW87pappsOAuUJcroYhRt5uUis4qaZireiseu32gzDJNBAiKtsvd
6HX4v25bpkRNcS/B/Gtc9kVbUpD+2PLPxdei3Tim55k4tfAEXwD2qyiPTxrTNq6l
N+AMr5g2c1dNqkOTwjxeV6L5lpP1rGiYvLnRaPlOqyZRPW+5AgMBAAGjge4wgesw
DgYDVR0PAQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBIGA1UdEwEB/wQI
MAYBAf8CAQAwHQYDVR0OBBYEFEAVLSZ57TIgnt+ach3WMh+BDIEMMB8GA1UdIwQY
MBaAFN7nW2DQIm1AKH0/DQH+pLVStFGUMDIGCCsGAQUFBwEBBCYwJDAiBggrBgEF
BQcwAoYWaHR0cDovL3lyLmkubGVuY3Iub3JnLzATBgNVHSAEDDAKMAgGBmeBDAEC
ATAnBgNVHR8EIDAeMBygGqAYhhZodHRwOi8veXIuYy5sZW5jci5vcmcvMA0GCSqG
SIb3DQEBCwUAA4ICAQB0ZUQWZ9/Yn9COEpo+JfecMnB0h0vwDm/M66IqXqw3LoaL
mx9lZvRTeDIS67PUeI3yCA2W6PKRD0/FE/G57lOmS+Xy5AaaL00ICGOqjNcCaMWW
8o8nevHOd4i4lqgtznE/28QwlcdJyF8yBiWHpnyjhEpmNWJURgOCOg2xpwRMBCsj
MScqYPtOhBeuYQvSwAEeTML2Ukh6uGuX4E14q65Ja8cdjF5bAldnP1eE4FBaAwsZ
G2fOqqrKV03Y85Nw2btedP1AtliQuJZs/Jo/gXxXdc7LrH3McgnpnbTiAncX7yES
hP6kzQejllqMCIt52HOjxDGWafS7Xw+DKwqmH+Eqy8dcbOuag/1AYlQoKNVK3F5q
Hh6tEDiMqQcLIibGKteE6iHo4A/bIScbzrhXUYuism42ZYzmc48FMVIH3qy4L84E
TdAH2gtxw0PAhvRVXp8HP7wfngpzsN/8xOTpeRSbM4+Qbc56G6+Bifmv6sk1ieQb
NA3wJdl4DDUuQSV8hBgx6zoI1ZSGORprDFux7c6rhc77QZMSRrEgomBeklervEve
86ylWmZ3WWHV6RLMi8xNvjd71r4EPIGgY7BZU/VPBkq+uA7Gb6mbJnFgV43uh3xy
LRFgxIAphIukwTGSMZZR+AI+Qnp0BYTWovHXozOf3H8r6hozEoT02JHn0AeTfA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIE2jCCAsKgAwIBAgIQdv2+nJw5pmI1PsQaDsOT/jANBgkqhkiG9w0BAQsFADAu
MQswCQYDVQQGEwJVUzENMAsGA1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZUjAe
Fw0yNTA5MDMwMDAwMDBaFw0yODA5MDIyMzU5NTlaMDMxCzAJBgNVBAYTAlVTMRYw
FAYDVQQKEw1MZXQncyBFbmNyeXB0MQwwCgYDVQQDEwNZUjMwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQDJS0+QyfrZm8U0nXugJKg+3nraHoxKN9NOsGvH
T9NtcdgThWuj6gizDMqn9VQilyPJ+qKK7rjgBM/XK3ogx61EPbgQY8LiVNn4nsmR
1UFUdalb/cL/mYtXo3lu3qop7k6Ol+pOLzvlBINhl+Mq7l9VxUCM717UpYumNKxG
NRjALGg5H16C93UQlW8KgRpW58fY5Be3cLqv24bbKRFisb7S/HPA967pW6rAO/DF
FKbi35NfHKEG0jIGqxtsbYbK+/0qe2147p9oUO/SNcuaT9poLFWKmcY90UR0hXKy
+qiR6Kv7/e5gCK/BGkjLXM1AfX1CRDwOiIPPsK+RJOIj00ilAgMBAAGjge4wgesw
DgYDVR0PAQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBIGA1UdEwEB/wQI
MAYBAf8CAQAwHQYDVR0OBBYEFGllKfkz+Am2QtXh87W1nR9feiJ8MB8GA1UdIwQY
MBaAFN7nW2DQIm1AKH0/DQH+pLVStFGUMDIGCCsGAQUFBwEBBCYwJDAiBggrBgEF
BQcwAoYWaHR0cDovL3lyLmkubGVuY3Iub3JnLzATBgNVHSAEDDAKMAgGBmeBDAEC
ATAnBgNVHR8EIDAeMBygGqAYhhZodHRwOi8veXIuYy5sZW5jci5vcmcvMA0GCSqG
SIb3DQEBCwUAA4ICAQCNj5bxci8knkGgfw3qSv0KbbjZpmKUgZzgYYW6EpiFj4Bx
8CTQ79RCEuitFdGFOvG9xfQdWArQlaO/bsmNcsz0D9wiuwxc9RCo6JC4BKRMcmKE
fRiLzHWwHZfUj0sCAY0yBryOGL80J3sD2C3mjAFwV2mVIeuVKOhQeTcstVceW97+
38AC+juHSq+xu/HuCbX0LgTzMzh8RYy8OtO80IFE2v8qAEDIK2PYoQp27nwftAIC
AtOoGzqHDJqPWeiSTQgt1ndRgGAmV7H0HssX66i8naQFlsiidol4goFYEVMVJArp
g2X5NyumCCX/aSnXKgp8leQ6XoVQz0VI6+k1a0goPUJB7xp67BkCxkwJamDOMpQL
xpdTPI2Z1TO2BuEyzBd8DC/yfm1+rvMCRG3AX44f0ra2ueiM7cdRvzcE+b3c2fun
1n/4xzigiimm8Rzs6Cc0A59mt3XhruOe+zGIXtJgn0wf9XfJhKdKcdEH5VNhFapn
Gc9Tm+fd4n5Qojd7W2CwdBUBgwYIt4Cqxqr2OEf7/k1Xm8eplMQlhwySs/hM0dY6
csOPNIXeJm1YsnJyxUGvKRWjOn+vC9k1SXilnnwhcIs9Pp9e5bckYAnB79VJXN/L
8X8xt/9Qm2xmKKe/xzKA+oRvWKofeFGKU7hcnFbyUwlCu0d+JkgWxQu4x4drcQ==
-----END CERTIFICATE-----`
let air4thaiClient: Deno.HttpClient | undefined
try {
  air4thaiClient = Deno.createHttpClient({ caCerts: [LENCR_YR] })
} catch {
  air4thaiClient = undefined  // runtime without custom clients: plain fetch, then the fallback
}

type Air = Record<string, unknown>
async function air4thai(home: City): Promise<Air | null> {
  const res = await fetch("https://air4thai.pcd.go.th/services/getNewAQI_JSON.php",
    { client: air4thaiClient, signal: AbortSignal.timeout(8000) } as RequestInit)
  if (!res.ok) return null
  const { stations } = await res.json() as { stations: Record<string, any>[] }
  let best: { s: Record<string, any>; d: number } | null = null
  for (const s of stations ?? []) {
    if (reading(s.AQILast?.PM25?.value) === null) continue
    const d = km(home.lat, home.lon, Number(s.lat), Number(s.long))
    if (d <= 40 && (!best || d < best.d)) best = { s, d }
  }
  if (!best) return null
  const last = best.s.AQILast
  const level = THAI_LEVELS[Number(last.AQI?.color_id)] ?? THAI_LEVELS[Number(last.PM25?.color_id)] ?? null
  return {
    source: "Air4Thai",
    scale: "TH",
    station: { id: best.s.stationID, name: String(best.s.nameEN ?? "").trim(), nameTh: String(best.s.nameTH ?? "").trim(), km: Math.round(best.d * 10) / 10 },
    time: `${last.date} ${last.time}`,
    aqi: reading(last.AQI?.aqi),
    level,
    pollutants: [
      { key: "PM2.5", value: reading(last.PM25?.value), unit: "µg/m³" },
      { key: "PM10", value: reading(last.PM10?.value), unit: "µg/m³" },
      { key: "O3", value: reading(last.O3?.value), unit: "ppb" },
      { key: "NO2", value: reading(last.NO2?.value), unit: "ppb" },
      { key: "CO", value: reading(last.CO?.value), unit: "ppm" },
    ].filter(p => p.value !== null),
  }
}
async function openMeteoAir(home: City): Promise<Air | null> {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${home.lat}&longitude=${home.lon}` +
    "&current=pm2_5,pm10,us_aqi,ozone,nitrogen_dioxide,carbon_monoxide&timezone=auto"
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return null
  const c = (await res.json()).current ?? {}
  const aqi = reading(c.us_aqi)
  return {
    source: "Open-Meteo (CAMS model)",
    scale: "US",
    station: null,
    time: String(c.time ?? "").replace("T", " "),
    aqi,
    level: aqi === null ? null : usLevel(aqi),
    pollutants: [
      { key: "PM2.5", value: reading(c.pm2_5), unit: "µg/m³" },
      { key: "PM10", value: reading(c.pm10), unit: "µg/m³" },
      { key: "O3", value: reading(c.ozone), unit: "µg/m³" },
      { key: "NO2", value: reading(c.nitrogen_dioxide), unit: "µg/m³" },
      { key: "CO", value: reading(c.carbon_monoxide), unit: "µg/m³" },
    ].filter(p => p.value !== null),
  }
}

// Weather and air change slowly; keep results for 10 minutes per request shape.
const cache = new Map<string, { at: number; body: unknown }>()
const TTL = 10 * 60 * 1000

const tokenHashes = (Deno.env.get("KAIZEN_ESP_DISPLAY_TOKEN_SHA256") ?? "")
  .split(",").map(s => s.trim().toLowerCase()).filter(s => /^[0-9a-f]{64}$/.test(s))
  .map(hex => Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16)))

async function authorized(req: Request): Promise<boolean> {
  const header = req.headers.get("Authorization") ?? ""
  if (!header.startsWith("Bearer ")) return false
  const token = header.slice(7)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))
  for (const h of tokenHashes) if (timingSafeEqual(digest, h)) return true  // the panel
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await db.auth.getUser(token)                     // a signed-in user
  return !error && !!data.user
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "GET") return reply(405, { error: "Method not allowed" })
  if (!(await authorized(req))) return reply(401, { error: "Unauthorized" })

  const q = new URL(req.url).searchParams
  const keys = (q.get("clocks") ?? "chiangmai,tokyo,taipei").split(",").map(s => s.trim()).filter(k => k in CITIES).slice(0, 3)
  const homeKey = q.get("home") && q.get("home")! in CITIES ? q.get("home")! : "chiangmai"
  if (!keys.length) return reply(400, { error: "No known cities" })

  const cacheKey = `${keys.join(",")}|${homeKey}`
  const hit = cache.get(cacheKey)
  let body: Record<string, unknown>
  if (hit && Date.now() - hit.at < TTL) {
    body = hit.body as Record<string, unknown>
  } else {
    const cities = keys.map(k => CITIES[k])
    const home = CITIES[homeKey]
    const wxUrl = "https://api.open-meteo.com/v1/forecast?" +
      `latitude=${cities.map(c => c.lat).join(",")}&longitude=${cities.map(c => c.lon).join(",")}` +
      "&current=temperature_2m,weather_code,is_day"
    const [wx, air] = await Promise.all([
      fetch(wxUrl, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null).catch(() => null),
      air4thai(home).catch(() => null).then(a => a ?? openMeteoAir(home).catch(() => null)),
    ])
    const list = Array.isArray(wx) ? wx : wx ? [wx] : []
    body = {
      clocks: keys.map((k, i) => {
        const c = CITIES[k], cur = list[i]?.current
        return {
          key: k, name: c.name, nameTh: c.nameTh, country: c.country, countryTh: c.countryTh, tz: c.tz,
          temp: cur ? Math.round(Number(cur.temperature_2m)) : null,
          ...(cur ? weather(Number(cur.weather_code), Number(cur.is_day) === 1) : { icon: null, label: null, labelTh: null }),
        }
      }),
      home: { key: homeKey, name: home.name, nameTh: home.nameTh },
      air,
      fetchedAt: new Date().toISOString(),
    }
    cache.set(cacheKey, { at: Date.now(), body })
  }
  // Offsets are computed per request (cheap) so a DST change never waits on the cache.
  const now = new Date()
  const clocks = (body.clocks as Record<string, unknown>[]).map(c => ({ ...c, offsetMin: offsetMinutes(String(c.tz), now) }))
  return reply(200, { ...body, clocks, now: now.toISOString() })
})
