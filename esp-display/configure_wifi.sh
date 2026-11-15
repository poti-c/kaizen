#!/usr/bin/env bash
# Writes the Wi-Fi network name and password into include/device_config.h
# (gitignored, mode 600). The password is read without echo and handed to the
# writer on stdin, so it never appears on screen, in shell history or in `ps`.
set -euo pipefail
cd "$(dirname "$0")"
CFG=include/device_config.h
[ -f "$CFG" ] || { echo "Missing $CFG — create it first (see README)." >&2; exit 1; }

echo "The ESP32-S3 joins 2.4 GHz networks only."
read -r -p "Wi-Fi network name (SSID): " ssid
read -r -s -p "Wi-Fi password (typing is hidden): " pass; echo
[ -n "$ssid" ] || { echo "SSID is empty; nothing changed." >&2; exit 1; }

printf '%s\0%s' "$ssid" "$pass" | python3 -I -c '
import os, re, sys
ssid, pw = sys.stdin.buffer.read().split(b"\0", 1)
def c_str(s):
    return "\"" + "".join(chr(b) if (chr(b).isalnum() or b == 32) and b < 128 else "\\%03o" % b for b in s) + "\""
path = sys.argv[1]
text = open(path).read()
for name, value in (("WIFI_SSID", ssid), ("WIFI_PASSWORD", pw)):
    text, n = re.subn(r"^constexpr char %s\[\] = .*;$" % name,
                      lambda m: "constexpr char %s[] = %s;" % (name, c_str(value)), text, count=1, flags=re.M)
    if n != 1: sys.exit("could not find %s in %s" % (name, path))
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: f.write(text)
os.replace(tmp, path)
' "$CFG"
unset pass
echo "Saved Wi-Fi settings for \"$ssid\" to $CFG. You can close this tab."
