#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#if __has_include("device_config.h")
#include "device_config.h"
#else
#include "device_config.example.h"
#endif

// Kaizen board of /display (src/pages/DisplayPage.tsx), redrawn natively for an
// 800x480 panel. Data comes from the kaizen-esp-display edge function, which
// computes the same numbers the web board does; this file only draws them.

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
constexpr uint16_t TRACK = rgb(0x20293a);      // rgba(255,255,255,0.06) on CARD
constexpr uint16_t BAR_PAST = rgb(0x39404d);   // rgba(255,255,255,0.16) on CARD
constexpr uint16_t TEXT = rgb(0xe8edf3);
constexpr uint16_t MUTED = rgb(0x8b98ab);
constexpr uint16_t C_OPEN = rgb(0xf97316);
constexpr uint16_t C_PROGRESS = rgb(0x3b82f6);
constexpr uint16_t C_PENDING = rgb(0xf59e0b);
constexpr uint16_t C_RESOLVED = rgb(0x22c55e);
constexpr uint16_t C_CRITICAL = rgb(0xef4444);
constexpr uint16_t BRAND = rgb(0x0891b2);      // Na Nirand primary_color

struct Metric {
    const char *key;
    const char *label;
    uint16_t color;
};
constexpr Metric METRICS[] = {
    {"total", "TOTAL CASES", TEXT},           {"open", "OPEN", C_OPEN},
    {"inProgress", "IN PROGRESS", C_PROGRESS}, {"pending", "WAITING APPROVAL", C_PENDING},
    {"closed", "RESOLVED", C_RESOLVED},        {"overdue", "OVERDUE", C_CRITICAL},
};
constexpr size_t METRIC_COUNT = sizeof(METRICS) / sizeof(METRICS[0]);
int values[METRIC_COUNT];
JsonDocument details;
bool hasData = false;
uint32_t lastSuccess = 0;
const char *screenStatus = "Connecting to Wi-Fi...";
uint32_t nextPoll = 0;

// ── Text helpers (built-in 6x8 font, scaled) ──────────────────────────────────
int textWidth(const char *s, int size) { return strlen(s) * 6 * size; }

