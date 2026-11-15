# Na Nirand Kaizen wall panel (ESP32)

Native firmware that redraws the Kaizen board of `/display`
(`src/pages/DisplayPage.tsx`) on a GUITION JC8048W550: ESP32-S3, 800 × 480 RGB
LCD, 16 MB flash, 8 MB PSRAM. It polls once a minute over Wi-Fi and has no
touch controls. The Hotel board and touch drill-down are not built yet.

The numbers come from the `kaizen-esp-display` edge function
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

If you change a metric rule in `DisplayPage.tsx` or `src/lib/utils.ts`, change
the function too. Its comments mark each rule it mirrors.

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

Serial output (115200 baud) prints `Wi-Fi ok, RSSI …` on each poll and
`Dashboard fetch failed (HTTP n)` on errors. On screen, the bottom line reads
`Live | Refreshes every minute`. After three missed polls the header shows
`STALE`.

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
