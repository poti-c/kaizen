#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp32s3/rom/cache.h>

#include "aa_fonts.h"

#if __has_include("device_config.h")
#include "device_config.h"
#else
#include "device_config.example.h"
#endif

// nnr_esp: the Kaizen and Hotel boards of /display (src/pages/DisplayPage.tsx,
// src/components/HotelBoard.tsx), redrawn natively for an 800x480 panel. Data
// comes from the kaizen-esp-display edge function, which computes the same
// numbers the web board does; this file only draws them.

// Guition JC8048W550 RGB wiring and timings from the Arduino_GFX board example.
Arduino_ESP32RGBPanel panel(
    40, 41, 39, 42, 45, 48, 47, 21, 14, 5, 6, 7, 15, 16, 4,
    8, 3, 46, 9, 1, 0, 8, 4, 8, 0, 8, 4, 8, 1, 16000000);
Arduino_RGB_Display screen(800, 480, &panel);
constexpr int BACKLIGHT = 2;
constexpr uint32_t RETRY_MS = 15000;

// PANEL colours (src/lib/panelTheme.ts) in RGB565.
constexpr uint16_t rgb(uint32_t hex) {
    return ((hex >> 8) & 0xF800) | ((hex >> 5) & 0x07E0) | ((hex >> 3) & 0x001F);
}
constexpr uint16_t BG = rgb(0x0b1220);
constexpr uint16_t CARD = rgb(0x141d2e);
constexpr uint16_t BORDER = rgb(0x1f2838);     // rgba(255,255,255,0.08) on CARD
constexpr uint16_t ROW = rgb(0x1b2434);        // rgba(255,255,255,0.03) on CARD
constexpr uint16_t ROW_BG = rgb(0x141b28);     // rgba(255,255,255,0.04) on BG
constexpr uint16_t TRACK = rgb(0x20293a);      // rgba(255,255,255,0.06) on CARD
constexpr uint16_t BAR_PAST = rgb(0x39404d);   // rgba(255,255,255,0.16) on CARD
constexpr uint16_t TEXT = rgb(0xe8edf3);
constexpr uint16_t MUTED = rgb(0x8b98ab);
constexpr uint16_t C_OPEN = rgb(0xf97316);
constexpr uint16_t C_PROGRESS = rgb(0x3b82f6);
constexpr uint16_t C_PENDING = rgb(0xf59e0b);
constexpr uint16_t C_RESOLVED = rgb(0x22c55e);
constexpr uint16_t C_CRITICAL = rgb(0xef4444);
constexpr uint16_t C_ASSIGNED = rgb(0xa855f7);
constexpr uint16_t C_GREY = rgb(0x6b7280);
constexpr uint16_t BRAND = rgb(0x0891b2);      // Na Nirand primary_color

uint16_t blend(uint16_t fg, uint16_t bg, uint8_t alpha) {  // alpha 0..255 of fg over bg
    auto ch = [&](int shift, int mask) {
        const int f = (fg >> shift) & mask, b = (bg >> shift) & mask;
        return ((f * alpha + b * (255 - alpha)) / 255) & mask;
    };
    return (ch(11, 31) << 11) | (ch(5, 63) << 5) | ch(0, 31);
}

// ── Language ─────────────────────────────────────────────────────────────────
// English or Thai labels, chosen in System Settings and kept in NVS. Strings
// are the web app's own (LanguageContext.tsx, DisplayPage.tsx, HotelBoard.tsx).
bool thai = false;
const char *L(const char *en, const char *th) { return thai ? th : en; }

// ── State ────────────────────────────────────────────────────────────────────
struct Metric {
    const char *key, *drillKey, *en, *th;
    uint16_t color;
};
constexpr Metric METRICS[] = {
    {"total", "total", "TOTAL CASES", "เคสทั้งหมด", TEXT},
    {"open", "open", "OPEN", "เปิดอยู่", C_OPEN},
    {"inProgress", "inProgress", "IN PROGRESS", "กำลังดำเนินการ", C_PROGRESS},
    {"pending", "pending", "WAITING APPROVAL", "รอการอนุมัติ", C_PENDING},
    {"closed", "resolved", "RESOLVED", "แก้ไขแล้ว", C_RESOLVED},
    {"overdue", "overdue", "OVERDUE", "เกินกำหนด", C_CRITICAL},
};
constexpr size_t METRIC_COUNT = sizeof(METRICS) / sizeof(METRICS[0]);
int values[METRIC_COUNT];
JsonDocument details;
bool hasData = false;
uint32_t lastSuccess = 0;
enum class Status { Connecting, Unconfigured, Live, Stale, NoWifi, NoClock, Unavailable };
Status status = Status::Connecting;
uint32_t nextPoll = 0;

// Which board is on screen. Kaizen is home; Hotel times out back to it.
enum class Screen { Kaizen, Hotel };
Screen current = Screen::Kaizen;
uint32_t lastTouch = 0;
Preferences prefs;

// Panel settings, as in src/lib/panelTheme.ts (same defaults), kept in NVS.
struct PanelSettings {
    int brightness = 100;
    bool nightDim = false;
    int nightFrom = 22 * 60, nightTo = 6 * 60;  // minutes after midnight, Bangkok time
    int nightLevel = 35;
    bool rotated = false;                       // orientation 180°
    int refreshSecs = 60;
    int idleSecs = 30;
    bool touch = true;                          // touch drill-down
} cfg;
uint32_t pollMs() { return cfg.refreshSecs * 1000UL; }
uint32_t drillIdleMs() { return cfg.idleSecs * 1000UL; }

// ── Text: built-in 6x8 font for ASCII, Unifont 16 px for everything else ─────
// The built-in font has no Thai. Unifont does, but Thai above/below vowels
// and tone marks are separate code points that must sit on the previous
// letter, so they are drawn at the base letter's position instead of advancing.
bool isAscii(const char *s) {
    for (; *s; ++s)
        if (static_cast<uint8_t>(*s) >= 0x80) return false;
    return true;
}
uint32_t nextCp(const char *&s) {
    const uint8_t c = *s++;
    if (c < 0x80) return c;
    int extra = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : 0;
    uint32_t cp = c & (0x3F >> extra);
    while (extra-- > 0 && (static_cast<uint8_t>(*s) & 0xC0) == 0x80) cp = (cp << 6) | (*s++ & 0x3F);
    return cp;
}
bool thaiMark(uint32_t cp) {
    return cp == 0x0E31 || (cp >= 0x0E34 && cp <= 0x0E3A) || (cp >= 0x0E47 && cp <= 0x0E4E);
}
bool thaiUpperVowel(uint32_t cp) { return cp == 0x0E31 || (cp >= 0x0E34 && cp <= 0x0E37) || cp == 0x0E47; }
bool thaiTone(uint32_t cp) { return cp >= 0x0E48 && cp <= 0x0E4C; }
int cpWidth(uint32_t cp) {
    if (thaiMark(cp) || cp == '\n') return 0;
    const bool wide = (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) ||
                      (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
                      (cp >= 0xFF00 && cp <= 0xFF60);
    return wide ? 16 : 8;
}
// ── Anti-aliased text and shapes ─────────────────────────────────────────────
// Text is drawn from IBM Plex Sans Thai, pre-rendered at each size by
// tools/make_fonts.py into 4-bit coverage (src/aa_fonts.h). Each glyph's soft
// edge is blended into the framebuffer over whatever is already there, so text
// is smooth on any background. Characters outside Latin and Thai fall back to
// the hard-edged Unifont. Shapes get the same treatment below.
uint16_t *fb = nullptr;      // the panel's framebuffer, set in setup()
bool rotated180 = false;     // Orientation 180°: framebuffer is drawn upside down
inline uint16_t *fbAt(int x, int y) {
    return rotated180 ? fb + (479 - y) * 800 + (799 - x) : fb + y * 800 + x;
}
// The LCD reads the framebuffer from PSRAM; push our CPU-cache writes out to it.
void flushRows(int y0, int y1) {
    y0 = max(0, y0);
    y1 = min(479, y1);
    if (!fb || y1 < y0) return;
    const int r0 = rotated180 ? 479 - y1 : y0, r1 = rotated180 ? 479 - y0 : y1;
    Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(fb + r0 * 800), (r1 - r0 + 1) * 800 * 2);
}
inline void blendPx(int x, int y, uint16_t color, int alpha) {  // alpha 0..255
    if (x < 0 || x >= 800 || y < 0 || y >= 480 || alpha <= 0) return;
    uint16_t *p = fbAt(x, y);
    *p = alpha >= 255 ? color : blend(color, *p, alpha);
}

const AAGlyph *findGlyph(const AAFont &f, uint32_t cp) {
    int lo = 0, hi = f.count - 1;
    while (lo <= hi) {
        const int mid = (lo + hi) / 2;
        if (f.glyphs[mid].cp == cp) return &f.glyphs[mid];
        if (f.glyphs[mid].cp < cp) lo = mid + 1;
        else hi = mid - 1;
    }
    return nullptr;
}
void drawGlyph(const AAFont &f, const AAGlyph &g, int penX, int baseline, uint16_t color) {
    if (!fb) return;
    const uint8_t *bits = f.bits + g.offset;
    const int x0 = penX + g.x, y0 = baseline + g.y;
    for (int r = 0; r < g.h; ++r) {
        for (int c = 0; c < g.w; ++c) {
            const int i = r * g.w + c;
            const int a = (bits[i >> 1] >> ((i & 1) ? 0 : 4)) & 15;
            if (a) blendPx(x0 + c, y0 + r, color, a * 17);
        }
    }
    flushRows(y0, y0 + g.h - 1);
}
// Characters the Plex fonts lack: draw them from Unifont, hard-edged.
void unifontGlyph(int x, int baseline, const char *from, const char *to, uint16_t color) {
    char buf[5];
    const size_t n = min<size_t>(to - from, 4);
    memcpy(buf, from, n);
    buf[n] = 0;
    screen.setFont(u8g2_font_unifont_h_utf8);
    screen.setUTF8Print(true);
    screen.setTextSize(1);
    screen.setTextColor(color);
    screen.setCursor(x, baseline + 2);
    screen.print(buf);
    screen.setUTF8Print(false);
    screen.setFont(static_cast<const GFXfont *>(nullptr));
}
bool thaiTall(uint32_t cp) { return cp == 0x0E1B || cp == 0x0E1D || cp == 0x0E1F || cp == 0x0E2C; }
bool thaiLower(uint32_t cp) { return cp >= 0x0E38 && cp <= 0x0E3A; }

// Draws (or, with draw=false, measures) one line; clips with an ellipsis at
// maxW. Thai marks have zero advance and sit left of the pen, so they land on
// the letter before them. Two fixes stand in for the font's OpenType rules:
// a tone mark after an upper vowel is lifted clear of it, and marks on ป ฝ ฟ ฬ
// move left just enough to clear the tail.
int aaText(const AAFont &f, int x, int baseline, const char *s, uint16_t color, int maxW = 100000, bool draw = true) {
    static const char ELLIPSIS[] = "\xE2\x80\xA6";
    const AAGlyph *ell = findGlyph(f, 0x2026);
    const int ellW = ell ? (ell->adv16 + 15) / 16 : 8;
    bool clip = false;
    if (maxW < 100000) clip = aaText(f, 0, 0, s, color, 100000, false) > maxW;
    int pen16 = x * 16;
    uint32_t prev = 0, base = 0;
    while (*s) {
        const char *from = s;
        const uint32_t cp = nextCp(s);
        if (cp == '\n') continue;
        const AAGlyph *g = findGlyph(f, cp);
        if (!g) {  // not in the font
            const int w = cpWidth(cp);
            if (clip && (pen16 + w * 16) / 16 > x + maxW - ellW) break;
            if (draw && w) unifontGlyph((pen16 + 8) / 16, baseline, from, s, color);
            pen16 += w * 16;
            prev = base = cp;
            continue;
        }
        if (g->adv16 == 0) {  // combining mark
            if (draw && g->w) {
                int dx = 0, dy = 0;
                if (thaiTone(cp) && thaiUpperVowel(prev)) dy = -f.toneLift;
                const int right = g->x + g->w - 1;
                if (thaiTall(base) && !thaiLower(cp) && right >= f.tailX) dx = f.tailX - 1 - right;
                drawGlyph(f, *g, (pen16 + 8) / 16 + dx, baseline + dy, color);
            }
            prev = cp;
            continue;
        }
        if (clip && (pen16 + g->adv16 + 15) / 16 > x + maxW - ellW) {
            if (draw && ell) drawGlyph(f, *ell, (pen16 + 8) / 16, baseline, color);
            pen16 += ellW * 16;
            break;
        }
        if (draw) drawGlyph(f, *g, (pen16 + 8) / 16, baseline, color);
        pen16 += g->adv16;
        prev = base = cp;
    }
    (void)ELLIPSIS;
    return (pen16 + 15) / 16 - x;
}
int advPx(const AAFont &f, uint32_t cp) {
    const AAGlyph *g = findGlyph(f, cp);
    return g ? (g->adv16 + 8) / 16 : cpWidth(cp);
}

