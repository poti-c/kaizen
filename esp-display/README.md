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

- **Bottom row:** Kaizen System, Hotel and System Settings switch boards. Any
  board other than Kaizen returns to it after 2 minutes without a touch.
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
- **System Settings:**
  - Brightness −/+ in 10% steps.
  - Language: English / ไทย.
  - Data source, last update, Wi-Fi, IP, MAC, uptime, free memory and firmware
    date.
  - Brightness and language are saved in NVS and kept after a restart.

Each tap is logged over serial as `Tap x,y`.

## Thai and other languages

The built-in 6x8 font is ASCII only. Any label containing non-ASCII text is
drawn in the 16 px Unifont that ships with Arduino_GFX, which covers Thai and
most of Unicode.
- **Why U8g2:** the `olikraus/U8g2` dependency is there only so Arduino_GFX
  enables UTF-8 text.
- **Build flag:** `-DU8G2_USE_LARGE_FONTS` includes the font, about 2.2 MB of
  flash.
- **Thai shaping:** above and below vowels and tone marks are separate code
  points. The firmware draws them over the preceding letter's cell, and lifts a
  tone mark 3 px when it follows an upper vowel (นั่ง), so the two don't collide.
- **Labels:** English and Thai labels are the web app's own strings.
- **Case content:** case titles, descriptions and names are shown as entered.

## Brightness

The backlight is PWM on GPIO 2 at 300 Hz. The percentage goes through a 2.2
gamma curve, because eyes judge brightness logarithmically: a linear 60% duty
looks almost the same as 100%.

## Serial commands

At 115200 baud, mainly for testing without touching the panel:
- `S` sends a screenshot (see below).
- `K`, `H`, `T` switch to the Kaizen, Hotel and settings screens.
- `L` toggles the language.
- `D` opens the Total list, `E` expands its first case, `X` closes the list.

## Screenshot of the panel

`tools/esp_shot.py` resets the board, waits for its first successful fetch,
sends `S` over serial and saves the framebuffer as a PNG. It takes about 50 s.

```sh
"$HOME/.local/share/uv/tools/platformio/bin/python" tools/esp_shot.py nnr_esp.png
```

Use it to compare the layout with `/display` (the `nnrdsp` preview) after
changing the firmware.

## Wi-Fi behaviour

"Qhouse Main_2.4G" is served by two access points on channel 6. Left alone,
the ESP32 joined the far one (about −76 to −95 dBm) and never moved, so the
firmware now:
- scans at boot and joins the strongest access point by its MAC address
  (BSSID);
- rescans if the link stays down for 45 s;
- checks every 5 minutes, when the signal is below −78 dBm, for another
  access point at least 8 dB stronger;
- keeps Wi-Fi power-saving off;
- does not store Wi-Fi settings in flash;
- restarts the clock sync (SNTP) each time Wi-Fi connects.

## Flash backup

The factory flash image (`guition-backup-*.bin`, 16 MB) lives beside this README
and is gitignored. To restore the original firmware:

```sh
uvx --from 'esptool==4.13.0' esptool.py --port /dev/cu.usbserial-10 write_flash 0 guition-backup-20261115-173022.bin
```

## Known limits

- The built-in font is ASCII only, so Thai case titles are not shown.
- The web board's Needs Attention badge counts at most three rows; the panel
  mirrors that.