void label(int x, int y, const char *text, int size, uint16_t color) {
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
// The built-in font is ASCII only; UTF-8 (Thai) bytes would print as CP437
// junk, so drop them and cap the length to fit the space available.
void ascii(char *out, size_t cap, const char *in, size_t maxChars) {
    size_t n = 0;
    for (; in && *in && n + 1 < cap && n < maxChars; ++in) {
        if (*in >= 0x20 && *in < 0x7f) out[n++] = *in;
    }
    out[n] = 0;
}
uint16_t parseColor(const char *hex, uint16_t fallback) {
    if (!hex || hex[0] != '#' || strlen(hex) != 7) return fallback;
    return rgb(strtoul(hex + 1, nullptr, 16));
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

void drawHeader() {
    screen.fillRect(0, 0, 800, HEADER_H + 2, BG);
    char title[32] = "Kaizen";
    if (hasData) {
        ascii(title, sizeof(title), details["title"] | "", 22);
        if (!title[0]) strcpy(title, "Kaizen");
    }
    label(PAD, 10, title, 3, TEXT);
    int bx = PAD + textWidth(title, 3) + 10;
    screen.fillRoundRect(bx, 11, 66, 17, 3, BRAND);
    label(bx + 6, 16, "DASHBOARD", 1, TEXT);
    bx += 66 + 6;
    if (hasData && millis() - lastSuccess > 3 * POLL_MS) {
        screen.fillRoundRect(bx, 11, 42, 17, 3, rgb(0x3a2e17));
        label(bx + 6, 16, "STALE", 1, C_PENDING);
    }

    char subtitle[96] = "Kaizen System";
    if (hasData) {
        char month[16], avg[16];
        ascii(month, sizeof(month), details["month"] | "", 12);
        ascii(avg, sizeof(avg), details["avgResolution"] | "-", 12);
        snprintf(subtitle, sizeof(subtitle), "%s  |  Avg Resolution %s  |  Resolution Rate %d%%",
                 month, avg, details["resolutionRate"].as<int>());
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

void drawKpis() {
    const int w = (800 - 2 * PAD - 5 * GAP) / 6;
    for (size_t i = 0; i < METRIC_COUNT; ++i) {
        const int x = PAD + i * (w + GAP);
        card(x, KPI_Y, w, KPI_H);
        char number[16] = "--";
        if (hasData) snprintf(number, sizeof(number), "%d", values[i]);
        label(x + 10, KPI_Y + 12, number, strlen(number) <= 4 ? 4 : 3, METRICS[i].color);
        label(x + 10, KPI_Y + 48, METRICS[i].label, 1, MUTED);
    }
}

void drawTrend() {
    const int x = PAD, y = ROW_A_Y, w = LEFT_W, h = ROW_A_H;
    panelBox(x, y, w, h, "MONTHLY CASES");
    JsonArrayConst months = details["monthly"].as<JsonArrayConst>();
    if (months.isNull() || months.size() != 9) {
        labelCenter(x + w / 2, y + h / 2, "Waiting for case history", 1, MUTED);
        return;
    }
    int maximum = 1;
    for (JsonObjectConst m : months) maximum = max(maximum, m["count"].as<int>());
    const int base = y + h - 22;            // bar baseline
    const int area = h - 22 - 44;           // room for value labels above the tallest bar
    const int slot = (w - 20) / 9;
    const int barW = slot * 3 / 5;
    for (int i = 0; i < 9; ++i) {
        const int sx = x + 10 + i * slot;
        const int bx = sx + (slot - barW) / 2;
        const int count = months[i]["count"].as<int>();
        const int bh = static_cast<int>(static_cast<int64_t>(area) * count / maximum);
        if (bh > 0) screen.fillRoundRect(bx, base - bh, barW, bh, min(3, bh / 2), i == 8 ? BRAND : BAR_PAST);
        char value[12];
        snprintf(value, sizeof(value), "%d", count);
        labelCenter(bx + barW / 2, base - bh - 11, value, 1, TEXT);
        char name[8];
        ascii(name, sizeof(name), months[i]["month"] | "", 3);
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
    panelBox(x, y, w, h, "CASE OVERVIEW");
    const int counts[] = {values[1], values[2], values[3], values[4], details["reopened"] | 0};
    const uint16_t colors[] = {C_OPEN, C_PROGRESS, C_PENDING, C_RESOLVED, C_CRITICAL};
    const char *names[] = {"Open", "In Progress", "Waiting Approval", "Resolved", "Reopened"};
    const int cx = x + 64, cy = y + 84;
    if (hasData) {
        drawDonut(cx, cy, 50, 34, counts, colors, 5);
        char total[12];
        snprintf(total, sizeof(total), "%d", values[0]);
        labelCenter(cx, cy - 13, total, total[3] ? 2 : 3, TEXT);
        labelCenter(cx, cy + 13, "Total", 1, MUTED);
    } else {
        screen.fillCircle(cx, cy, 50, TRACK);
        screen.fillCircle(cx, cy, 34, CARD);
        labelCenter(cx, cy - 4, "No data", 1, MUTED);
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

void drawAttention() {
    const int x = PAD, y = ROW_B_Y, w = LEFT_W, h = ROW_B_H;
    panelBox(x, y, w, h, "NEEDS ATTENTION");
    JsonArrayConst items = details["attentionItems"].as<JsonArrayConst>();
    if (items.isNull()) {
        labelCenter(x + w / 2, y + h / 2, "Waiting for case data", 1, MUTED);
        return;
    }
    if (items.size() == 0) {
        labelCenter(x + w / 2, y + h / 2, "Nothing overdue or critical", 1, MUTED);
        return;
    }
    // The web badge counts the rows shown (at most three); mirror it.
    char badge[8];
    snprintf(badge, sizeof(badge), "%u", static_cast<unsigned>(items.size()));
    const int bw = textWidth(badge, 1);
    labelRight(x + w - 12, y + 10, badge, 1, C_CRITICAL);
    screen.fillTriangle(x + w - 22 - bw, y + 17, x + w - 18 - bw, y + 9, x + w - 14 - bw, y + 17, C_CRITICAL);

    int ry = y + 28;
    for (JsonObjectConst item : items) {
        if (ry + 24 > y + h - 4) break;
        const bool overdue = item["overdue"] | false;
        const uint16_t tone = overdue ? C_CRITICAL : C_PENDING;
        screen.fillRoundRect(x + 10, ry, w - 20, 24, 5, ROW);
        screen.fillCircle(x + 20, ry + 12, 3, tone);
        char caseNumber[24], dept[24], hours[12];
        ascii(caseNumber, sizeof(caseNumber), item["caseNumber"] | "", 20);
        ascii(dept, sizeof(dept), item["department"] | "", 20);
        snprintf(hours, sizeof(hours), "%dh", item["hours"] | 0);
        label(x + 30, ry + 8, caseNumber, 1, MUTED);
        label(x + 30 + 18 * 6, ry + 8, overdue ? "Overdue" : "Critical", 1, TEXT);
        const int hx = x + w - 20;
        labelRight(hx, ry + 8, hours, 1, tone);
        const int dw = textWidth(dept, 1) + 10;
        const int dx = hx - 46 - dw;
        screen.fillRoundRect(dx, ry + 4, dw, 16, 3, TRACK);
        label(dx + 5, ry + 8, dept, 1, MUTED);
        ry += 27;
    }
}

void drawCategories() {
    const int x = RIGHT_X, y = ROW_B_Y, w = RIGHT_W, h = ROW_B_H;
    panelBox(x, y, w, h, "CASES BY CATEGORY");
    JsonArrayConst rows = details["categories"].as<JsonArrayConst>();
    if (rows.isNull() || rows.size() == 0) {
        labelCenter(x + w / 2, y + h / 2, rows.isNull() ? "Waiting for case data" : "No data", 1, MUTED);
        return;
    }
    int maximum = 1;
    for (JsonObjectConst r : rows) maximum = max(maximum, r["count"].as<int>());
    const int labelW = 96, countW = 28;
    const int trackX = x + 10 + labelW + 6;
    const int trackW = w - 20 - labelW - 6 - countW - 6;
    int ry = y + 30;
    for (JsonObjectConst r : rows) {
        char name[20], count[12];
        ascii(name, sizeof(name), r["label"] | "", labelW / 6);
        snprintf(count, sizeof(count), "%d", r["count"].as<int>());
        label(x + 10, ry, name, 1, MUTED);
        screen.fillRoundRect(trackX, ry - 1, trackW, 10, 5, TRACK);
        const int fill = max(10, static_cast<int>(static_cast<int64_t>(trackW) * r["count"].as<int>() / maximum));
        screen.fillRoundRect(trackX, ry - 1, fill, 10, 5, parseColor(r["color"] | "", BRAND));
        labelRight(x + w - 10, ry, count, 1, TEXT);
        ry += 19;
    }
}

// ── Dashboard switcher ───────────────────────────────────────────────────────
// Five fixed slots, as on /display: Kaizen System (active), Hotel, two reserved
// blanks, System Settings. Display-only for now (no touch yet), which is how
// the web board behaves under ?touch=off.
constexpr uint16_t RESERVED = rgb(0x232a36);   // rgba(255,255,255,0.10) on BG

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
    const int w = (800 - 2 * PAD - 4 * GAP) / 5;
    const int y = SWITCH_Y, h = SWITCH_H;
    const char *names[] = {"Kaizen System", "Hotel", nullptr, nullptr, "System Settings"};
    for (int i = 0; i < 5; ++i) {
        const int x = PAD + i * (w + GAP);
        if (!names[i]) {
            dashedRect(x, y, w, h, RESERVED);
            continue;
        }
        const bool active = i == 0;
        if (active) screen.fillRoundRect(x, y, w, h, 9, BRAND);
        else card(x, y, w, h);
        const uint16_t fg = active ? TEXT : MUTED;
        const uint16_t bg = active ? BRAND : CARD;
        const int content = 12 + 6 + textWidth(names[i], 1);
        const int ix = x + (w - content) / 2, iy = y + h / 2 - 6;
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
void connectStrongest();

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
    return rssi >= -67 ? "good" : rssi >= -75 ? "fair" : rssi >= -85 ? "weak" : "very weak";
}

void drawStatus() {
    screen.fillRect(0, 450, 800, 30, BG);
    label(PAD, 458, screenStatus, 1, MUTED);
    if (WiFi.getMode() == WIFI_STA && WiFi.status() == WL_CONNECTED) {
        const int rssi = WiFi.RSSI();
        char signal[48];
        snprintf(signal, sizeof(signal), "Wi-Fi %d dBm  %s", rssi, signalQuality(rssi));
        labelRight(800 - PAD, 458, signal, 1, rssi >= -75 ? MUTED : rssi >= -85 ? C_PENDING : C_CRITICAL);
    }
}

void drawDashboard(const char *status) {
    screenStatus = status;
    screen.fillScreen(BG);
    drawHeader();
    drawKpis();
    drawTrend();
    drawOverview();
    drawAttention();
    drawCategories();
    drawSwitcher();
    drawStatus();
}

bool fetchDashboard() {
    WiFiClientSecure tls;
    tls.setCACert(ROOT_CA);
    HTTPClient http;
    http.setConnectTimeout(8000);
    http.setTimeout(8000);
    http.useHTTP10(true);
    if (!http.begin(tls, DISPLAY_URL)) return false;
    http.addHeader("Authorization", String("Bearer ") + DISPLAY_TOKEN);
    const int status = http.GET();
    int updated[METRIC_COUNT];
    bool valid = false;
    if (status == HTTP_CODE_OK) {
        JsonDocument filter;
        for (const Metric &metric : METRICS) filter[metric.key] = true;
        for (const char *key : {"title", "month", "resolutionRate", "avgResolution", "reopened",
                                "monthly", "categories", "attentionItems"}) {
            filter[key] = true;
        }
        JsonDocument data;
        valid = !deserializeJson(data, http.getStream(), DeserializationOption::Filter(filter));
        for (size_t i = 0; valid && i < METRIC_COUNT; ++i) {
            JsonVariant value = data[METRICS[i].key];
            valid = value.is<int>() && value.as<int>() >= 0;
            if (valid) updated[i] = value.as<int>();
        }
        const int rate = data["resolutionRate"] | -1;
        valid = valid && rate >= 0 && rate <= 100;
        if (valid) details = std::move(data);
    }
    http.end();
    if (valid) {
        memcpy(values, updated, sizeof(values));
        hasData = true;
        lastSuccess = millis();
    } else {
        Serial.printf("Dashboard fetch failed (HTTP %d)\n", status);
    }
    return valid;
}

void setup() {
    Serial.begin(115200);
    pinMode(BACKLIGHT, OUTPUT);
    digitalWrite(BACKLIGHT, LOW);
    if (!screen.begin()) {
        Serial.println("LCD initialization failed");
        return;
    }
    drawDashboard("Connecting to Wi-Fi...");
    digitalWrite(BACKLIGHT, HIGH);
    if (!WIFI_SSID[0] || !DISPLAY_TOKEN[0] || !ROOT_CA[0] ||
        strncmp(DISPLAY_URL, "https://", 8) != 0) {
        drawDashboard("Waiting for device configuration");
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
    const int current = WiFi.RSSI();
    if (current >= ROAM_BELOW_DBM) return;
    ApChoice best;
    if (strongestAp(best) && best.rssi >= current + ROAM_MARGIN_DB && memcmp(best.bssid, WiFi.BSSID(), 6) != 0) {
        Serial.printf("Roaming: %d dBm here, %ld dBm on ch %ld\n", current, (long)best.rssi, (long)best.channel);
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD, best.channel, best.bssid);
        joinStarted = millis();
    }
}

void loop() {
    if (Serial.available() && Serial.read() == 'S') dumpScreen();
    if (WiFi.getMode() != WIFI_STA) {
        delay(100);
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
        drawDashboard(success ? "Live  |  Refreshes every minute"
                     : hasData ? "Showing last update  |  Retrying..."
                     : !connected ? "Waiting for Wi-Fi..."
                     : !clockReady ? "Synchronizing clock..."
                     : "Kaizen data unavailable  |  Retrying...");
        nextPoll = millis() + (success ? POLL_MS : RETRY_MS);
    }
    static uint32_t lastClockTick = 0;
    if (millis() - lastClockTick >= 10000) {
        drawHeader();
        drawStatus();  // live signal readout, so the panel can be positioned by eye
        lastClockTick = millis();
    }
    manageWifi();
    delay(100);
}