// Text sizes, standing in for the old 6x8 font at 1x..4x. Size 0 is the small
// semibold used for uppercase panel titles and tile labels, as on the web.
const AAFont &fontFor(int size) {
    switch (size) {
        case 0: return caps11;
        case 1: return text12;
        case 2: return title17;
        case 3: return head22;
        default: return num30;
    }
}
// Body text (what Unifont used to draw): 15 px.
int uwidth(const char *s) { return aaText(body15, 0, 0, s, 0, 100000, false); }
// One line of body text with its 16 px line box starting at `top`.
int utext(int x, int top, const char *s, uint16_t color, int maxW = 100000) {
    return aaText(body15, x, top + 8 + body15.capHeight / 2, s, color, maxW);
}

// Shapes with soft edges: coverage from the distance to the curve.
inline int coverage(float inside) {  // signed px inside the edge -> 0..255
    return inside <= -0.5f ? 0 : inside >= 0.5f ? 255 : static_cast<int>((inside + 0.5f) * 255);
}
void aaRoundRect(int x, int y, int w, int h, int r, uint16_t color) {
    if (w <= 0 || h <= 0) return;
    r = max(0, min(r, min(w, h) / 2));
    if (r < 2 || !fb) { screen.fillRect(x, y, w, h, color); return; }
    screen.fillRect(x + r, y, w - 2 * r, h, color);
    screen.fillRect(x, y + r, r, h - 2 * r, color);
    screen.fillRect(x + w - r, y + r, r, h - 2 * r, color);
    // corners: circle of radius r centred r px in from each corner
    for (int dy = 0; dy < r; ++dy) {
        for (int dx = 0; dx < r; ++dx) {
            const float fx = r - dx - 0.5f, fy = r - dy - 0.5f;
            const int a = coverage(r - sqrtf(fx * fx + fy * fy));
            if (!a) continue;
            blendPx(x + dx, y + dy, color, a);
            blendPx(x + w - 1 - dx, y + dy, color, a);
            blendPx(x + dx, y + h - 1 - dy, color, a);
            blendPx(x + w - 1 - dx, y + h - 1 - dy, color, a);
        }
    }
    flushRows(y, y + r);
    flushRows(y + h - r, y + h - 1);
}
void aaCircle(int cx, int cy, int r, uint16_t color) {
    if (!fb) { screen.fillCircle(cx, cy, r, color); return; }
    const float R = r + 0.5f;
    for (int dy = -r - 1; dy <= r + 1; ++dy) {
        for (int dx = -r - 1; dx <= r + 1; ++dx) {
            blendPx(cx + dx, cy + dy, color, coverage(R - sqrtf(static_cast<float>(dx * dx + dy * dy))));
        }
    }
    flushRows(cy - r - 1, cy + r + 1);
}

// Word-wraps (or breaks between letters, for Thai, which has no spaces) into at
// most maxLines lines of lineH. With draw=false it only counts the lines.
int uwrap(int x, int top, const char *s, uint16_t color, int maxW, int lineH, int maxLines, bool draw = true) {
    char buf[600];
    int lines = 0;
    while (*s && lines < maxLines) {
        const char *p = s, *cut = s, *space = nullptr;
        int w = 0;
        bool newline = false;
        while (*p) {
            const char *q = p;
            const uint32_t cp = nextCp(q);
            if (cp == '\n') { cut = p; newline = true; break; }
            const int cw = thaiMark(cp) ? 0 : advPx(body15, cp);
            if (cw && w + cw > maxW) break;
            w += cw;
            if (cp == ' ') space = q;
            p = q;
            cut = p;
        }
        if (*p && !newline && space && space > s) cut = space;
        if (cut == s && !newline) nextCp(cut);  // always make progress
        const bool last = lines == maxLines - 1 && *cut;
        const char *end = last ? s + strlen(s) : cut;
        const size_t n = min<size_t>(end - s, sizeof(buf) - 1);
        memcpy(buf, s, n);
        buf[n] = 0;
        if (last)
            for (char *c = buf; *c; ++c)
                if (*c == '\n') *c = ' ';
        if (draw) utext(x, top + lines * lineH, buf, color, maxW);
        ++lines;
        s = cut;
        while (*s == ' ' || *s == '\n') ++s;
    }
    return lines;
}

int textWidth(const char *s, int size) { return aaText(fontFor(size), 0, 0, s, 0, 100000, false); }
// `y` is the top of the old 8*size px text box; the text is centred in it, so
// every existing layout position still lines up.
void label(int x, int y, const char *text, int size, uint16_t color) {
    const AAFont &f = fontFor(size);
    const int box = 8 * max(1, size);
    aaText(f, x, y + box / 2 + f.capHeight / 2, text, color);
}
void labelRight(int right, int y, const char *text, int size, uint16_t color) {
    label(right - textWidth(text, size), y, text, size, color);
}
void labelCenter(int cx, int y, const char *text, int size, uint16_t color) {
    label(cx - textWidth(text, size) / 2, y, text, size, color);
}
// Copies printable text, keeping UTF-8 (the fonts draw it) but dropping control
// characters, capped at maxBytes.
void copyText(char *out, size_t cap, const char *in, size_t maxBytes = 1000) {
    size_t n = 0;
    for (; in && *in && n + 1 < cap && n < maxBytes; ++in)
        if (static_cast<uint8_t>(*in) >= 0x20) out[n++] = *in;
    // If the cap cut a multi-byte character in half, drop the partial one.
    size_t lead = n;
    while (lead > 0 && n - lead < 3 && (static_cast<uint8_t>(out[lead - 1]) & 0xC0) == 0x80) --lead;
    if (lead > 0) {
        const uint8_t c = out[lead - 1];
        const size_t need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
        if (n - (lead - 1) < need) n = lead - 1;
    }
    out[n] = 0;
}
// English labels are uppercase on the web board (CSS); Thai has no case.
void upper(char *out, size_t cap, const char *in) {
    copyText(out, cap, in);
    if (isAscii(out))
        for (char *c = out; *c; ++c) *c = toupper(*c);
}
uint16_t parseColor(const char *hex, uint16_t fallback) {
    if (!hex || hex[0] != '#' || strlen(hex) != 7) return fallback;
    return rgb(strtoul(hex + 1, nullptr, 16));
}
// Small rounded tag; returns its width.
int pill(int x, int y, const char *text, uint16_t fg, uint16_t bg, int h = 18, int size = 1) {
    const int w = textWidth(text, size) + 12;
    aaRoundRect(x, y, w, h, 4, bg);
    label(x + 6, y + (h - 8) / 2, text, size, fg);
    return w;
}
const char *pick(JsonObjectConst o, const char *en, const char *th) {
    const char *v = thai ? (o[th] | static_cast<const char *>(nullptr)) : nullptr;
    return v ? v : (o[en] | "");
}

void card(int x, int y, int w, int h) {
    aaRoundRect(x, y, w, h, 9, BORDER);
    aaRoundRect(x + 1, y + 1, w - 2, h - 2, 8, CARD);
}
void panelBox(int x, int y, int w, int h, const char *title) {
    card(x, y, w, h);
    label(x + 10, y + 10, title, 0, MUTED);
}

// ── Layout (1024x600 web canvas scaled ~0.78 to 800x480) ──────────────────────
constexpr int PAD = 12, GAP = 10;
constexpr int HEADER_H = 50;
constexpr int KPI_Y = 56, KPI_H = 64;
constexpr int ROW_A_Y = 128, ROW_A_H = 148;
constexpr int ROW_B_Y = 284, ROW_B_H = 112;
constexpr int SWITCH_Y = 404, SWITCH_H = 40;
constexpr int RIGHT_W = 300;
constexpr int LEFT_W = 800 - 2 * PAD - GAP - RIGHT_W;
constexpr int RIGHT_X = PAD + LEFT_W + GAP;
constexpr int KPI_W = (800 - 2 * PAD - 5 * GAP) / 6;

struct Rect {
    int x, y, w, h;
    bool in(int px, int py) const { return px >= x && px < x + w && py >= y && py < y + h; }
    // Accept taps up to 10 px outside small buttons; fingers miss small targets.
    bool hit(int px, int py) const { return px >= x - 10 && px < x + w + 10 && py >= y - 10 && py < y + h + 10; }
};

// ── Header ────────────────────────────────────────────────────────────────────
void drawHeader() {
    screen.fillRect(0, 0, 800, HEADER_H + 2, BG);
    char title[64] = "Kaizen";
    if (hasData) copyText(title, sizeof(title), details["title"] | "Kaizen", 60);
    label(PAD, 10, title, 3, TEXT);
    int bx = PAD + textWidth(title, 3) + 10;
    bx += pill(bx, 11, L("DASHBOARD", "แดชบอร์ด"), TEXT, BRAND, 17, 0) + 6;
    if (hasData && millis() - lastSuccess > 3 * pollMs()) {
        bx += pill(bx, 11, L("STALE", "ข้อมูลค้าง"), C_PENDING, rgb(0x3a2e17), 17, 0) + 6;
    }

    char subtitle[160] = "Kaizen System";
    if (hasData) {
        char month[16], avg[16];
        copyText(month, sizeof(month), details["month"] | "", 12);
        copyText(avg, sizeof(avg), details["avgResolution"] | "-", 12);
        if (current == Screen::Hotel) {
            // The hotel figures come from the last uploaded report, which can
            // be days behind: say which day, and flag it when it is old.
            JsonObjectConst hotel = details["hotel"].as<JsonObjectConst>();
            const char *date = hotel["statDateLabel"] | "";
            if (date[0]) {
                snprintf(subtitle, sizeof(subtitle), "%s  |  %s  |  %s %s", month,
                         L("Hotel performance", "ผลประกอบการโรงแรม"), L("Figures for", "ข้อมูลวันที่"), date);
            } else {
                snprintf(subtitle, sizeof(subtitle), "%s  |  %s", month, L("Hotel performance", "ผลประกอบการโรงแรม"));
            }
            const int age = hotel["ageDays"] | 0;
            if (age >= 2) {
                char tag[96];
                snprintf(tag, sizeof(tag), thai ? "ข้อมูล %d วันที่แล้ว" : "%d DAYS OLD", age);
                pill(bx, 11, tag, C_PENDING, rgb(0x3a2e17), 17, 0);
            }
        } else {
            snprintf(subtitle, sizeof(subtitle), "%s  |  %s %s  |  %s %d%%", month,
                     L("Avg Resolution", "เวลาแก้ไขเฉลี่ย"), avg, L("Resolution Rate", "อัตราการแก้ไข"),
                     details["resolutionRate"].as<int>());
        }
    }
    label(PAD, 38, subtitle, 1, MUTED);

    const time_t now = time(nullptr);
    if (now > 1700000000) {
        const time_t bangkok = now + 7 * 3600;
        struct tm local;
        gmtime_r(&bangkok, &local);
        char clock[8], date[20];
        strftime(clock, sizeof(clock), "%H:%M", &local);
        strftime(date, sizeof(date), "%a %d %b", &local);
        labelRight(800 - PAD, 8, clock, 3, TEXT);
        labelRight(800 - PAD, 38, date, 1, MUTED);
    }
}

// ── Kaizen board ──────────────────────────────────────────────────────────────
Rect kpiRect(int i) { return {PAD + i * (KPI_W + GAP), KPI_Y, KPI_W, KPI_H}; }

void drawKpis() {
    for (size_t i = 0; i < METRIC_COUNT; ++i) {
        const Rect r = kpiRect(i);
        card(r.x, r.y, r.w, r.h);
        char number[16] = "--";
        if (hasData) snprintf(number, sizeof(number), "%d", values[i]);
        label(r.x + 10, r.y + 10, number, strlen(number) <= 4 ? 4 : 3, METRICS[i].color);
        label(r.x + 10, r.y + 48, L(METRICS[i].en, METRICS[i].th), 0, MUTED);
    }
}

void drawTrend() {
    const int x = PAD, y = ROW_A_Y, w = LEFT_W, h = ROW_A_H;
    panelBox(x, y, w, h, L("MONTHLY CASES", "เคสรายเดือน"));
    JsonArrayConst months = details["monthly"].as<JsonArrayConst>();
    if (months.isNull() || months.size() != 9) {
        labelCenter(x + w / 2, y + h / 2, L("Waiting for case history", "กำลังรอข้อมูล"), 1, MUTED);
        return;
    }
    int maximum = 1;
    for (JsonObjectConst m : months) maximum = max(maximum, m["count"].as<int>());
    const int base = y + h - 22;            // bar baseline
    const int area = h - 22 - 44;           // room for value labels above the tallest bar
    const int slot = (w - 20) / 9;
    const int barW = slot * 3 / 5;
    for (int i = 0; i < 9; ++i) {
        const int bx = x + 10 + i * slot + (slot - barW) / 2;
        const int count = months[i]["count"].as<int>();
        const int bh = static_cast<int>(static_cast<int64_t>(area) * count / maximum);
        if (bh > 0) aaRoundRect(bx, base - bh, barW, bh, min(3, bh / 2), i == 8 ? BRAND : BAR_PAST);
        char value[12];
        snprintf(value, sizeof(value), "%d", count);
        labelCenter(bx + barW / 2, base - bh - 11, value, 1, TEXT);
        char name[8];
        copyText(name, sizeof(name), months[i]["month"] | "", 3);
        labelCenter(bx + barW / 2, base + 7, name, 1, MUTED);
    }
}

