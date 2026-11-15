# Na Nirand Kaizen wall panel (ESP32)

Native firmware that redraws the Kaizen board of `/display`
(`src/pages/DisplayPage.tsx`) on a GUITION JC8048W550: ESP32-S3, 800 × 480 RGB
LCD, 16 MB flash, 8 MB PSRAM. It polls once a minute over Wi-Fi. The panel is named **nnr_esp**. The Hotel board and touch drill-down are not built yet.

The numbers for both boards come from the `kaizen-esp-display` edge function
(`supabase/functions/kaizen-esp-display`). It computes the same values as the
web board and returns only aggregates, plus case number, department and age
for the Needs Attention rows. The firmware only draws them.

## Data endpoint

```
GET https://znxqmurhjtyfsotcorfj.supabase.co/functions/v1/kaizen-esp-display
Authorization: Bearer <device token>
```

- Deployed with `verify_jwt = false` (see `supabase/config.toml`) because the
  device has no Supabase session. Instead the function checks the bearer
  token itself.
- Supabase stores only the token's SHA-256, in the secret
  `KAIZEN_ESP_DISPLAY_TOKEN_SHA256`. It accepts a comma-separated list, one hash
  per panel.
- The company is pinned by `KAIZEN_ESP_DISPLAY_COMPANY_ID` (Na Nirand is
  `a0000000-0000-0000-0000-000000000001`). The device cannot choose it.
- The service-role key never leaves Supabase.
- **Revoke a panel:** remove its hash from the secret. Removing the secret
  entirely makes the endpoint return 503.
- Responses: 401 without a valid token, 405 for anything but GET.
- The custom domain is plain GitHub Pages, so `/api/esp-display` on
  kaizen.nnr-solutions.com would need a reverse proxy in front of the site. The
  direct Supabase URL is used instead.

If you change a metric rule in `DisplayPage.tsx`, `HotelBoard.tsx` or
`src/lib/utils.ts`, change the function too. The `hotel` block in its response
is already formatted the way `HotelBoard.tsx` formats it, so the panel only
prints it. The panel's font has no baht sign, so the firmware draws ฿ as a B
with a stroke. Its comments mark each rule it mirrors.

## Local configuration (never committed)

`include/device_config.h` holds the Wi-Fi credentials, endpoint URL, device
token and root CA bundle. It is gitignored and created with mode 600; the
firmware falls back to `device_config.example.h` when it is absent.

- **Change Wi-Fi:** run `./configure_wifi.sh`, then build and upload. It prompts
  for the SSID and password without echoing the password. The board joins
  2.4 GHz networks only.
