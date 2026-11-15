# esp_shot.py OUT.png [--reset] — wait for a live fetch, then pull the nnr_esp framebuffer.
import serial, struct, sys, time, zlib
out = sys.argv[1]
s = serial.Serial(); s.port = "/dev/cu.usbserial-10"; s.baudrate = 115200; s.timeout = 1
s.dtr = False; s.rts = False; s.open()
s.rts = True; time.sleep(0.1); s.rts = False          # reset so the run is reproducible
t0 = time.time()
while time.time() - t0 < 90:
    line = s.readline().decode(errors="replace").strip()
    if line and not line.startswith(("ESP-ROM", "Build:", "rst:", "SPIWP", "mode:", "load:", "entry")):
        print("%5.1fs  %s" % (time.time() - t0, line))
    if "fetch ok" in line:
        break
else:
    sys.exit("no successful fetch within 90 s")
time.sleep(1.0); s.reset_input_buffer(); s.write(b"S"); s.timeout = 30
buf = b""
while b"KZSHOT" not in buf:
    chunk = s.read(64)
    if not chunk: sys.exit("no screenshot header")
    buf += chunk
data = buf[buf.index(b"KZSHOT") + 6:]
def need(n):
    global data
    while len(data) < n:
        chunk = s.read(65536)
        if not chunk: sys.exit("screenshot truncated")
        data += chunk
need(4); w, h = struct.unpack("<HH", data[:4]); data = data[4:]
px = bytearray(); total = w * h; got = 0
while True:
    need(4); run, c = struct.unpack("<HH", data[:4]); data = data[4:]
    if run == 0: break
    r = (c >> 11) & 31; g = (c >> 5) & 63; b = c & 31
    px += bytes(((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))) * run
    got += run
s.close()
assert got == total, (got, total)
raw = b"".join(b"\0" + bytes(px[y * w * 3:(y + 1) * w * 3]) for y in range(h))
def chunk(tag, body): return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
open(out, "wb").write(png); print("saved %dx%d to %s (%.1fs)" % (w, h, out, time.time() - t0))