// Donut drawn per pixel so the ring has no spokes; slices run clockwise from
// 12 o'clock with a 3 degree gap between them, like the Recharts Pie.
void drawDonut(int cx, int cy, int outer, int inner, const int *counts, const uint16_t *colors, int n) {
    int total = 0, slices = 0;
    for (int i = 0; i < n; ++i) { total += counts[i]; slices += counts[i] > 0; }
    if (total == 0) {
        aaCircle(cx, cy, outer, TRACK);
        aaCircle(cx, cy, inner, CARD);
        return;
    }
    const float gap = slices > 1 ? 3.0f : 0.0f;
    const float usable = 360.0f - gap * slices;
    float start[8], end[8];
    float a = 0;
    for (int i = 0; i < n; ++i) {
        start[i] = a;
        end[i] = a + usable * counts[i] / total;
        a = end[i] + (counts[i] > 0 ? gap : 0);
    }
    // Coverage = inside the ring (radially) x inside the slice (angularly,
    // converted to px at that radius), so every edge is soft.
    for (int dy = -outer - 1; dy <= outer + 1; ++dy) {
        for (int dx = -outer - 1; dx <= outer + 1; ++dx) {
            const float d = sqrtf(static_cast<float>(dx * dx + dy * dy));
            const int radial = min(coverage(outer + 0.5f - d), coverage(d - (inner - 0.5f)));
            if (!radial) continue;
            float deg = atan2f(static_cast<float>(dx), static_cast<float>(-dy)) * RAD_TO_DEG;
            if (deg < 0) deg += 360.0f;
            for (int i = 0; i < n; ++i) {
                if (counts[i] <= 0) continue;
                const float inside = min(deg - start[i], end[i] - deg) * DEG_TO_RAD * max(d, 1.0f);
                const int ang = coverage(inside);
                if (ang) blendPx(cx + dx, cy + dy, colors[i], radial * ang / 255);
            }
        }
    }
    flushRows(cy - outer - 1, cy + outer + 1);
}

void drawOverview() {
    const int x = RIGHT_X, y = ROW_A_Y, w = RIGHT_W, h = ROW_A_H;
    panelBox(x, y, w, h, L("CASE OVERVIEW", "ภาพรวมเคส"));
    const int counts[] = {values[1], values[2], values[3], values[4], details["reopened"] | 0};
    const uint16_t colors[] = {C_OPEN, C_PROGRESS, C_PENDING, C_RESOLVED, C_CRITICAL};
    const char *names[] = {L("Open", "เปิดอยู่"), L("In Progress", "กำลังดำเนินการ"),
                           L("Waiting Approval", "รอการอนุมัติ"), L("Resolved", "แก้ไขแล้ว"),
                           L("Reopened", "เปิดใหม่")};
    const int cx = x + 64, cy = y + 84;
    if (hasData) {
        drawDonut(cx, cy, 50, 34, counts, colors, 5);
        char total[12];
        snprintf(total, sizeof(total), "%d", values[0]);
        labelCenter(cx, cy - 13, total, total[3] ? 2 : 3, TEXT);
        labelCenter(cx, cy + 13, L("Total", "ทั้งหมด"), 1, MUTED);
    } else {
        aaCircle(cx, cy, 50, TRACK);
        aaCircle(cx, cy, 34, CARD);
        labelCenter(cx, cy - 4, L("No data", "ไม่มีข้อมูล"), 1, MUTED);
    }
    for (int i = 0; i < 5; ++i) {
        const int ly = y + 40 + i * 19;
        aaRoundRect(x + 136, ly, 8, 8, 2, colors[i]);
        label(x + 150, ly, names[i], 1, MUTED);
        char count[12] = "--";
        if (hasData) snprintf(count, sizeof(count), "%d", counts[i]);
        labelRight(x + w - 12, ly, count, 1, TEXT);
    }
}

Rect attentionRow(int i) { return {PAD + 10, ROW_B_Y + 28 + i * 27, LEFT_W - 20, 24}; }

void drawAttention() {
    const int x = PAD, y = ROW_B_Y, w = LEFT_W, h = ROW_B_H;
    panelBox(x, y, w, h, L("NEEDS ATTENTION", "ต้องดำเนินการ"));
    JsonArrayConst items = details["attentionItems"].as<JsonArrayConst>();
    if (items.isNull()) {
        labelCenter(x + w / 2, y + h / 2, L("Waiting for case data", "กำลังรอข้อมูล"), 1, MUTED);
        return;
    }
    if (items.size() == 0) {
        labelCenter(x + w / 2, y + h / 2, L("Nothing overdue or critical", "ไม่มีเคสเกินกำหนดหรือวิกฤต"), 1, MUTED);
        return;
    }
    // The web badge counts the rows shown (at most three); mirror it.
    char badge[8];
    snprintf(badge, sizeof(badge), "%u", static_cast<unsigned>(items.size()));
    const int bw = textWidth(badge, 1);
    labelRight(x + w - 12, y + 10, badge, 1, C_CRITICAL);
    screen.fillTriangle(x + w - 22 - bw, y + 17, x + w - 18 - bw, y + 9, x + w - 14 - bw, y + 17, C_CRITICAL);

    int i = 0;
    for (JsonObjectConst item : items) {
        if (i == 3) break;
        const Rect r = attentionRow(i++);
        const bool overdue = item["overdue"] | false;
        const uint16_t tone = overdue ? C_CRITICAL : C_PENDING;
        aaRoundRect(r.x, r.y, r.w, r.h, 5, ROW);
        aaCircle(r.x + 10, r.y + 12, 3, tone);
        char caseNumber[24], dept[64], hours[12], title[200];
        copyText(caseNumber, sizeof(caseNumber), item["caseNumber"] | "", 20);
        copyText(dept, sizeof(dept), pick(item, "department", "departmentTh"));
        copyText(title, sizeof(title), item["title"] | "");
        snprintf(hours, sizeof(hours), "%dh", item["hours"] | 0);
        label(r.x + 20, r.y + 8, caseNumber, 1, MUTED);
        const int hx = r.x + r.w - 10;
        labelRight(hx, r.y + 8, hours, 1, tone);
        const int dw = textWidth(dept, 1) + 12;
        const int dx = hx - 40 - dw;
        pill(dx, r.y + 3, dept, MUTED, TRACK);
        const int tx = r.x + 20 + textWidth(caseNumber, 1) + 10;  // proportional font: measure
        utext(tx, r.y + 4, title, TEXT, dx - 8 - tx);
    }
}

Rect categoryRow(int i) { return {RIGHT_X + 4, ROW_B_Y + 25 + i * 19, RIGHT_W - 8, 19}; }

void drawCategories() {
    const int x = RIGHT_X, y = ROW_B_Y, w = RIGHT_W, h = ROW_B_H;
    panelBox(x, y, w, h, L("CASES BY CATEGORY", "เคสตามประเภท"));
    JsonArrayConst rows = details["categories"].as<JsonArrayConst>();
    if (rows.isNull() || rows.size() == 0) {
        labelCenter(x + w / 2, y + h / 2, rows.isNull() ? L("Waiting for case data", "กำลังรอข้อมูล")
                                                        : L("No data", "ไม่มีข้อมูล"), 1, MUTED);
        return;
    }
    int maximum = 1;
    for (JsonObjectConst r : rows) maximum = max(maximum, r["count"].as<int>());
    const int labelW = 96, countW = 28;
    const int trackX = x + 10 + labelW + 6;
    const int trackW = w - 20 - labelW - 6 - countW - 6;
    int ry = y + 30;
    for (JsonObjectConst r : rows) {
        const bool orphan = strcmp(r["slug"] | "", "__other__") == 0;
        char name[64], count[12];
        copyText(name, sizeof(name), orphan ? L("Other", "อื่นๆ") : (r["label"] | ""));
        snprintf(count, sizeof(count), "%d", r["count"].as<int>());
        if (isAscii(name)) {
            name[labelW / 6] = 0;
            label(x + 10, ry, name, 1, MUTED);
        } else {
            utext(x + 10, ry - 4, name, MUTED, labelW);
        }
        aaRoundRect(trackX, ry - 1, trackW, 10, 5, TRACK);
        const int fill = max(10, static_cast<int>(static_cast<int64_t>(trackW) * r["count"].as<int>() / maximum));
        aaRoundRect(trackX, ry - 1, fill, 10, 5, parseColor(r["color"] | "", BRAND));
        labelRight(x + w - 10, ry, count, 1, TEXT);
        ry += 19;
    }
}

// ── Dashboard switcher ───────────────────────────────────────────────────────
// Five fixed slots, as on /display: Kaizen System, Hotel, two reserved blanks,
// System Settings.
constexpr uint16_t RESERVED = rgb(0x232a36);   // rgba(255,255,255,0.10) on BG
constexpr int SWITCH_W = (800 - 2 * PAD - 4 * GAP) / 5;

void dashedRect(int x, int y, int w, int h, uint16_t color) {
    for (int i = x + 8; i + 4 <= x + w - 8; i += 8) {
        screen.drawFastHLine(i, y, 4, color);
        screen.drawFastHLine(i, y + h - 1, 4, color);
    }
    for (int j = y + 8; j + 4 <= y + h - 8; j += 8) {
        screen.drawFastVLine(x, j, 4, color);
        screen.drawFastVLine(x + w - 1, j, 4, color);
    }
}

// 12x12 line icons standing in for lucide LayoutDashboard / Hotel / Settings.
void iconDashboard(int x, int y, uint16_t c) {
    screen.drawRoundRect(x, y, 5, 7, 1, c);
    screen.drawRoundRect(x + 7, y, 5, 4, 1, c);
    screen.drawRoundRect(x + 7, y + 6, 5, 6, 1, c);
    screen.drawRoundRect(x, y + 9, 5, 3, 1, c);
}
void iconHotel(int x, int y, uint16_t c) {
    screen.drawRect(x + 1, y, 10, 12, c);
    for (int r = 0; r < 2; ++r) {
        screen.fillRect(x + 3, y + 2 + r * 3, 2, 2, c);
        screen.fillRect(x + 7, y + 2 + r * 3, 2, 2, c);
    }
    screen.fillRect(x + 5, y + 9, 2, 3, c);
}
void iconSettings(int x, int y, uint16_t c, uint16_t bg) {
    aaCircle(x + 6, y + 6, 4, c);
    aaCircle(x + 6, y + 6, 2, bg);
    screen.fillRect(x + 5, y, 2, 2, c);
    screen.fillRect(x + 5, y + 10, 2, 2, c);
    screen.fillRect(x, y + 5, 2, 2, c);
    screen.fillRect(x + 10, y + 5, 2, 2, c);
}

void drawSwitcher() {
    const int y = SWITCH_Y, h = SWITCH_H;
    const char *names[] = {"Kaizen System", L("Hotel", "โรงแรม"), nullptr, nullptr,
                           L("System Settings", "ตั้งค่าระบบ")};
    for (int i = 0; i < 5; ++i) {
        const int x = PAD + i * (SWITCH_W + GAP);
        if (!names[i]) {
            dashedRect(x, y, SWITCH_W, h, RESERVED);
            continue;
        }
        const bool active = (i == 0 && current == Screen::Kaizen) || (i == 1 && current == Screen::Hotel);
        if (active) aaRoundRect(x, y, SWITCH_W, h, 9, BRAND);
        else card(x, y, SWITCH_W, h);
        const uint16_t fg = active ? TEXT : MUTED;
        const uint16_t bg = active ? BRAND : CARD;
        const int content = 12 + 6 + textWidth(names[i], 1);
        const int ix = x + (SWITCH_W - content) / 2, iy = y + h / 2 - 6;
        if (i == 0) iconDashboard(ix, iy, fg);
        else if (i == 1) iconHotel(ix, iy, fg);
        else iconSettings(ix, iy, fg, bg);
        label(ix + 18, y + h / 2 - 4, names[i], 1, fg);
    }
}

// Send 'S' over serial to receive the framebuffer, run-length encoded:
// "KZSHOT", width u16, height u16, then (count u16, rgb565 u16) runs ending
// with a zero count. Lets the layout be checked on a computer.
void dumpScreen() {
    const uint16_t *fb = screen.getFramebuffer();
    if (!fb) return;
    const uint8_t head[] = {'K', 'Z', 'S', 'H', 'O', 'T', 800 & 0xFF, 800 >> 8, 480 & 0xFF, 480 >> 8};
    Serial.write(head, sizeof(head));
    uint8_t buf[512];
    size_t n = 0;
    constexpr uint32_t total = 800UL * 480UL;
    for (uint32_t i = 0; i < total;) {
        const uint16_t c = fb[i];
        uint16_t run = 1;
        while (i + run < total && run < 65535 && fb[i + run] == c) ++run;
        const uint8_t rec[] = {uint8_t(run), uint8_t(run >> 8), uint8_t(c), uint8_t(c >> 8)};
        memcpy(buf + n, rec, 4);
        n += 4;
        if (n == sizeof(buf)) { Serial.write(buf, n); n = 0; }
        i += run;
    }
    memset(buf + n, 0, 4);
    Serial.write(buf, n + 4);
}

// ── Wi-Fi ────────────────────────────────────────────────────────────────────
constexpr uint32_t ROAM_CHECK_MS = 5 * 60 * 1000;
constexpr int ROAM_BELOW_DBM = -78;
constexpr int ROAM_MARGIN_DB = 8;
constexpr uint32_t REJOIN_AFTER_MS = 45000;

struct ApChoice {
    uint8_t bssid[6];
    int32_t channel;
    int32_t rssi;
};