- **Root CAs:** GTS Root R1–R4 (Supabase's current issuer chain), GlobalSign
  Root CA (R4's cross-sign), and ISRG Root X1/X2 as a fallback.
- **New or rotated token:** generate 32 random bytes as hex, put the token in
  `DISPLAY_TOKEN`, and put its SHA-256 in the Supabase secret.

## Build and upload

```sh
"$HOME/.local/share/uv/tools/platformio/bin/pio" run -t upload --upload-port /dev/cu.usbserial-10
```

Serial output (115200 baud):
- At boot, every access point broadcasting the configured SSID, and which
  one it joins.
- On each poll: `Wi-Fi ok, RSSI …, ch …, AP …, fetch ok|failed|waiting for clock`.
- `Dashboard fetch failed (HTTP n)` on HTTP errors.

On screen, the bottom line reads `Live | Refreshes every minute`, with the
live Wi-Fi signal on the right. The signal refreshes every 10 s, so you can
move the panel and watch it. After three missed polls the header shows
`STALE`.

## Touch

The panel has a GT911 capacitive touch controller (I2C at 0x5D: SDA 19,
SCL 20, reset 38). The firmware reads it directly over I2C, with no extra
library.

- **Bottom row:** Kaizen System, Hotel and System Settings switch boards.
- **World Clock board** (third button): three city clocks, each with its UTC
  offset, its difference from the panel's location, today's date, and current
  temperature and weather. Below them is air quality at the panel's location.
  - Cities are picked in System Settings > World clock (defaults: Chiang Mai,
    Tokyo, Taipei; air quality in Chiang Mai). Each row is a dropdown showing
    "City · Country"; tapping it opens the city list grouped by country, and a
    tap outside the list closes it. New cities go in `CITY_LIST` next to the
    others of their country, since the list groups consecutive entries.
  - Data comes from the `kaizen-ambient` edge function every 10 minutes:
    weather from Open-Meteo, air quality from the nearest **Air4Thai** station
    (Thai AQI). It falls back to Open-Meteo's modelled values (US AQI).
  - Times are computed on the panel from the offset kaizen-ambient reports, so
    DST cities are right too, and the board redraws once a minute.
- **Rotate boards** (System Settings > Display): cycles the bottom-row boards in
  order, Kaizen > Hotel > ..., every 15s / 30s / 1m / 2m / 5m. It pauses while a
  case list, Settings or the keyboard is open, and a tap restarts the countdown.
  A board added to `BOARDS` in `main.cpp` (and to the switcher) joins the
  rotation. With rotation off, any board other than Kaizen returns to it after
  2 minutes without a touch.
- **Kaizen board:** tapping a KPI tile (Total, Open, In Progress, Waiting
  Approval, Resolved, Overdue), a category row or a Needs Attention row opens
  the matching cases over the whole board, as on the web. Empty KPI tiles do
  nothing, as on the web.
  - Each row shows priority, number, title, department, status and age.
  - Tap a case to expand it: description, proposed solution, PIC, location
    and reporter.
  - ▲ / ▼ page through long lists; × closes the list.
  - The list closes itself after 30 s without a touch (the web's idle default).
  - The list comes from `?view=cases`, fetched when a list opens and reused for
    a minute.
- **Hotel board:** from the latest `kaizen_hotel_daily` row. The header gives
  the report date ("Figures for Fri 06 Nov 2026"), with an amber "N DAYS OLD"
  tag once the report is two or more days behind.
- **System Settings:** the same overlay as the web's `DisplaySettings.tsx`: a
  tab rail with rows of label, hint and control. Rows the web tags DEVICE ("firmware
  would own on real hardware") are real here. Settings live in NVS and survive a
  restart.
  - Display: brightness slider (tap or drag), night dim with hours and level
    (Bangkok time), orientation Normal/180° (screen and touch flip), and
    language. Language is panel-only; the web follows the app language.
  - Data: refresh interval 15s/30s/1m/5m, touch drill-down on/off (off makes
    the board display-only), and return-to-summary 10s/30s/1m/2m.
  - Network: laid out like a phone's Wi-Fi screen (see "Wi-Fi" below).
  - Device: Reboot and Factory reset, both needing a second tap within 4 s.
    Factory reset clears the panel's NVS settings; Wi-Fi and the token are
    compiled in and stay. The title, device name and location fields are
    read-only (no on-screen keyboard yet), and the critical-case sound is not
    wired, so tapping those says so.
  - About: real chip, PSRAM, flash, uptime and temperature readings. Firmware
    update is over USB only.
  - Settings close themselves after 2 minutes without a touch, as on the web.

Each tap is logged over serial as `Tap x,y`.

## Text and smooth drawing

Text uses **IBM Plex Sans Thai** (SIL OFL 1.1; `fonts/` holds the TTFs and
`OFL.txt`). It is pre-rendered by `tools/make_fonts.py` into 4-bit
anti-aliased bitmaps at the sizes the board uses, written to the generated
`src/aa_fonts.h` (about 66 KB). The sizes are 11 px semibold caps, 12 px,
15 px body, 17 px and 22 px semibold, and 30 px numbers.

To regenerate after changing sizes or characters, run this with any Python
that has Pillow 11:

```sh
python tools/make_fonts.py fonts src/aa_fonts.h
```

The firmware blends each glyph's edge into the framebuffer, so text is smooth
on any background.

**Thai marks.** Thai vowels above and below, and tone marks, have zero advance
and sit left of the pen, so they land on the letter before them. Two
measured fixes stand in for the font's OpenType rules, which the panel doesn't
run:
- a tone mark after an upper vowel is lifted clear of it (นั่ง, ที่);
- marks on ป ฝ ฟ ฬ shift left just enough to clear the tail (ปิ่น, ฟ้า).

**Other scripts.** Characters outside Latin and Thai fall back to the
hard-edged 16 px Unifont bundled with Arduino_GFX. That font is why U8g2 and
`-DU8G2_USE_LARGE_FONTS` remain.

**Shapes.** Rounded rectangles, circles and the donut (including the gaps
between slices) are drawn with per-pixel coverage, so their edges are soft.

## Brightness

The backlight is PWM on GPIO 2 at 300 Hz. The percentage goes through a 2.2
gamma curve, because eyes judge brightness logarithmically: a linear 60% duty
looks almost the same as 100%.

## Serial commands

At 115200 baud, mainly for testing without touching the panel:
- `S` sends a screenshot (see below).
- `K`, `H` switch to the Kaizen and Hotel boards. `T` opens settings; `1`-`5`
  pick a tab and `N` toggles night dim.
- `L` toggles the language.
- `D` opens the Total list, `E` expands its first case, `X` closes the list.
- `@x,y` followed by a newline taps at x,y, for testing flows such as the keyboard.

## Screenshot of the panel

`tools/esp_shot.py` resets the board, waits for its first successful fetch,
sends `S` over serial and saves the framebuffer as a PNG. It takes about 50 s.

```sh
"$HOME/.local/share/uv/tools/platformio/bin/python" tools/esp_shot.py nnr_esp.png
```

Use it to compare the layout with `/display` (the `nnrdsp` preview) after
changing the firmware.

## Wi-Fi

**Remembered networks.** System Settings > Network lists the networks in
range, each with signal bars, a lock if it is secured and "Saved" if it is
remembered.
- Tap a network to join it. Secured ones open an on-screen keyboard (letters,
  numbers, symbols, shift and caps lock, Show/Hide).
- A network that joins successfully is remembered in NVS (namespace `wifi`, up
  to 6, most recent first). **Forget** removes the current one.
- On start, and whenever the link drops for 45 s, the panel scans and joins the
  strongest remembered network. It pins that network's strongest access
  point, because the ESP32 doesn't roam by itself. While the signal is weak
  (below −78 dBm) it checks every 5 minutes for an access point at least 8 dB
  stronger.
- The network in `device_config.h` only seeds the list on first start and after
  a factory reset. After that, change Wi-Fi on the panel; `configure_wifi.sh`
  matters only for a freshly flashed or reset panel.
- Wi-Fi power-saving is off, settings don't go into the Wi-Fi driver's own
  NVS, and SNTP restarts whenever the link comes up.

**Sign-in pages (captive portals).** After joining, the panel fetches
`http://connectivitycheck.gstatic.com/generate_204`, the way phones detect
portals. HTTP 204 means online; a redirect or a page means a sign-in page is in
the way.
- Network then shows **Sign in**. You type the portal's username and password
  (either can be empty, for "accept terms" pages).
- The panel loads the portal, follows redirects (HTTP, meta refresh, JS
  location), finds the login form and fills it in. It keeps the page's hidden
  fields and ticks its checkboxes, submits the form, and checks again.
- Details that work are remembered per network, so the panel signs in again
  by itself on reconnect.
- Portals that need JavaScript to log in can't be done this way. For those,
  Network shows the panel's MAC address so IT can allow it on the network. For
  a hotel's own network that is the dependable option anyway.
- Portal pages are fetched with certificate checks off (they often use
  self-signed certificates). Only portal traffic goes that way; Kaizen data
  always uses the pinned roots.

**Stored secrets.** Wi-Fi and portal passwords sit in NVS unencrypted (the
ESP32's default) and are never printed to serial.

## Drawing and refresh

Everything is drawn off-screen into a PSRAM buffer, and only rows that changed
are copied to the LCD buffer, so the screen never shows a half-drawn frame.
The minute data refresh cross-fades the changed pixels over about 0.3 s
instead of repainting in view. Taps switch instantly.

## Known limits

- The built-in font is ASCII only, so Thai case titles are not shown.
- The web board's Needs Attention badge counts at most three rows; the panel
  mirrors that.
