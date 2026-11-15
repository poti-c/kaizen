#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>

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
constexpr uint32_t POLL_MS = 60000;
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

// Which board is on screen. Kaizen is home; the others time out back to it.
enum class Screen { Kaizen, Hotel, Settings };
Screen current = Screen::Kaizen;
uint32_t lastTouch = 0;
int brightness = 100;  // percent, kept in NVS
Preferences prefs;

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
int uwidth(const char *s) {
    int w = 0;
    while (*s) w += cpWidth(nextCp(s));
    return w;
}
// Where a combining mark is drawn relative to the cursor after its base letter,
// and how far a tone mark is lifted when it sits on an upper vowel.
constexpr int MARK_DX = -8;  // Unifont marks are full 8 px cells: overlay the base's cell
constexpr int TONE_RAISE = 3;
void glyph(int x, int baseline, const char *from, const char *to) {
    char buf[5];
    const size_t n = min<size_t>(to - from, 4);
    memcpy(buf, from, n);
    buf[n] = 0;
    screen.setCursor(x, baseline);
    screen.print(buf);
}
// Draws one line of Unifont text with its top at `top`; clips with an ellipsis
// at maxW. Returns the width drawn.
int utext(int x, int top, const char *s, uint16_t color, int maxW = 10000) {
    screen.setFont(u8g2_font_unifont_h_utf8);
    screen.setUTF8Print(true);
    screen.setTextSize(1);
    screen.setTextColor(color);
    const int baseline = top + 14;
    const bool clip = uwidth(s) > maxW;
    static const char ELLIPSIS[] = "\xE2\x80\xA6";
    int cx = x;
    uint32_t prev = 0;
    while (*s) {
        const char *from = s;
        const uint32_t cp = nextCp(s);
        if (cp == '\n') continue;
        const int w = cpWidth(cp);
        if (w == 0) {
            const int lift = thaiTone(cp) && thaiUpperVowel(prev) ? TONE_RAISE : 0;
            glyph(cx + MARK_DX, baseline - lift, from, s);
            prev = cp;
            continue;
        }
        if (clip && cx + w > x + maxW - 8) {
            glyph(cx, baseline, ELLIPSIS, ELLIPSIS + 3);
            cx += 8;
            break;
        }
        glyph(cx, baseline, from, s);
        cx += w;
        prev = cp;
    }
    screen.setUTF8Print(false);
    screen.setFont(static_cast<const GFXfont *>(nullptr));
    return cx - x;
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
            const int cw = cpWidth(cp);
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

int textWidth(const char *s, int size) { return isAscii(s) ? strlen(s) * 6 * size : uwidth(s); }
// ASCII in the built-in font at `size`; anything else in Unifont, centred on
// the same line so English and Thai labels sit in the same place.
void label(int x, int y, const char *text, int size, uint16_t color) {
    if (!isAscii(text)) {
        utext(x, y + 4 * size - 8, text, color);
        return;
    }
    screen.setCursor(x, y);
    screen.setTextSize(size);
    screen.setTextColor(color);
    screen.print(text);
}
void labelRight(int right, int y, const char *text, int size, uint16_t color) {
    label(right - textWidth(text, size), y, text, size, color);
}
void labelCenter(int cx, int y, const char *text, int size, uint16_t color) {
    label(cx - textWidth(text, size) / 2, y, text, size, color);
}
// Copies printable text, keeping UTF-8 (Unifont draws it) but dropping control
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
int pill(int x, int y, const char *text, uint16_t fg, uint16_t bg, int h = 18) {
    const int w = textWidth(text, 1) + 12;
    screen.fillRoundRect(x, y, w, h, 4, bg);
    label(x + 6, y + (h - 8) / 2, text, 1, fg);
    return w;
}
const char *pick(JsonObjectConst o, const char *en, const char *th) {
    const char *v = thai ? (o[th] | static_cast<const char *>(nullptr)) : nullptr;
    return v ? v : (o[en] | "");
}

void card(int x, int y, int w, int h) {
    screen.fillRoundRect(x, y, w, h, 9, BORDER);
    screen.fillRoundRect(x + 1, y + 1, w - 2, h - 2, 8, CARD);
}
void panelBox(int x, int y, int w, int h, const char *title) {
    card(x, y, w, h);
    label(x + 10, y + 10, title, 1, MUTED);
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
    bx += pill(bx, 11, L("DASHBOARD", "แดชบอร์ด"), TEXT, BRAND, 17) + 6;
    if (hasData && millis() - lastSuccess > 3 * POLL_MS) {
        bx += pill(bx, 11, L("STALE", "ข้อมูลค้าง"), C_PENDING, rgb(0x3a2e17), 17) + 6;
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
                pill(bx, 11, tag, C_PENDING, rgb(0x3a2e17), 17);
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
        label(r.x + 10, r.y + 48, L(METRICS[i].en, METRICS[i].th), 1, MUTED);
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
        if (bh > 0) screen.fillRoundRect(bx, base - bh, barW, bh, min(3, bh / 2), i == 8 ? BRAND : BAR_PAST);
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
        screen.fillCircle(cx, cy, outer, TRACK);
        screen.fillCircle(cx, cy, inner, CARD);
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
    for (int dy = -outer; dy <= outer; ++dy) {
        for (int dx = -outer; dx <= outer; ++dx) {
            const int r2 = dx * dx + dy * dy;
            if (r2 > outer * outer || r2 < inner * inner) continue;
            float deg = atan2f(static_cast<float>(dx), static_cast<float>(-dy)) * RAD_TO_DEG;
            if (deg < 0) deg += 360.0f;
            for (int i = 0; i < n; ++i) {
                if (counts[i] > 0 && deg >= start[i] && deg < end[i]) {
                    screen.drawPixel(cx + dx, cy + dy, colors[i]);
                    break;
                }
            }
        }
    }
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
        screen.fillCircle(cx, cy, 50, TRACK);
        screen.fillCircle(cx, cy, 34, CARD);
        labelCenter(cx, cy - 4, L("No data", "ไม่มีข้อมูล"), 1, MUTED);
    }
    for (int i = 0; i < 5; ++i) {
        const int ly = y + 40 + i * 19;
        screen.fillRoundRect(x + 136, ly, 8, 8, 2, colors[i]);
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
        screen.fillRoundRect(r.x, r.y, r.w, r.h, 5, ROW);
        screen.fillCircle(r.x + 10, r.y + 12, 3, tone);
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
        const int tx = r.x + 20 + 16 * 6;
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
        screen.fillRoundRect(trackX, ry - 1, trackW, 10, 5, TRACK);
        const int fill = max(10, static_cast<int>(static_cast<int64_t>(trackW) * r["count"].as<int>() / maximum));
        screen.fillRoundRect(trackX, ry - 1, fill, 10, 5, parseColor(r["color"] | "", BRAND));
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
    screen.fillCircle(x + 6, y + 6, 4, c);
    screen.fillCircle(x + 6, y + 6, 2, bg);
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
        const bool active = (i == 0 && current == Screen::Kaizen) || (i == 1 && current == Screen::Hotel) ||
                            (i == 4 && current == Screen::Settings);
        if (active) screen.fillRoundRect(x, y, SWITCH_W, h, 9, BRAND);
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
        case Status::Live: return L("Live  |  Refreshes every minute", "ออนไลน์  |  อัปเดตทุก 1 นาที");
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

// True once per finger-down, with the point mapped to screen pixels.
bool touchTapped(int &x, int &y) {
    static bool down = false;
    if (!gtAddr) return false;
    uint8_t st;
    if (!gtRead(0x814E, &st, 1) || !(st & 0x80)) return false;  // no new report
    const uint8_t points = st & 0x0F;
    uint8_t p[4];
    const bool havePoint = points > 0 && gtRead(0x8150, p, 4);
    gtClear();
    if (!havePoint) { down = false; return false; }
    if (down) return false;
    down = true;
    x = static_cast<int>((p[0] | p[1] << 8) * 800L / gtMaxX);
    y = static_cast<int>((p[2] | p[3] << 8) * 480L / gtMaxY);
    if (TOUCH_FLIP_X) x = 799 - x;
    if (TOUCH_FLIP_Y) y = 479 - y;
    return true;
}

// ── Backlight ────────────────────────────────────────────────────────────────
// Eyes judge brightness logarithmically: a linear 60% duty looks almost like
// 100%. Map the percentage through a 2.2 gamma so each step is visible, and
// drive it at a few hundred Hz, which the board's backlight driver follows.
constexpr int BL_CHANNEL = 1;
constexpr int BL_FREQ_HZ = 300;
void applyBrightness() {
    const float f = constrain(brightness, 10, 100) / 100.0f;
    ledcWrite(BL_CHANNEL, max(2, static_cast<int>(lroundf(255.0f * powf(f, 2.2f)))));
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
// closes itself after 30 s without a touch, like the web board, because a panel
// left on a filtered list reads as if that were the whole count.
constexpr uint32_t DRILL_IDLE_MS = 30000;
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
    const uint32_t left = DRILL_IDLE_MS - min<uint32_t>(DRILL_IDLE_MS, millis() - drill.touched);
    const int w = static_cast<int>(static_cast<int64_t>(OW - 4) * left / DRILL_IDLE_MS);
    screen.fillRect(OX + 2, OY + 2, OW - 4, 3, blend(TEXT, BG, 15));
    screen.fillRect(OX + 2, OY + 2, w, 3, drill.color);
}

void arrowButton(const Rect &r, bool up, bool enabled) {
    screen.fillRoundRect(r.x, r.y, r.w, r.h, 8, blend(TEXT, BG, 18));
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
    screen.fillRoundRect(OX, OY, OW, OH, 12, BORDER);
    screen.fillRoundRect(OX + 1, OY + 1, OW - 2, OH - 2, 11, BG);
    drawIdleBar();

    // Title row: colour key, name, count, paging, close
    screen.fillRoundRect(OX + 14, OY + 22, 12, 12, 2, drill.color);
    label(OX + 34, OY + 21, drill.title, 2, TEXT);
    int px = OX + 34 + textWidth(drill.title, 2) + 10;
    char count[48];
    if (thai) snprintf(count, sizeof(count), "%d เคส", drill.count);
    else snprintf(count, sizeof(count), "%d %s", drill.count, drill.count == 1 ? "case" : "cases");
    px += pill(px, OY + 19, count, MUTED, blend(TEXT, BG, 18), 18) + 8;
    screen.fillRoundRect(DRILL_CLOSE.x, DRILL_CLOSE.y, DRILL_CLOSE.w, DRILL_CLOSE.h, 8, blend(TEXT, BG, 18));
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
        screen.fillRoundRect(rx, y, rw, h, 6, ROW_BG);

        // priority · number · title · department · status · age
        screen.fillCircle(rx + 14, y + 17, 4, priorityColor(c["priority"] | ""));
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
        const int tx = rx + 26 + 16 * 6;
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
    if (!casesOk || millis() - casesAt > POLL_MS) {
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

// ── Settings ─────────────────────────────────────────────────────────────────
constexpr int BODY_Y = 56, BODY_H = 340;
constexpr int DISP_H = 150;
constexpr Rect BRIGHT_MINUS = {PAD + LEFT_W - 162, BODY_Y + 30, 48, 36};
constexpr Rect BRIGHT_PLUS = {PAD + LEFT_W - 60, BODY_Y + 30, 48, 36};
constexpr Rect LANG_EN = {PAD + LEFT_W - 222, BODY_Y + 78, 100, 32};
constexpr Rect LANG_TH = {PAD + LEFT_W - 112, BODY_Y + 78, 100, 32};

void settingRow(int x, int w, int y, const char *name, const char *value) {
    label(x + 12, y, name, 1, MUTED);
    labelRight(x + w - 12, y, value, 1, TEXT);
}
void stepButton(const Rect &r, bool plus) {
    screen.fillRoundRect(r.x, r.y, r.w, r.h, 8, TRACK);
    const int cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    screen.fillRect(cx - 8, cy - 1, 16, 3, TEXT);
    if (plus) screen.fillRect(cx - 1, cy - 8, 3, 16, TEXT);
}
void choiceButton(const Rect &r, const char *text, bool active) {
    screen.fillRoundRect(r.x, r.y, r.w, r.h, 8, active ? BRAND : TRACK);
    labelCenter(r.x + r.w / 2, r.y + r.h / 2 - 4, text, 1, active ? TEXT : MUTED);
}

void drawSettings() {
    char v[64];
    panelBox(PAD, BODY_Y, LEFT_W, DISP_H, L("DISPLAY", "หน้าจอ"));
    label(PAD + 12, BODY_Y + 44, L("Brightness", "ความสว่าง"), 2, TEXT);
    stepButton(BRIGHT_MINUS, false);
    stepButton(BRIGHT_PLUS, true);
    snprintf(v, sizeof(v), "%d%%", brightness);
    labelCenter((BRIGHT_MINUS.x + BRIGHT_MINUS.w + BRIGHT_PLUS.x) / 2, BODY_Y + 41, v, 2, TEXT);
    label(PAD + 12, BODY_Y + 90, L("Language", "ภาษา"), 2, TEXT);
    choiceButton(LANG_EN, "English", !thai);
    choiceButton(LANG_TH, "ไทย", thai);
    settingRow(PAD, LEFT_W, BODY_Y + 126, L("Return to Kaizen board after", "กลับหน้าสรุปอัตโนมัติ"),
               L("2 min without touch", "2 นาทีหลังไม่มีการสัมผัส"));

    const int dy = BODY_Y + DISP_H + GAP, dh = BODY_H - DISP_H - GAP;
    panelBox(PAD, dy, LEFT_W, dh, L("DATA", "ข้อมูล"));
    settingRow(PAD, LEFT_W, dy + 34, L("Source", "แหล่งข้อมูล"), "Supabase kaizen-esp-display");
    settingRow(PAD, LEFT_W, dy + 58, L("Company", "บริษัท"), hasData ? (details["title"] | "-") : "-");
    settingRow(PAD, LEFT_W, dy + 82, L("Refresh interval", "รอบดึงข้อมูล"), L("1 min", "1 นาที"));
    if (hasData) {
        const unsigned long ago = (millis() - lastSuccess) / 1000;
        snprintf(v, sizeof(v), thai ? "%lu วินาทีที่แล้ว" : "%lu s ago", ago);
    } else {
        copyText(v, sizeof(v), L("not yet", "ยังไม่มี"));
    }
    settingRow(PAD, LEFT_W, dy + 106, L("Last update", "อัปเดตล่าสุด"), v);
    settingRow(PAD, LEFT_W, dy + 130, L("Device name", "ชื่ออุปกรณ์"), "nnr_esp");

    panelBox(RIGHT_X, BODY_Y, RIGHT_W, BODY_H, L("NETWORK & DEVICE", "เครือข่ายและอุปกรณ์"));
    const bool up = WiFi.status() == WL_CONNECTED;
    int ry = BODY_Y + 34;
    auto row = [&](const char *name, const char *value) { settingRow(RIGHT_X, RIGHT_W, ry, name, value); ry += 24; };
    char ssid[40];
    copyText(ssid, sizeof(ssid), WIFI_SSID, 30);
    row("Wi-Fi", up ? ssid : L("not connected", "ไม่ได้เชื่อมต่อ"));
    if (up) {
        snprintf(v, sizeof(v), "%d dBm %s", WiFi.RSSI(), signalQuality(WiFi.RSSI()));
        row(L("Signal", "ความแรงสัญญาณ"), v);
        snprintf(v, sizeof(v), "%ld", static_cast<long>(WiFi.channel()));
        row(L("Channel", "ช่องสัญญาณ"), v);
        row(L("Access point", "แอคเซสพอยต์"), WiFi.BSSIDstr().c_str());
        row("IP", WiFi.localIP().toString().c_str());
    }
    row("MAC", WiFi.macAddress().c_str());
    const unsigned long upS = millis() / 1000;
    snprintf(v, sizeof(v), "%lud %luh %lum", upS / 86400, upS / 3600 % 24, upS / 60 % 60);
    row(L("Uptime", "เวลาทำงาน"), v);
    snprintf(v, sizeof(v), "%lu KB", static_cast<unsigned long>(ESP.getFreeHeap() / 1024));
    row(L("Free memory", "หน่วยความจำว่าง"), v);
    row(L("Firmware", "เฟิร์มแวร์"), __DATE__);
    row(L("Touch", "ระบบสัมผัส"), gtAddr ? "GT911" : L("not found", "ไม่พบ"));
}

// ── Hotel board: mirrors src/components/HotelBoard.tsx ──────────────────────
// The endpoint sends display-ready strings. Numbers are drawn large in the
// built-in font, which lacks the baht sign, so it is drawn as a B with a stroke.
bool isBaht(const char *s) {
    return static_cast<uint8_t>(s[0]) == 0xE0 && static_cast<uint8_t>(s[1]) == 0xB8 &&
           static_cast<uint8_t>(s[2]) == 0xBF;
}
int richWidth(const char *s, int size) {
    int n = 0;
    while (*s) {
        if (isBaht(s)) { ++n; s += 3; continue; }
        if (*s >= 0x20 && *s < 0x7f) ++n;
        ++s;
    }
    return n * 6 * size;
}
void rich(int x, int y, const char *s, int size, uint16_t color) {
    screen.setTextSize(size);
    screen.setTextColor(color);
    while (*s) {
        if (isBaht(s)) {
            screen.setCursor(x, y);
            screen.print('B');
            screen.fillRect(x + 2 * size, y - size, size, 9 * size, color);
            x += 6 * size;
            s += 3;
            continue;
        }
        if (*s >= 0x20 && *s < 0x7f) {
            screen.setCursor(x, y);
            screen.print(*s);
            x += 6 * size;
        }
        ++s;
    }
}
void richRight(int right, int y, const char *s, int size, uint16_t color) {
    rich(right - richWidth(s, size), y, s, size, color);
}
// Sub-lines mix baht amounts with Thai words: Unifont has both.
void subLine(int x, int y, const char *s, uint16_t color) {
    if (isAscii(s) || (isBaht(s) && isAscii(s + 3))) rich(x, y, s, 1, color);
    else utext(x, y - 4, s, color);
}
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
        if (isAscii(name)) label(r.x + 7, r.y + 36, name, 1, MUTED);
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
                if (bh > 0) screen.fillRoundRect(bx, base - bh, barW, bh, min(3, bh / 2), d == 0 ? BRAND : BAR_FORECAST);
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
            label(cx, y + 55, name, 1, MUTED);
            label(cx, y + 69, counts, 1, MUTED);
            screen.fillRoundRect(cx, y + 84, cw, 6, 3, BORDER);
            const float p = constrain(win["pct"] | 0.0f, 0.0f, 100.0f);
            const int fill = static_cast<int>(cw * p / 100.0f);
            if (fill > 0) screen.fillRoundRect(cx, y + 84, max(6, fill), 6, 3, BRAND);
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
            screen.fillRoundRect(trackX, ry - 1, trackW, 10, 5, TRACK);
            const float ratio = constrain(r["ratio"] | 0.0f, 0.0f, 1.0f);
            const int fill = static_cast<int>(trackW * ratio);
            if (fill > 0) screen.fillRoundRect(trackX, ry - 1, max(10, fill), 10, 5, parseColor(r["color"] | "", BRAND));
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
    } else if (current == Screen::Settings) {
        drawSettings();
    } else {
        drawHotel();
    }
    drawSwitcher();
    drawStatus();
    if (drill.open) drawDrill();
}

void showScreen(Screen next) {
    if (next == current && !drill.open) return;
    drill.open = false;
    current = next;
    drawDashboard();
}

void kaizenTap(int x, int y) {
    if (!hasData) return;
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
    if (drill.open) {
        drillTap(x, y);
        return;
    }
    if (y >= SWITCH_Y && y < SWITCH_Y + SWITCH_H) {
        const int slot = (x - PAD) / (SWITCH_W + GAP);
        if (x < PAD || slot > 4 || (x - PAD) % (SWITCH_W + GAP) >= SWITCH_W) return;  // gap between buttons
        if (slot == 0) showScreen(Screen::Kaizen);
        else if (slot == 1) showScreen(Screen::Hotel);
        else if (slot == 4) showScreen(Screen::Settings);
        return;
    }
    if (current == Screen::Kaizen) {
        kaizenTap(x, y);
        return;
    }
    if (current != Screen::Settings) return;
    if (BRIGHT_MINUS.hit(x, y) || BRIGHT_PLUS.hit(x, y)) {
        brightness = constrain(brightness + (BRIGHT_PLUS.hit(x, y) ? 10 : -10), 10, 100);
        applyBrightness();
        prefs.putUChar("bright", brightness);
        drawDashboard();
    } else if (LANG_EN.hit(x, y)) {
        setLanguage(false);
    } else if (LANG_TH.hit(x, y)) {
        setLanguage(true);
    }
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
    brightness = constrain(static_cast<int>(prefs.getUChar("bright", 100)), 10, 100);
    thai = prefs.getBool("thai", false);
    ledcSetup(BL_CHANNEL, BL_FREQ_HZ, 8);
    ledcAttachPin(BACKLIGHT, BL_CHANNEL);
    ledcWrite(BL_CHANNEL, 0);
    if (!screen.begin()) {
        Serial.println("LCD initialization failed");
        return;
    }
    touchBegin();
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
    // K / H / T = Kaizen / Hotel / settings, L = toggle language,
    // D = open the Total drill-down, E = expand its first case, X = close it.
    if (cmd == 'S') dumpScreen();
    else if (cmd == 'K') showScreen(Screen::Kaizen);
    else if (cmd == 'H') { lastTouch = millis(); showScreen(Screen::Hotel); }
    else if (cmd == 'T') { lastTouch = millis(); showScreen(Screen::Settings); }
    else if (cmd == 'L') setLanguage(!thai);
    else if (cmd == 'D' && hasData) { showScreen(Screen::Kaizen); openDrill('s', "total", L(METRICS[0].en, METRICS[0].th), TEXT); }
    else if (cmd == 'E' && drill.open && drill.rows > 0) drillTap(drill.rowRect[0].x + 40, drill.rowRect[0].y + 10);
    else if (cmd == 'X' && drill.open) closeDrill();
}

void loop() {
    if (Serial.available()) serialCommand(Serial.read());
    int tx, ty;
    if (touchTapped(tx, ty)) handleTap(tx, ty);
    if (drill.open && millis() - drill.touched > DRILL_IDLE_MS) closeDrill();
    if (current != Screen::Kaizen && millis() - lastTouch > IDLE_RETURN_MS) showScreen(Screen::Kaizen);
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
        // Don't repaint the board under an open list; it refreshes on close.
        if (!drill.open) drawDashboard();
        nextPoll = millis() + (success ? POLL_MS : RETRY_MS);
    }
    static uint32_t lastTick = 0;
    if (drill.open) {
        if (millis() - lastTick >= 500) { drawIdleBar(); lastTick = millis(); }
    } else if (millis() - lastTick >= 10000) {
        drawHeader();
        drawStatus();  // live signal readout, so the panel can be positioned by eye
        lastTick = millis();
    }
    manageWifi();
    delay(20);  // short, so taps feel immediate
}