// Scans for the configured SSID only, logs each access point, returns the strongest.
bool strongestAp(ApChoice &best) {
    best.rssi = -127;
    const int16_t n = WiFi.scanNetworks(false, false, false, 300, 0, WIFI_SSID);
    for (int i = 0; i < n; ++i) {
        Serial.printf("  AP %s  ch %ld  %ld dBm\n", WiFi.BSSIDstr(i).c_str(),
                      (long)WiFi.channel(i), (long)WiFi.RSSI(i));
        if (WiFi.RSSI(i) > best.rssi) {
            best.rssi = WiFi.RSSI(i);
            best.channel = WiFi.channel(i);
            memcpy(best.bssid, WiFi.BSSID(i), 6);
        }
    }
    Serial.printf("Scan: %d access point(s) broadcasting the configured network\n", n > 0 ? n : 0);
    WiFi.scanDelete();
    return n > 0;
}

const char *signalQuality(int rssi) {
    return rssi >= -67 ? L("good", "ดี") : rssi >= -75 ? L("fair", "พอใช้") : rssi >= -85 ? L("weak", "อ่อน")
                                                                                       : L("very weak", "อ่อนมาก");
}

const char *statusText() {
    switch (status) {
        case Status::Unconfigured: return L("Waiting for device configuration", "รอการตั้งค่าอุปกรณ์");
        case Status::Live: {
            static char live[96];
            const char *every = cfg.refreshSecs >= 60 ? (cfg.refreshSecs == 60 ? "1m" : "5m")
                                : cfg.refreshSecs == 30 ? "30s" : "15s";
            snprintf(live, sizeof(live), thai ? "ออนไลน์  |  อัปเดตทุก %s" : "Live  |  Refreshes every %s", every);
            return live;
        }
        case Status::Stale: return L("Showing last update  |  Retrying...", "แสดงข้อมูลล่าสุด  |  กำลังลองใหม่...");
        case Status::NoWifi: return L("Waiting for Wi-Fi...", "กำลังรอ Wi-Fi...");
        case Status::NoClock: return L("Synchronizing clock...", "กำลังตั้งเวลา...");
        case Status::Unavailable: return L("Kaizen data unavailable  |  Retrying...", "ดึงข้อมูลไม่ได้  |  กำลังลองใหม่...");
        default: return L("Connecting to Wi-Fi...", "กำลังเชื่อมต่อ Wi-Fi...");
    }
}

void drawStatus() {
    screen.fillRect(0, 450, 800, 30, BG);
    label(PAD, 458, statusText(), 1, MUTED);
    if (WiFi.getMode() == WIFI_STA && WiFi.status() == WL_CONNECTED) {
        const int rssi = WiFi.RSSI();
        char signal[48];
        snprintf(signal, sizeof(signal), "Wi-Fi %d dBm  %s", rssi, signalQuality(rssi));
        labelRight(800 - PAD, 458, signal, 1, rssi >= -75 ? MUTED : rssi >= -85 ? C_PENDING : C_CRITICAL);
    }
}

// ── Touch: GT911 capacitive controller on I2C (SDA 19, SCL 20, reset 38) ─────
constexpr int TOUCH_SDA = 19, TOUCH_SCL = 20, TOUCH_RST = 38;
constexpr bool TOUCH_FLIP_X = false, TOUCH_FLIP_Y = false;
constexpr uint32_t IDLE_RETURN_MS = 120000;  // like the web board's settings idle
uint8_t gtAddr = 0;
uint16_t gtMaxX = 800, gtMaxY = 480;

bool gtRead(uint16_t reg, uint8_t *buf, size_t n) {
    Wire.beginTransmission(gtAddr);
    Wire.write(reg >> 8);
    Wire.write(reg & 0xFF);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(static_cast<int>(gtAddr), static_cast<int>(n)) != static_cast<int>(n)) return false;
    for (size_t i = 0; i < n; ++i) buf[i] = Wire.read();
    return true;
}
void gtClear() {
    Wire.beginTransmission(gtAddr);
    Wire.write(0x81);
    Wire.write(0x4E);
    Wire.write(0);
    Wire.endTransmission();
}

void touchBegin() {
    pinMode(TOUCH_RST, OUTPUT);
    digitalWrite(TOUCH_RST, LOW);
    delay(10);
    digitalWrite(TOUCH_RST, HIGH);
    delay(60);
    Wire.begin(TOUCH_SDA, TOUCH_SCL, 400000);
    for (uint8_t addr : {0x5D, 0x14}) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) { gtAddr = addr; break; }
    }
    if (!gtAddr) {
        Serial.println("Touch: no GT911 found on SDA 19 / SCL 20");
        return;
    }
    char id[5] = {0};
    gtRead(0x8140, reinterpret_cast<uint8_t *>(id), 4);
    uint8_t res[4];
    if (gtRead(0x8048, res, 4)) {
        const uint16_t mx = res[0] | res[1] << 8, my = res[2] | res[3] << 8;
        if (mx >= 100 && mx <= 4096 && my >= 100 && my <= 4096) { gtMaxX = mx; gtMaxY = my; }
    }
    Serial.printf("Touch: GT%s at 0x%02X, reports %ux%u\n", id, gtAddr, gtMaxX, gtMaxY);
}

// Finger-down, move and up, with the point mapped to screen pixels (and
// flipped when the panel is mounted upside down).
enum class Touch { None, Down, Move, Up };
Touch touchPoll(int &x, int &y) {
    static bool down = false;
    if (!gtAddr) return Touch::None;
    uint8_t st;
    if (!gtRead(0x814E, &st, 1) || !(st & 0x80)) return Touch::None;  // no new report
    const uint8_t points = st & 0x0F;
    uint8_t p[4];
    const bool havePoint = points > 0 && gtRead(0x8150, p, 4);
    gtClear();
    if (!havePoint) {
        const bool was = down;
        down = false;
        return was ? Touch::Up : Touch::None;
    }
    x = static_cast<int>((p[0] | p[1] << 8) * 800L / gtMaxX);
    y = static_cast<int>((p[2] | p[3] << 8) * 480L / gtMaxY);
    if (TOUCH_FLIP_X != rotated180) x = 799 - x;
    if (TOUCH_FLIP_Y != rotated180) y = 479 - y;
    if (down) return Touch::Move;
    down = true;
    return Touch::Down;
}

// ── Backlight ────────────────────────────────────────────────────────────────
// Eyes judge brightness logarithmically: a linear 60% duty looks almost like
// 100%. Map the percentage through a 2.2 gamma so each step is visible, and
// drive it at a few hundred Hz, which the board's backlight driver follows.
constexpr int BL_CHANNEL = 1;
constexpr int BL_FREQ_HZ = 300;
int bangkokMinutes() {
    const time_t now = time(nullptr);
    if (now < 1700000000) return -1;
    return static_cast<int>(((now + 7 * 3600) % 86400) / 60);
}
// mirrors inWindow (panelTheme.ts)
bool inWindow(int t, int from, int to) {
    if (t < 0 || from == to) return false;
    return from < to ? (t >= from && t < to) : (t >= from || t < to);
}
bool nightNow() { return cfg.nightDim && inWindow(bangkokMinutes(), cfg.nightFrom, cfg.nightTo); }
void applyBrightness() {
    static int lastDuty = -1;
    const int pct = nightNow() ? cfg.nightLevel : cfg.brightness;
    const float f = constrain(pct, 10, 100) / 100.0f;
    const int duty = max(2, static_cast<int>(lroundf(255.0f * powf(f, 2.2f))));
    if (duty != lastDuty) ledcWrite(BL_CHANNEL, duty);
    lastDuty = duty;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
int getJson(const char *url, JsonDocument &doc, JsonDocument *filter) {
    WiFiClientSecure tls;
    tls.setCACert(ROOT_CA);
    HTTPClient http;
    http.setConnectTimeout(8000);
    http.setTimeout(8000);
    http.useHTTP10(true);
    if (!http.begin(tls, url)) return -1;
    http.addHeader("Authorization", String("Bearer ") + DISPLAY_TOKEN);
    int code = http.GET();
    if (code == HTTP_CODE_OK) {
        const DeserializationError err = filter
            ? deserializeJson(doc, http.getStream(), DeserializationOption::Filter(*filter))
            : deserializeJson(doc, http.getStream());
        if (err) code = -2;
    }
    http.end();
    return code;
}

// ── Drill-down (mirrors DisplayPage's overlay) ────────────────────────────────
// Tapping a KPI tile, a category row or a Needs Attention row opens the
// matching cases over the whole board. Tap a case to expand it. The overlay
// closes itself after the idle timeout (30 s by default, as on the web), because a panel
// left on a filtered list reads as if that were the whole count.
constexpr int OX = PAD, OY = 8, OW = 800 - 2 * PAD, OH = 480 - 16;
constexpr Rect DRILL_CLOSE = {OX + OW - 52, OY + 10, 40, 36};
constexpr Rect DRILL_DOWN = {OX + OW - 100, OY + 10, 40, 36};
constexpr Rect DRILL_UP = {OX + OW - 148, OY + 10, 40, 36};
constexpr int LIST_TOP = OY + 58, LIST_BOTTOM = OY + OH - 8;
constexpr int MAX_DRILL = 400, MAX_ROWS = 16;

struct Drill {
    bool open = false;
    char kind = 's';        // s = status bucket, c = category slug, a = attention
    char key[40] = "";
    char title[96] = "";
    uint16_t color = TEXT;
    char expanded[40] = ""; // case id
    int start = 0;          // first case on this page
    int pageStarts[64];
    int depth = 0;
    int count = 0;
    int idx[MAX_DRILL];     // positions in casesDoc["cases"]
    int rows = 0;           // rows drawn on this page, for hit-testing
    Rect rowRect[MAX_ROWS];
    int rowCase[MAX_ROWS];
    bool failed = false;
    uint32_t touched = 0;
} drill;
JsonDocument casesDoc;
uint32_t casesAt = 0;
bool casesOk = false;

struct StatusMeta {
    const char *en, *th;
    uint16_t color;
};
StatusMeta statusMeta(const char *s) {
    if (!strcmp(s, "open")) return {"Open", "เปิด", C_OPEN};
    if (!strcmp(s, "assigned")) return {"Assigned", "มอบหมายแล้ว", C_ASSIGNED};
    if (!strcmp(s, "in_progress")) return {"In Progress", "กำลังดำเนินการ", C_PROGRESS};
    if (!strncmp(s, "pending_", 8)) return {"Pending Approval", "รออนุมัติ", C_PENDING};
    if (!strcmp(s, "closed")) return {"Closed", "ปิด", C_RESOLVED};
    if (!strcmp(s, "reopened")) return {"Reopened", "เปิดใหม่", C_CRITICAL};
    return {s, s, MUTED};
}
uint16_t priorityColor(const char *p) {
    if (!strcmp(p, "low")) return C_GREY;
    if (!strcmp(p, "medium")) return C_PROGRESS;
    if (!strcmp(p, "high")) return C_OPEN;
    if (!strcmp(p, "critical")) return C_CRITICAL;
    return MUTED;
}

bool drillMatches(JsonObjectConst c) {
    const char *st = c["status"] | "";
    if (drill.kind == 'c') return strcmp(c["cat"] | "", drill.key) == 0;
    if (!strcmp(drill.key, "open")) return !strcmp(st, "open");
    if (!strcmp(drill.key, "inProgress")) return !strcmp(st, "assigned") || !strcmp(st, "in_progress");
    if (!strcmp(drill.key, "pending")) return !strncmp(st, "pending_", 8);
    if (!strcmp(drill.key, "resolved")) return !strcmp(st, "closed");
    if (!strcmp(drill.key, "overdue")) return c["overdue"] | false;
    return true;  // total
}

void filterDrill() {
    drill.count = 0;
    JsonArrayConst cases = casesDoc["cases"].as<JsonArrayConst>();
    if (drill.kind == 'a') {
        // Same order as the board's Needs Attention rows.
        for (JsonObjectConst item : details["attentionItems"].as<JsonArrayConst>()) {
            int i = 0;
            for (JsonObjectConst c : cases) {
                if (strcmp(c["id"] | "", item["id"] | "-") == 0 && drill.count < MAX_DRILL) drill.idx[drill.count++] = i;
                ++i;
            }
        }
        return;
    }
    int i = 0;
    for (JsonObjectConst c : cases) {
        if (drillMatches(c) && drill.count < MAX_DRILL) drill.idx[drill.count++] = i;
        ++i;
    }
}

void drawIdleBar() {
    const uint32_t idle = drillIdleMs();
    const uint32_t left = idle - min<uint32_t>(idle, millis() - drill.touched);
    const int w = static_cast<int>(static_cast<int64_t>(OW - 4) * left / idle);
    screen.fillRect(OX + 2, OY + 2, OW - 4, 3, blend(TEXT, BG, 15));
    screen.fillRect(OX + 2, OY + 2, w, 3, drill.color);
}

void arrowButton(const Rect &r, bool up, bool enabled) {
    aaRoundRect(r.x, r.y, r.w, r.h, 8, blend(TEXT, BG, 18));
    const uint16_t c = enabled ? TEXT : blend(MUTED, BG, 90);
    const int cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    if (up) screen.fillTriangle(cx - 8, cy + 4, cx + 8, cy + 4, cx, cy - 5, c);
    else screen.fillTriangle(cx - 8, cy - 4, cx + 8, cy - 4, cx, cy + 5, c);
}

// Detail lines under an expanded case: description, proposed solution, then
// PIC / location / reporter. Returns the height used (or needed, if !draw).
// Nothing is drawn below `bottom`, so a row cut off at the page end stays tidy.
int caseDetail(JsonObjectConst c, int x, int top, int w, bool draw, int bottom = 10000) {
    int y = top + 6;
    auto room = [&](int want) { return min(want, max(0, (bottom - y) / 18)); };
    const char *desc = c["desc"] | "";
    if (room(4) > 0) y += 18 * uwrap(x, y, desc[0] ? desc : L("No description", "ไม่มีรายละเอียด"), TEXT, w, 18, room(4), draw);
    const char *proposed = c["proposed"] | "";
    if (proposed[0] && room(2) > 0) {
        char line[400];
        snprintf(line, sizeof(line), "%s%s", L("Proposed: ", "แนวทางแก้ไข: "), proposed);
        y += 18 * uwrap(x, y, line, MUTED, w, 18, room(2), draw);
    }
    char meta[400] = "";
    const char *pic = c["pic"] | "", *loc = c["location"] | "", *by = c["by"] | "";
    if (pic[0]) snprintf(meta + strlen(meta), sizeof(meta) - strlen(meta), "PIC: %s    ", pic);
    if (loc[0]) snprintf(meta + strlen(meta), sizeof(meta) - strlen(meta), "%s    ", loc);
    if (by[0]) snprintf(meta + strlen(meta), sizeof(meta) - strlen(meta), "%s %s", L("by", "แจ้งโดย"), by);
    if (meta[0] && room(1) > 0) {
        if (draw) utext(x, y, meta, MUTED, w);
        y += 18;
    }
    return y + 6 - top;
}

void drawDrill() {
    aaRoundRect(OX, OY, OW, OH, 12, BORDER);
    aaRoundRect(OX + 1, OY + 1, OW - 2, OH - 2, 11, BG);
    drawIdleBar();

    // Title row: colour key, name, count, paging, close
    aaRoundRect(OX + 14, OY + 22, 12, 12, 2, drill.color);
    label(OX + 34, OY + 21, drill.title, 2, TEXT);
    int px = OX + 34 + textWidth(drill.title, 2) + 10;
    char count[48];
    if (thai) snprintf(count, sizeof(count), "%d เคส", drill.count);
    else snprintf(count, sizeof(count), "%d %s", drill.count, drill.count == 1 ? "case" : "cases");
    px += pill(px, OY + 19, count, MUTED, blend(TEXT, BG, 18), 18) + 8;
    aaRoundRect(DRILL_CLOSE.x, DRILL_CLOSE.y, DRILL_CLOSE.w, DRILL_CLOSE.h, 8, blend(TEXT, BG, 18));
    const int cx = DRILL_CLOSE.x + DRILL_CLOSE.w / 2, cy = DRILL_CLOSE.y + DRILL_CLOSE.h / 2;
    for (int t = -1; t <= 1; ++t) {
        screen.drawLine(cx - 7 + t, cy - 7, cx + 7 + t, cy + 7, TEXT);
        screen.drawLine(cx - 7 + t, cy + 7, cx + 7 + t, cy - 7, TEXT);
    }
    screen.drawFastHLine(OX + 1, OY + 52, OW - 2, BORDER);

    drill.rows = 0;
    if (!casesOk) {
        labelCenter(400, 240, drill.failed ? L("Can't load cases", "โหลดรายการเคสไม่ได้") : L("Loading...", "กำลังโหลด..."),
                    1, drill.failed ? C_CRITICAL : MUTED);
        arrowButton(DRILL_UP, true, false);
        arrowButton(DRILL_DOWN, false, false);
        return;
    }
    if (drill.count == 0) {
        labelCenter(400, 240, L("No cases yet", "ยังไม่มีเคส"), 1, MUTED);
        arrowButton(DRILL_UP, true, false);
        arrowButton(DRILL_DOWN, false, false);
        return;
    }

    JsonArrayConst cases = casesDoc["cases"].as<JsonArrayConst>();
    const int rx = OX + 10, rw = OW - 20;
    int y = LIST_TOP;
    int k = drill.start;
    for (; k < drill.count && drill.rows < MAX_ROWS; ++k) {
        JsonObjectConst c = cases[drill.idx[k]];
        const bool open = strcmp(c["id"] | "", drill.expanded) == 0;
        const int detailH = open ? caseDetail(c, rx + 32, y + 34, rw - 44, false) : 0;
        int h = 34 + detailH;
        if (y + 34 > LIST_BOTTOM) break;
        if (y + h > LIST_BOTTOM) h = LIST_BOTTOM - y;  // last expanded row may be cut
        aaRoundRect(rx, y, rw, h, 6, ROW_BG);

        // priority · number · title · department · status · age
        aaCircle(rx + 14, y + 17, 4, priorityColor(c["priority"] | ""));
        char number[24];
        copyText(number, sizeof(number), c["n"] | "", 20);
        label(rx + 26, y + 13, number, 1, MUTED);
        const bool overdue = c["overdue"] | false;
        char hours[12];
        snprintf(hours, sizeof(hours), "%dh", c["hours"] | 0);
        const int hx = rx + rw - 12;
        labelRight(hx, y + 13, hours, 1, overdue ? C_CRITICAL : MUTED);
        const StatusMeta sm = statusMeta(c["status"] | "");
        const char *stLabel = L(sm.en, sm.th);
        const int sw = textWidth(stLabel, 1) + 12;
        const int sx = hx - 36 - sw;
        pill(sx, y + 8, stLabel, sm.color, blend(sm.color, ROW_BG, 34));
        const char *dept = pick(c, "deptEn", "deptTh");
        const int dw = textWidth(dept, 1) + 12;
        const int dx = sx - 6 - dw;
        pill(dx, y + 8, dept, MUTED, blend(TEXT, ROW_BG, 15));
        const int tx = rx + 26 + textWidth(number, 1) + 10;  // proportional font: measure
        utext(tx, y + 9, c["title"] | "", TEXT, dx - 10 - tx);
        // chevron
        const int vx = rx + rw - 4;
        if (open) screen.fillTriangle(vx - 2, y + 20, vx + 2, y + 20, vx, y + 15, MUTED);

        if (open) {
            caseDetail(c, rx + 32, y + 34, rw - 44, true, y + h - 4);
        }
        drill.rowRect[drill.rows] = {rx, y, rw, h};
        drill.rowCase[drill.rows] = drill.idx[k];
        ++drill.rows;
        y += h + 4;
    }
    arrowButton(DRILL_UP, true, drill.depth > 0);
    arrowButton(DRILL_DOWN, false, k < drill.count);
    char range[32];
    snprintf(range, sizeof(range), "%d-%d / %d", drill.start + 1, k, drill.count);
    labelRight(DRILL_UP.x - 10, OY + 25, range, 1, MUTED);
}

void drawDashboard();
void openDrill(char kind, const char *key, const char *title, uint16_t color, const char *expandId = "") {
    drill.open = true;
    drill.kind = kind;
    copyText(drill.key, sizeof(drill.key), key);
    copyText(drill.title, sizeof(drill.title), title);
    drill.color = color;
    copyText(drill.expanded, sizeof(drill.expanded), expandId);
    drill.start = 0;
    drill.depth = 0;
    drill.failed = false;
    drill.touched = millis();
    // The list comes from ?view=cases on demand; reuse it for a minute.
    if (!casesOk || millis() - casesAt > pollMs()) {
        casesOk = false;
        drawDrill();  // "Loading..."
        String url = String(DISPLAY_URL) + "?view=cases";
        const int code = getJson(url.c_str(), casesDoc, nullptr);
        casesOk = code == HTTP_CODE_OK;
        drill.failed = !casesOk;
        if (casesOk) casesAt = millis();
        Serial.printf("Cases fetch: %d\n", code);
    }
    if (casesOk) filterDrill();
    drawDrill();
}
void closeDrill() {
    drill.open = false;
    drawDashboard();
}

void drillTap(int x, int y) {
    drill.touched = millis();
    if (DRILL_CLOSE.hit(x, y)) { closeDrill(); return; }
    if (DRILL_DOWN.hit(x, y)) {
        const int next = drill.start + drill.rows;
        if (drill.rows > 0 && next < drill.count && drill.depth < 64) {
            drill.pageStarts[drill.depth++] = drill.start;
            drill.start = next;
            drawDrill();
        }
        return;
    }
    if (DRILL_UP.hit(x, y)) {
        if (drill.depth > 0) {
            drill.start = drill.pageStarts[--drill.depth];
            drawDrill();
        }
        return;
    }
    for (int r = 0; r < drill.rows; ++r) {
        if (!drill.rowRect[r].in(x, y)) continue;
        JsonObjectConst c = casesDoc["cases"][drill.rowCase[r]];
        const char *id = c["id"] | "";
        if (strcmp(drill.expanded, id) == 0) drill.expanded[0] = 0;
        else copyText(drill.expanded, sizeof(drill.expanded), id);
        drawDrill();
        return;
    }
    drawIdleBar();
}

void connectStrongest();

// ── System Settings: mirrors src/components/DisplaySettings.tsx ─────────────
// Same overlay as the web: header with close, a tab rail (Display, Data,
// Network, Device, About) and rows of label + hint + control. The web marks
// rows tagged DEVICE as values "firmware would own on real hardware"; here they
// are real: backlight PWM, night dim, rotation, the Wi-Fi link, reboot and
// reset. There is no keyboard yet, so text fields are read-only.
constexpr uint32_t SETTINGS_IDLE_MS = 120000;  // as the web: long enough to adjust things
constexpr int RAIL_W = 128;
constexpr int CX0 = OX + RAIL_W + 14, CX1 = OX + OW - 16;
constexpr int ROWS_TOP = OY + 54, ROW_H = 44;

bool settingsOpen = false;
int section = 0;  // 0 display, 1 data, 2 network, 3 device, 4 about
uint32_t settingsTouched = 0;
char note[96] = "";
uint32_t noteUntil = 0;
int armed = 0;            // control id waiting for its confirming second tap
uint32_t armedUntil = 0;

enum Ctl {
    C_CLOSE = 1, C_TAB, C_BRIGHT, C_NIGHT, C_FROM_M, C_FROM_P, C_TO_M, C_TO_P, C_NIGHT_LVL, C_ORIENT,
    C_LANG, C_REFRESH, C_TOUCH, C_IDLE, C_RECONNECT, C_FIELD, C_SOUND, C_REBOOT, C_RESET, C_OTA
};
struct Control { Rect r; int id, aux; };
Control ctls[40];
int ctlCount = 0;
void addCtl(Rect r, int id, int aux = 0) {
    if (ctlCount < 40) ctls[ctlCount++] = {r, id, aux};
}

void setNote(const char *msg) {
    copyText(note, sizeof(note), msg);
    noteUntil = millis() + 2600;
}

void saveSettings() {
    prefs.putUChar("bright", cfg.brightness);
    prefs.putBool("ndim", cfg.nightDim);
    prefs.putUShort("nfrom", cfg.nightFrom);
    prefs.putUShort("nto", cfg.nightTo);
    prefs.putUChar("nlvl", cfg.nightLevel);
    prefs.putBool("rot", cfg.rotated);
    prefs.putUShort("poll", cfg.refreshSecs);
    prefs.putUShort("idle", cfg.idleSecs);
    prefs.putBool("touch", cfg.touch);
}
void loadSettings() {
    cfg.brightness = constrain(static_cast<int>(prefs.getUChar("bright", 100)), 10, 100);
    cfg.nightDim = prefs.getBool("ndim", false);
    cfg.nightFrom = prefs.getUShort("nfrom", 22 * 60) % 1440;
    cfg.nightTo = prefs.getUShort("nto", 6 * 60) % 1440;
    cfg.nightLevel = constrain(static_cast<int>(prefs.getUChar("nlvl", 35)), 10, 100);
    cfg.rotated = prefs.getBool("rot", false);
    cfg.refreshSecs = prefs.getUShort("poll", 60);
    cfg.idleSecs = prefs.getUShort("idle", 30);
    cfg.touch = prefs.getBool("touch", true);
}

// ── controls (sizes are the web's, scaled ~0.78) ──
void chip(int x, int y) {
    pill(x, y, "DEVICE", MUTED, blend(TEXT, BG, 18), 14, 0);
}
void toggle(int right, int cy, bool on, int id, bool enabled = true) {
    const Rect r = {right - 42, cy - 12, 42, 24};
    aaRoundRect(r.x, r.y, r.w, r.h, 12, on ? BRAND : blend(TEXT, BG, enabled ? 30 : 14));
    aaCircle(on ? r.x + r.w - 12 : r.x + 12, cy, 9, enabled ? TEXT : blend(TEXT, BG, 90));
    addCtl(r, id);
}
// Returns the left edge of what it drew.
int segmented(int right, int cy, const char *const *labels, const int *values, int n, int current, int id) {
    int widths[6], total = 0;
    for (int i = 0; i < n; ++i) { widths[i] = max(48, uwidth(labels[i]) + 18); total += widths[i]; }
    int x = right - total;
    const int left = x;
    aaRoundRect(x, cy - 14, total, 28, 7, blend(TEXT, BG, 15));
    for (int i = 0; i < n; ++i) {
        const bool on = values[i] == current;
        if (on) aaRoundRect(x, cy - 14, widths[i], 28, 7, BRAND);
        utext(x + (widths[i] - uwidth(labels[i])) / 2, cy - 8, labels[i], on ? TEXT : MUTED);  // one font for all options
        addCtl({x, cy - 14, widths[i], 28}, id, values[i]);
        x += widths[i];
    }
    return left;
}
constexpr int SLIDER_W = 150;
void slider(int right, int cy, int value, int id) {
    char v[8];
    snprintf(v, sizeof(v), "%d%%", value);
    const int tx = right - 40 - 12 - SLIDER_W;
    screen.fillRect(tx - 10, cy - 14, SLIDER_W + 20 + 12 + 40, 28, BG);
    aaRoundRect(tx, cy - 3, SLIDER_W, 6, 3, blend(TEXT, BG, 30));
    const int kx = tx + (value - 10) * SLIDER_W / 90;
    aaRoundRect(tx, cy - 3, kx - tx, 6, 3, BRAND);
    aaCircle(kx, cy, 8, BRAND);
    labelRight(right, cy - 4, v, 1, TEXT);
    addCtl({tx - 10, cy - 16, SLIDER_W + 20, 32}, id);
}
int sliderValue(const Rect &r, int x) {
    const int v = 10 + (x - (r.x + 10)) * 90 / SLIDER_W;
    return constrain((v + 2) / 5 * 5, 10, 100);  // 5% steps
}
void actionButton(int right, int cy, const char *text, int id, bool danger = false, bool enabled = true) {
    const int w = textWidth(text, 1) + 28;
    const Rect r = {right - w, cy - 14, w, 28};
    const uint16_t fg = !enabled ? blend(MUTED, BG, 120) : danger ? C_CRITICAL : TEXT;
    aaRoundRect(r.x, r.y, r.w, r.h, 7, danger ? blend(C_CRITICAL, BG, 60) : BORDER);
    aaRoundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 6, danger ? blend(C_CRITICAL, BG, 36) : blend(TEXT, BG, 20));
    labelCenter(r.x + r.w / 2, cy - 4, text, 1, fg);
    addCtl(r, id);
}
void readOnly(int right, int cy, const char *text) {
    if (isAscii(text)) labelRight(right, cy - 4, text, 1, MUTED);
    else utext(right - uwidth(text), cy - 8, text, MUTED);
}
void field(int right, int cy, const char *value, const char *placeholder) {
    const Rect r = {right - 172, cy - 14, 172, 28};
    aaRoundRect(r.x, r.y, r.w, r.h, 7, BORDER);
    aaRoundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 6, blend(TEXT, BG, 15));
    const bool empty = !value[0];
    utext(r.x + 9, cy - 8, empty ? placeholder : value, empty ? MUTED : TEXT, r.w - 18);
    addCtl(r, C_FIELD);
}
void timeStepper(int x, int cy, int minutes, int minusId, int plusId) {
    char v[8];
    snprintf(v, sizeof(v), "%02d:%02d", minutes / 60, minutes % 60);
    for (int k = 0; k < 2; ++k) {
        const Rect r = {k ? x + 26 + 66 : x, cy - 13, 26, 26};
        aaRoundRect(r.x, r.y, r.w, r.h, 6, blend(TEXT, BG, 20));
        screen.fillRect(r.x + 8, cy - 1, 10, 2, TEXT);
        if (k) screen.fillRect(r.x + 12, cy - 5, 2, 10, TEXT);
        addCtl(r, k ? plusId : minusId);
    }
    aaRoundRect(x + 30, cy - 14, 58, 28, 7, blend(TEXT, BG, 15));
    labelCenter(x + 59, cy - 4, v, 1, TEXT);
}

// One settings row: label (+ DEVICE chip), hint, bottom rule. Returns the
// vertical centre for its control.
int rowY = 0;
int beginRow(const char *name, const char *hint = nullptr, bool device = false) {
    const int y = rowY;
    const bool twoLines = hint && hint[0];
    const int ly = twoLines ? y + 5 : y + ROW_H / 2 - 8;
    const int w = utext(CX0, ly, name, TEXT, 300);
    if (device) chip(CX0 + w + 8, ly + 1);
    if (twoLines) {
        if (isAscii(hint)) label(CX0, ly + 21, hint, 1, MUTED);
        else utext(CX0, ly + 17, hint, MUTED, 330);
    }
    screen.drawFastHLine(CX0, y + ROW_H - 1, CX1 - CX0, BORDER);
    rowY += ROW_H;
    return y + ROW_H / 2;
}

// 12x12 tab icons standing in for lucide Monitor / RefreshCw / Wifi / Cpu / Info.
void tabIcon(int i, int x, int y, uint16_t c, uint16_t bg) {
    switch (i) {
        case 0: screen.drawRoundRect(x, y, 12, 9, 1, c); screen.fillRect(x + 5, y + 9, 2, 2, c); screen.fillRect(x + 3, y + 11, 6, 1, c); break;
        case 1: screen.drawCircle(x + 6, y + 6, 5, c); screen.fillRect(x + 7, y, 5, 4, bg);
                screen.fillTriangle(x + 7, y - 1, x + 7, y + 4, x + 11, y + 2, c); break;
        case 2: screen.drawCircle(x + 6, y + 11, 4, c); screen.drawCircle(x + 6, y + 11, 8, c);
                screen.fillRect(x - 3, y + 11, 18, 9, bg);                    // keep the upper arcs
                screen.fillTriangle(x - 3, y + 11, x - 3, y - 1, x + 3, y + 11, bg);
                screen.fillTriangle(x + 15, y + 11, x + 15, y - 1, x + 9, y + 11, bg);
                aaCircle(x + 6, y + 10, 1, c); break;
        case 3: screen.drawRect(x + 2, y + 2, 8, 8, c); screen.fillRect(x + 4, y + 4, 4, 4, c);
                for (int k = 3; k <= 8; k += 5) {
                    screen.drawFastHLine(x, y + k, 2, c); screen.drawFastHLine(x + 10, y + k, 2, c);
                    screen.drawFastVLine(x + k, y, 2, c); screen.drawFastVLine(x + k, y + 10, 2, c);
                }
                break;
        default: screen.drawCircle(x + 6, y + 6, 5, c); screen.fillRect(x + 5, y + 5, 2, 4, c); screen.fillRect(x + 5, y + 2, 2, 2, c);
    }
}

void drawSettings() {
    ctlCount = 0;
    aaRoundRect(OX, OY, OW, OH, 12, BORDER);
    aaRoundRect(OX + 1, OY + 1, OW - 2, OH - 2, 11, BG);

    // Header
    label(OX + 14, OY + 18, L("System Settings", "ตั้งค่าระบบ"), 2, TEXT);
    aaRoundRect(DRILL_CLOSE.x, DRILL_CLOSE.y, DRILL_CLOSE.w, DRILL_CLOSE.h, 8, blend(TEXT, BG, 18));
    const int xc = DRILL_CLOSE.x + DRILL_CLOSE.w / 2, yc = DRILL_CLOSE.y + DRILL_CLOSE.h / 2;
    for (int k = -1; k <= 1; ++k) {
        screen.drawLine(xc - 7 + k, yc - 7, xc + 7 + k, yc + 7, TEXT);
        screen.drawLine(xc - 7 + k, yc + 7, xc + 7 + k, yc - 7, TEXT);
    }
    addCtl(DRILL_CLOSE, C_CLOSE);
    if (note[0] && millis() < noteUntil) {
        const int w = textWidth(note, 1) + 16;
        pill(DRILL_CLOSE.x - 12 - w, OY + 19, note, C_RESOLVED, blend(C_RESOLVED, BG, 36), 20);
    }
    screen.drawFastHLine(OX + 1, OY + 50, OW - 2, BORDER);

    // Tab rail
    screen.drawFastVLine(OX + RAIL_W, OY + 51, OH - 52, BORDER);
    const char *tabs[] = {L("Display", "หน้าจอ"), L("Data", "ข้อมูล"), L("Network", "เครือข่าย"),
                          L("Device", "อุปกรณ์"), L("About", "เกี่ยวกับ")};
    for (int i = 0; i < 5; ++i) {
        const Rect r = {OX + 6, OY + 58 + i * 40, RAIL_W - 12, 34};
        const bool on = i == section;
        if (on) aaRoundRect(r.x, r.y, r.w, r.h, 7, BRAND);
        const uint16_t fg = on ? TEXT : MUTED;
        tabIcon(i, r.x + 10, r.y + 11, fg, on ? BRAND : BG);
        utext(r.x + 30, r.y + 9, tabs[i], fg, r.w - 34);
        addCtl(r, C_TAB, i);
    }

    // Rows
    rowY = ROWS_TOP;
    char v[96];
    if (section == 0) {
        int cy = beginRow(L("Brightness", "ความสว่าง"), L("Backlight PWM duty cycle", "PWM ของไฟหน้าจอ"), true);
        slider(CX1, cy, cfg.brightness, C_BRIGHT);
        cy = beginRow(L("Night dim", "หรี่จอกลางคืน"), L("Drop the backlight between set hours", "ลดความสว่างอัตโนมัติตามเวลา"), true);
        toggle(CX1, cy, cfg.nightDim, C_NIGHT);
        if (cfg.nightDim) {
            cy = beginRow(L("Night hours", "ช่วงเวลา"), L("Bangkok time", "เวลาประเทศไทย"));
            timeStepper(CX1 - 254, cy, cfg.nightFrom, C_FROM_M, C_FROM_P);
            utext(CX1 - 131, cy - 8, "→", MUTED);
            timeStepper(CX1 - 118, cy, cfg.nightTo, C_TO_M, C_TO_P);
            cy = beginRow(L("Night brightness", "ความสว่างกลางคืน"));
            slider(CX1, cy, cfg.nightLevel, C_NIGHT_LVL);
        }
        cy = beginRow(L("Orientation", "การหมุนจอ"), L("For upside-down mounting", "สำหรับการติดตั้งกลับหัว"), true);
        const char *orient[] = {L("Normal", "ปกติ"), "180°"};
        const int orientV[] = {0, 180};
        segmented(CX1, cy, orient, orientV, 2, cfg.rotated ? 180 : 0, C_ORIENT);
        // Not on the web panel, which follows the app's language; the panel needs its own.
        cy = beginRow(L("Language", "ภาษา"), L("Labels on this panel", "ภาษาบนหน้าจอนี้"));
        const char *langs[] = {"English", "ไทย"};
        const int langV[] = {0, 1};
        segmented(CX1, cy, langs, langV, 2, thai ? 1 : 0, C_LANG);
    } else if (section == 1) {
        int cy = beginRow(L("Refresh interval", "รอบดึงข้อมูล"), L("How often the board re-reads cases", "ความถี่ในการดึงเคสใหม่"));
        const char *ref[] = {"15s", "30s", "1m", "5m"};
        const int refV[] = {15, 30, 60, 300};
        segmented(CX1, cy, ref, refV, 4, cfg.refreshSecs, C_REFRESH);
        cy = beginRow(L("Touch drill-down", "สัมผัสเพื่อดูรายละเอียด"), L("Off makes the board display-only", "ปิดเพื่อให้เป็นจอแสดงผลอย่างเดียว"));
        toggle(CX1, cy, cfg.touch, C_TOUCH);
        cy = beginRow(L("Return to summary after", "กลับหน้าสรุปอัตโนมัติ"), L("Idle timeout on a drill-down", "เมื่อไม่มีการสัมผัส"));
        const char *idle[] = {"10s", "30s", "1m", "2m"};
        const int idleV[] = {10, 30, 60, 120};
        segmented(CX1, cy, idle, idleV, 4, cfg.idleSecs, C_IDLE);
    } else if (section == 2) {
        const bool up = WiFi.status() == WL_CONNECTED;
        char ssid[40];
        copyText(ssid, sizeof(ssid), WIFI_SSID, 30);
        int cy = beginRow(L("Connection", "การเชื่อมต่อ"), L("Wi-Fi on the ESP32-S3, 2.4 GHz", "Wi-Fi บน ESP32-S3 ความถี่ 2.4 GHz"), true);
        snprintf(v, sizeof(v), "Wi-Fi - %s", up ? ssid : L("not connected", "ไม่ได้เชื่อมต่อ"));
        readOnly(CX1, cy, v);
        cy = beginRow(L("Signal", "ความแรงสัญญาณ"), nullptr, true);
        if (up) snprintf(v, sizeof(v), "%d dBm  %s", WiFi.RSSI(), signalQuality(WiFi.RSSI()));
        readOnly(CX1, cy, up ? v : "-");
        cy = beginRow("IP", nullptr, true);
        readOnly(CX1, cy, up ? WiFi.localIP().toString().c_str() : "-");
        cy = beginRow("MAC", nullptr, true);
        readOnly(CX1, cy, WiFi.macAddress().c_str());
        cy = beginRow(L("Access point", "แอคเซสพอยต์"), L("Strongest one for this network", "ตัวที่สัญญาณแรงที่สุด"), true);
        if (up) snprintf(v, sizeof(v), "%s  ch %ld", WiFi.BSSIDstr().c_str(), static_cast<long>(WiFi.channel()));
        readOnly(CX1, cy, up ? v : "-");
        cy = beginRow(L("Reconnect", "เชื่อมต่อใหม่"), L("Restart the network link", "รีสตาร์ทการเชื่อมต่อเครือข่าย"), true);
        actionButton(CX1, cy, L("Reconnect", "เชื่อมต่อใหม่"), C_RECONNECT);
    } else if (section == 3) {
        const char *title = hasData ? (details["title"] | "") : "";
        int cy = beginRow(L("Board title", "ชื่อบนจอ"), L("Shown in the header: the company name", "ชื่อที่แสดงบนหัวจอ: ชื่อบริษัท"));
        field(CX1, cy, title, "Kaizen");
        cy = beginRow(L("Device name", "ชื่ออุปกรณ์"), L("Identifies this panel", "ใช้ระบุจอนี้"));
        field(CX1, cy, "nnr_esp", "");
        cy = beginRow(L("Location", "ตำแหน่งติดตั้ง"), L("e.g. Lobby, Kitchen", "เช่น ล็อบบี้, ครัว"));
        field(CX1, cy, "", L("Lobby", "ล็อบบี้"));
        cy = beginRow(L("Sound on critical case", "เสียงเตือนเคสวิกฤต"), L("Needs a speaker on the board header", "ต้องมีลำโพงต่อกับบอร์ด"), true);
        toggle(CX1, cy, false, C_SOUND, false);
        const bool rebootArmed = armed == C_REBOOT && millis() < armedUntil;
        cy = beginRow(L("Reboot", "รีสตาร์ท"), rebootArmed ? L("Tap again to reboot", "แตะอีกครั้งเพื่อรีสตาร์ท") : nullptr, true);
        actionButton(CX1, cy, rebootArmed ? L("Tap again", "แตะอีกครั้ง") : L("Reboot", "รีสตาร์ท"), C_REBOOT, rebootArmed);
        const bool resetArmed = armed == C_RESET && millis() < armedUntil;
        cy = beginRow(L("Factory reset", "ล้างค่าทั้งหมด"),
                      resetArmed ? L("Tap again: clears this panel's settings and restarts", "แตะอีกครั้ง: ล้างการตั้งค่าของจอนี้และรีสตาร์ท")
                                 : L("Clears this panel's settings", "ลบการตั้งค่าของจอนี้"), true);
        actionButton(CX1, cy, resetArmed ? L("Tap again", "แตะอีกครั้ง") : L("Reset", "ล้างค่า"), C_RESET, true);
    } else {
        int cy = beginRow(L("Model", "รุ่น"), nullptr, true);
        readOnly(CX1, cy, "Guition JC8048W550");
        cy = beginRow("SoC", nullptr, true);
        snprintf(v, sizeof(v), "%s (dual-core @ %lu MHz)", ESP.getChipModel(), static_cast<unsigned long>(ESP.getCpuFreqMHz()));
        readOnly(CX1, cy, v);
        cy = beginRow(L("Radio", "ไร้สาย"), nullptr, true);
        readOnly(CX1, cy, "Wi-Fi 2.4 GHz (on-chip)");
        cy = beginRow(L("Firmware", "เฟิร์มแวร์"), nullptr, true);
        readOnly(CX1, cy, "nnr_esp - " __DATE__);
        cy = beginRow("PSRAM", nullptr, true);
        snprintf(v, sizeof(v), "%.0f MB (%.1f MB free)", ESP.getPsramSize() / 1048576.0f, ESP.getFreePsram() / 1048576.0f);
        readOnly(CX1, cy, v);
        cy = beginRow("Flash", nullptr, true);
        snprintf(v, sizeof(v), "%lu MB (firmware %.1f MB)", static_cast<unsigned long>(ESP.getFlashChipSize() >> 20), ESP.getSketchSize() / 1048576.0f);
        readOnly(CX1, cy, v);
        cy = beginRow(L("Uptime", "เวลาทำงาน"), nullptr, true);
        const unsigned long s = millis() / 1000;
        snprintf(v, sizeof(v), "%lud %02lu:%02lu", s / 86400, s / 3600 % 24, s / 60 % 60);
        readOnly(CX1, cy, v);
        cy = beginRow(L("Temperature", "อุณหภูมิ"), nullptr, true);
        snprintf(v, sizeof(v), "%.0f °C", temperatureRead());
        readOnly(CX1, cy, v);
        cy = beginRow(L("Firmware update", "อัปเดตเฟิร์มแวร์"), L("Over USB for now; no OTA server yet", "ผ่าน USB เท่านั้น ยังไม่มีเซิร์ฟเวอร์ OTA"), true);
        actionButton(CX1, cy, L("Check", "ตรวจสอบ"), C_OTA, false, false);
    }
}

void drawDashboard();
void openSettings() {
    drill.open = false;
    settingsOpen = true;
    settingsTouched = millis();
    armed = 0;
    drawSettings();
}
void closeSettings() {
    settingsOpen = false;
    drawDashboard();
}

void applyRotation() {
    rotated180 = cfg.rotated;
    screen.setRotation(cfg.rotated ? 2 : 0);
}

void setLanguage(bool th);
// Finger moves on a slider drag it; everything else acts on finger-down.
int dragging = 0;
Rect dragRect;
void sliderDrag(int x) {
    const int v = sliderValue(dragRect, x);
    int &target = dragging == C_BRIGHT ? cfg.brightness : cfg.nightLevel;
    if (v == target) return;
    target = v;
    applyBrightness();
    // Redraw just the slider; keep the control list as it was.
    const int saved = ctlCount;
    slider(CX1, dragRect.y + dragRect.h / 2, v, dragging);
    ctlCount = saved;
}

void settingsTap(int x, int y) {
    settingsTouched = millis();
    for (int i = 0; i < ctlCount; ++i) {
        const Control &c = ctls[i];
        if (!c.r.hit(x, y)) continue;
        const bool confirm = armed == c.id && millis() < armedUntil;
        if (c.id != C_REBOOT && c.id != C_RESET) armed = 0;
        switch (c.id) {
            case C_CLOSE: closeSettings(); return;
            case C_TAB: section = c.aux; break;
            case C_BRIGHT: case C_NIGHT_LVL:
                dragging = c.id;
                dragRect = c.r;
                (c.id == C_BRIGHT ? cfg.brightness : cfg.nightLevel) = sliderValue(c.r, x);
                break;
            case C_NIGHT: cfg.nightDim = !cfg.nightDim; break;
            case C_FROM_M: cfg.nightFrom = (cfg.nightFrom + 1440 - 30) % 1440; break;
            case C_FROM_P: cfg.nightFrom = (cfg.nightFrom + 30) % 1440; break;
            case C_TO_M: cfg.nightTo = (cfg.nightTo + 1440 - 30) % 1440; break;
            case C_TO_P: cfg.nightTo = (cfg.nightTo + 30) % 1440; break;
            case C_ORIENT:
                if (cfg.rotated != (c.aux == 180)) { cfg.rotated = c.aux == 180; applyRotation(); }
                break;
            case C_LANG: saveSettings(); setLanguage(c.aux == 1); return;
            case C_REFRESH: cfg.refreshSecs = c.aux; nextPoll = millis(); break;
            case C_TOUCH: cfg.touch = !cfg.touch; break;
            case C_IDLE: cfg.idleSecs = c.aux; break;
            case C_RECONNECT:
                setNote(L("Reconnecting...", "กำลังเชื่อมต่อใหม่..."));
                drawSettings();
                WiFi.disconnect();
                connectStrongest();
                break;
            case C_FIELD: setNote(L("No keyboard on this panel yet", "จอนี้ยังไม่มีแป้นพิมพ์")); break;
            case C_SOUND: setNote(L("No speaker on this panel yet", "จอนี้ยังไม่มีลำโพง")); break;
            case C_OTA: setNote(L("Update over USB for now", "อัปเดตผ่าน USB เท่านั้น")); break;
            case C_REBOOT: case C_RESET:
                if (confirm) {
                    if (c.id == C_RESET) prefs.clear();
                    else saveSettings();
                    screen.fillScreen(BG);
                    labelCenter(400, 236, L("Restarting...", "กำลังรีสตาร์ท..."), 2, TEXT);
                    delay(300);
                    ESP.restart();
                }
                armed = c.id;
                armedUntil = millis() + 4000;
                break;
        }
        saveSettings();
        applyBrightness();
        drawSettings();
        return;
    }
}

// ── Hotel board: mirrors src/components/HotelBoard.tsx ──────────────────────
// The endpoint sends display-ready strings, baht sign included.
int richWidth(const char *s, int size) { return textWidth(s, size); }
void rich(int x, int y, const char *s, int size, uint16_t color) { label(x, y, s, size, color); }
void richRight(int right, int y, const char *s, int size, uint16_t color) { labelRight(right, y, s, size, color); }
void subLine(int x, int y, const char *s, uint16_t color) { label(x, y, s, 1, color); }
constexpr uint16_t BAR_FORECAST = rgb(0x3e4654);  // rgba(255,255,255,0.18) on CARD

void drawHotel() {
    JsonObjectConst hotel = details["hotel"].as<JsonObjectConst>();
    const char *state = hotel["state"] | "loading";
    if (strcmp(state, "ready") != 0) {
        card(PAD, KPI_Y, 800 - 2 * PAD, ROW_B_Y + ROW_B_H - KPI_Y);
        const bool error = strcmp(state, "error") == 0;
        labelCenter(400, (KPI_Y + ROW_B_Y + ROW_B_H) / 2 - 4,
                    error ? L("Can't read hotel data", "อ่านข้อมูลไม่ได้")
                    : strcmp(state, "empty") == 0
                        ? L("No report uploaded yet - add one on the Hotel Reports page",
                            "ยังไม่มีข้อมูล - อัปโหลด PDF ที่หน้า \"รายงานโรงแรม\"")
                        : L("Loading...", "กำลังโหลด..."),
                    1, error ? C_CRITICAL : MUTED);
        return;
    }

    // KPI row: six tiles, value / label / sub-line
    int i = 0;
    for (JsonObjectConst tile : hotel["tiles"].as<JsonArrayConst>()) {
        if (i == 6) break;
        const Rect r = kpiRect(i++);
        card(r.x, r.y, r.w, r.h);
        const char *value = tile["value"] | "-";
        const int size = richWidth(value, 3) <= r.w - 14 ? 3 : 2;
        rich(r.x + 7, r.y + (size == 3 ? 7 : 11), value, size, parseColor(tile["color"] | "", TEXT));
        char name[96], sub[96];
        upper(name, sizeof(name), pick(tile, "label", "labelTh"));
        copyText(sub, sizeof(sub), pick(tile, "sub", "subTh"));
        if (isAscii(name)) label(r.x + 7, r.y + 36, name, 0, MUTED);
        else utext(r.x + 7, r.y + 30, name, MUTED, r.w - 10);
        subLine(r.x + 7, r.y + 51, sub, MUTED);
    }

    // Occupancy forecast, next 14 days (0-100 %)
    {
        const int x = PAD, y = ROW_A_Y, w = LEFT_W, h = ROW_A_H;
        panelBox(x, y, w, h, L("OCCUPANCY FORECAST - NEXT 14 DAYS", "พยากรณ์การเข้าพัก 14 วัน"));
        JsonArrayConst days = hotel["forecast"].as<JsonArrayConst>();
        if (days.size() == 0) {
            labelCenter(x + w / 2, y + h / 2, L("No forecast in this report", "ไม่มีข้อมูลพยากรณ์"), 1, MUTED);
        } else {
            const int base = y + h - 20, area = h - 20 - 42;
            const int slot = (w - 20) / 14, barW = slot * 3 / 5;
            int d = 0;
            for (JsonObjectConst day : days) {
                if (d == 14) break;
                const int bx = x + 10 + d * slot + (slot - barW) / 2;
                const float p = constrain(day["pct"] | 0.0f, 0.0f, 100.0f);
                const int bh = static_cast<int>(area * p / 100.0f);
                if (bh > 0) aaRoundRect(bx, base - bh, barW, bh, min(3, bh / 2), d == 0 ? BRAND : BAR_FORECAST);
                char v[8];
                snprintf(v, sizeof(v), "%d", static_cast<int>(lroundf(day["pct"] | 0.0f)));
                labelCenter(bx + barW / 2, base - bh - 10, v, 1, TEXT);
                char lab[4];
                copyText(lab, sizeof(lab), day["label"] | "", 2);
                labelCenter(bx + barW / 2, base + 6, lab, 1, MUTED);
                ++d;
            }
        }
    }

    // Today
    {
        const int x = RIGHT_X, y = ROW_A_Y, w = RIGHT_W, h = ROW_A_H;
        panelBox(x, y, w, h, L("TODAY", "วันนี้"));
        int ry = y + 32;
        for (JsonObjectConst r : hotel["today"].as<JsonArrayConst>()) {
            label(x + 12, ry + 4, pick(r, "label", "labelTh"), 1, MUTED);
            richRight(x + w - 12, ry, r["value"] | "-", 2, parseColor(r["color"] | "", TEXT));
            ry += 24;
        }
        char when[80];
        snprintf(when, sizeof(when), "%s %s", L("Figures for", "ข้อมูลวันที่"), hotel["statDateLabel"] | (hotel["statDate"] | ""));
        label(x + 12, y + h - 16, when, 1, TEXT);
    }

    // Occupancy outlook: four windows
    {
        const int x = PAD, y = ROW_B_Y, w = LEFT_W, h = ROW_B_H;
        panelBox(x, y, w, h, L("OCCUPANCY OUTLOOK", "อัตราการเข้าพักล่วงหน้า"));
        const int cw = (w - 20 - 3 * 12) / 4;
        int c = 0;
        for (JsonObjectConst win : hotel["outlook"].as<JsonArrayConst>()) {
            if (c == 4) break;
            const int cx = x + 10 + c++ * (cw + 12);
            char text[16], name[96], counts[24];
            copyText(text, sizeof(text), win["pctText"] | "-", 10);
            upper(name, sizeof(name), pick(win, "label", "labelTh"));
            snprintf(counts, sizeof(counts), "%d / %d", win["occ"] | 0, win["avail"] | 0);
            label(cx, y + 32, text, 2, TEXT);
            label(cx, y + 55, name, 0, MUTED);
            label(cx, y + 69, counts, 1, MUTED);
            aaRoundRect(cx, y + 84, cw, 6, 3, BORDER);
            const float p = constrain(win["pct"] | 0.0f, 0.0f, 100.0f);
            const int fill = static_cast<int>(cw * p / 100.0f);
            if (fill > 0) aaRoundRect(cx, y + 84, max(6, fill), 6, 3, BRAND);
        }
    }

    // Today's revenue split
    {
        const int x = RIGHT_X, y = ROW_B_Y, w = RIGHT_W, h = ROW_B_H;
        panelBox(x, y, w, h, L("TODAY'S REVENUE SPLIT", "รายได้วันนี้ตามหมวด"));
        int ry = y + 34;
        const int labelW = thai ? 104 : 60, valueW = 48;
        const int trackX = x + 10 + labelW + 6;
        const int trackW = w - 20 - labelW - 6 - valueW - 6;
        for (JsonObjectConst r : hotel["revenue"].as<JsonArrayConst>()) {
            const char *name = pick(r, "label", "labelTh");
            if (isAscii(name)) label(x + 10, ry, name, 1, MUTED);
            else utext(x + 10, ry - 4, name, MUTED, labelW);
            aaRoundRect(trackX, ry - 1, trackW, 10, 5, TRACK);
            const float ratio = constrain(r["ratio"] | 0.0f, 0.0f, 1.0f);
            const int fill = static_cast<int>(trackW * ratio);
            if (fill > 0) aaRoundRect(trackX, ry - 1, max(10, fill), 10, 5, parseColor(r["color"] | "", BRAND));
            richRight(x + w - 10, ry, r["value"] | "-", 1, TEXT);
            ry += 22;
        }
    }
}

// ── Screens and taps ─────────────────────────────────────────────────────────
void drawDashboard() {
    screen.fillScreen(BG);
    drawHeader();
    if (current == Screen::Kaizen) {
        drawKpis();
        drawTrend();
        drawOverview();
        drawAttention();
        drawCategories();
    } else {
        drawHotel();
    }
    drawSwitcher();
    drawStatus();
    if (drill.open) drawDrill();
    if (settingsOpen) drawSettings();
}

void showScreen(Screen next) {
    if (next == current && !drill.open && !settingsOpen) return;
    drill.open = false;
    settingsOpen = false;
    current = next;
    drawDashboard();
}

void kaizenTap(int x, int y) {
    if (!hasData || !cfg.touch) return;  // "Touch drill-down" off: display-only, as on the web
    // KPI tiles: an empty bucket is not a drill target, as on the web board.
    for (size_t i = 0; i < METRIC_COUNT; ++i) {
        if (kpiRect(i).in(x, y)) {
            if (values[i] > 0) openDrill('s', METRICS[i].drillKey, L(METRICS[i].en, METRICS[i].th), METRICS[i].color);
            return;
        }
    }
    int i = 0;
    for (JsonObjectConst item : details["attentionItems"].as<JsonArrayConst>()) {
        if (i == 3) break;
        if (attentionRow(i++).in(x, y)) {
            openDrill('a', "attention", L("Needs Attention", "ต้องดำเนินการ"), C_CRITICAL, item["id"] | "");
            return;
        }
    }
    i = 0;
    for (JsonObjectConst r : details["categories"].as<JsonArrayConst>()) {
        if (categoryRow(i++).in(x, y)) {
            const bool orphan = strcmp(r["slug"] | "", "__other__") == 0;
            openDrill('c', r["slug"] | "", orphan ? L("Other", "อื่นๆ") : (r["label"] | ""),
                      parseColor(r["color"] | "", BRAND));
            return;
        }
    }
}

void setLanguage(bool th) {
    if (thai == th) return;
    thai = th;
    prefs.putBool("thai", thai);
    Serial.printf("Language: %s\n", thai ? "Thai" : "English");
    drawDashboard();
}

void handleTap(int x, int y) {
    lastTouch = millis();
    Serial.printf("Tap %d,%d\n", x, y);
    if (settingsOpen) {
        settingsTap(x, y);
        return;
    }
    if (drill.open) {
        drillTap(x, y);
        return;
    }
    if (y >= SWITCH_Y && y < SWITCH_Y + SWITCH_H) {
        const int slot = (x - PAD) / (SWITCH_W + GAP);
        if (x < PAD || slot > 4 || (x - PAD) % (SWITCH_W + GAP) >= SWITCH_W) return;  // gap between buttons
        if (slot == 0) showScreen(Screen::Kaizen);
        else if (slot == 1) showScreen(Screen::Hotel);
        else if (slot == 4) openSettings();
        return;
    }
    if (current == Screen::Kaizen) kaizenTap(x, y);
}

// ── Data ─────────────────────────────────────────────────────────────────────
bool fetchDashboard() {
    JsonDocument filter;
    for (const Metric &metric : METRICS) filter[metric.key] = true;
    for (const char *key : {"title", "month", "resolutionRate", "avgResolution", "reopened",
                            "monthly", "categories", "attentionItems", "hotel"}) {
        filter[key] = true;
    }
    JsonDocument data;
    const int code = getJson(DISPLAY_URL, data, &filter);
    int updated[METRIC_COUNT];
    bool valid = code == HTTP_CODE_OK;
    for (size_t i = 0; valid && i < METRIC_COUNT; ++i) {
        JsonVariant value = data[METRICS[i].key];
        valid = value.is<int>() && value.as<int>() >= 0;
        if (valid) updated[i] = value.as<int>();
    }
    const int rate = data["resolutionRate"] | -1;
    valid = valid && rate >= 0 && rate <= 100;
    if (valid) {
        details = std::move(data);
        memcpy(values, updated, sizeof(values));
        hasData = true;
        lastSuccess = millis();
    } else {
        Serial.printf("Dashboard fetch failed (HTTP %d)\n", code);
    }
    return valid;
}

// ── Wi-Fi management ─────────────────────────────────────────────────────────
// "Qhouse Main_2.4G" is served by more than one access point. Left to itself
// the ESP32 joins whichever it hears first and never roams, so pick the
// strongest explicitly by BSSID.
uint32_t joinStarted = 0;
void connectStrongest() {
    ApChoice best;
    if (strongestAp(best)) {
        Serial.printf("Joining strongest AP %02X:%02X:%02X:%02X:%02X:%02X  ch %ld  %ld dBm\n",
                      best.bssid[0], best.bssid[1], best.bssid[2], best.bssid[3], best.bssid[4],
                      best.bssid[5], (long)best.channel, (long)best.rssi);
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD, best.channel, best.bssid);
    } else {
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    joinStarted = millis();
}

// Pinning a BSSID means auto-reconnect only retries that one AP, so if the link
// stays down, scan again and take whichever is strongest now. While connected
// but weak, check every few minutes for a clearly stronger AP.
void manageWifi() {
    static uint32_t lastConnected = 0, lastRoamCheck = 0;
    static bool wasConnected = false;
    const bool connected = WiFi.status() == WL_CONNECTED;
    if (connected) {
        lastConnected = millis();
        // SNTP started before the network was up can sit in back-off for
        // minutes; restart it each time the link comes up.
        if (!wasConnected) configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
    }
    wasConnected = connected;

    if (!connected && millis() - joinStarted > REJOIN_AFTER_MS && millis() - lastConnected > REJOIN_AFTER_MS) {
        Serial.println("Wi-Fi down; rescanning");
        WiFi.disconnect();
        connectStrongest();
        return;
    }
    if (!connected || millis() - lastRoamCheck < ROAM_CHECK_MS) return;
    lastRoamCheck = millis();
    const int rssi = WiFi.RSSI();
    if (rssi >= ROAM_BELOW_DBM) return;
    ApChoice best;
    if (strongestAp(best) && best.rssi >= rssi + ROAM_MARGIN_DB && memcmp(best.bssid, WiFi.BSSID(), 6) != 0) {
        Serial.printf("Roaming: %d dBm here, %ld dBm on ch %ld\n", rssi, (long)best.rssi, (long)best.channel);
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD, best.channel, best.bssid);
        joinStarted = millis();
    }
}

// ── Arduino ──────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    prefs.begin("nnr_esp", false);
    loadSettings();
    thai = prefs.getBool("thai", false);
    ledcSetup(BL_CHANNEL, BL_FREQ_HZ, 8);
    ledcAttachPin(BACKLIGHT, BL_CHANNEL);
    ledcWrite(BL_CHANNEL, 0);
    if (!screen.begin()) {
        Serial.println("LCD initialization failed");
        return;
    }
    fb = screen.getFramebuffer();
    touchBegin();
    applyRotation();
    drawDashboard();
    applyBrightness();
    if (!WIFI_SSID[0] || !DISPLAY_TOKEN[0] || !ROOT_CA[0] || strncmp(DISPLAY_URL, "https://", 8) != 0) {
        status = Status::Unconfigured;
        drawDashboard();
        return;
    }
    // Keep the Wi-Fi config out of NVS. Otherwise begin() sees the same
    // SSID/password already stored there and skips applying the new config.
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    // Modem sleep makes the radio miss beacons, which on a marginal link turns
    // into dropped connections and TLS timeouts. A wall panel is mains powered.
    WiFi.setSleep(false);
    WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
    WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
    WiFi.setAutoReconnect(true);
    connectStrongest();
}

void serialCommand(int cmd) {
    if (cmd > ' ') Serial.printf("Command %c\n", cmd);
    // S = screenshot. For testing without touching the panel:
    // K / H = Kaizen / Hotel, T = settings (1-5 pick a tab, N toggles night dim),
    // L = toggle language,
    // D = open the Total drill-down, E = expand its first case, X = close it.
    if (cmd == 'S') dumpScreen();
    else if (cmd == 'K') showScreen(Screen::Kaizen);
    else if (cmd == 'H') { lastTouch = millis(); showScreen(Screen::Hotel); }
    else if (cmd == 'T') openSettings();
    else if (cmd >= '1' && cmd <= '5' && settingsOpen) { section = cmd - '1'; settingsTouched = millis(); drawSettings(); }
    else if (cmd == 'N' && settingsOpen) { cfg.nightDim = !cfg.nightDim; saveSettings(); applyBrightness(); drawSettings(); }
    else if (cmd == 'L') setLanguage(!thai);
    else if (cmd == 'D' && hasData) { showScreen(Screen::Kaizen); openDrill('s', "total", L(METRICS[0].en, METRICS[0].th), TEXT); }
    else if (cmd == 'E' && drill.open && drill.rows > 0) drillTap(drill.rowRect[0].x + 40, drill.rowRect[0].y + 10);
    else if (cmd == 'X' && drill.open) closeDrill();
}

void loop() {
    if (Serial.available()) serialCommand(Serial.read());
    int tx, ty;
    const Touch ev = touchPoll(tx, ty);
    if (ev == Touch::Down) handleTap(tx, ty);
    else if (ev == Touch::Move && dragging && settingsOpen) { settingsTouched = millis(); sliderDrag(tx); }
    else if (ev == Touch::Up && dragging) { dragging = 0; saveSettings(); }
    if (drill.open && millis() - drill.touched > drillIdleMs()) closeDrill();
    if (settingsOpen && millis() - settingsTouched > SETTINGS_IDLE_MS) closeSettings();
    if (settingsOpen && note[0] && millis() > noteUntil) { note[0] = 0; drawSettings(); }
    if (settingsOpen && armed && millis() > armedUntil) { armed = 0; drawSettings(); }
    if (current != Screen::Kaizen && !settingsOpen && millis() - lastTouch > IDLE_RETURN_MS) showScreen(Screen::Kaizen);
    if (WiFi.getMode() != WIFI_STA) {
        delay(20);
        return;
    }
    if (static_cast<int32_t>(millis() - nextPoll) >= 0) {
        const bool connected = WiFi.status() == WL_CONNECTED;
        const bool clockReady = time(nullptr) > 1700000000;
        const bool success = connected && clockReady && fetchDashboard();
        if (connected) {
            Serial.printf("Wi-Fi ok, RSSI %d dBm, ch %ld, AP %s, fetch %s\n", WiFi.RSSI(),
                          (long)WiFi.channel(), WiFi.BSSIDstr().c_str(),
                          success ? "ok" : !clockReady ? "waiting for clock" : "failed");
        }
        status = success ? Status::Live : hasData ? Status::Stale : !connected ? Status::NoWifi
                 : !clockReady ? Status::NoClock : Status::Unavailable;
        // Don't repaint the board under an open list or settings; it refreshes on close.
        if (!drill.open && !settingsOpen) drawDashboard();
        nextPoll = millis() + (success ? pollMs() : RETRY_MS);
    }
    static uint32_t lastTick = 0;
    if (settingsOpen) {
        if (millis() - lastTick >= 10000) { applyBrightness(); lastTick = millis(); }
    } else if (drill.open) {
        if (millis() - lastTick >= 500) { drawIdleBar(); lastTick = millis(); }
    } else if (millis() - lastTick >= 10000) {
        drawHeader();
        drawStatus();  // live signal readout, so the panel can be positioned by eye
        applyBrightness();  // night dim follows the clock
        lastTick = millis();
    }
    manageWifi();
    delay(20);  // short, so taps feel immediate
}
