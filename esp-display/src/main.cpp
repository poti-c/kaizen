#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_wpa2.h>
#include <esp_phy_init.h>
#include <esp_rom_gpio.h>
#include <soc/gpio_sig_map.h>
#include <Wire.h>
#include <esp32s3/rom/cache.h>
#include <driver/gpio.h>
#include <esp_heap_caps.h>
#include <esp_idf_version.h>
#include <soc/gpio_periph.h>
#include <soc/io_mux_reg.h>

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

// ESP-IDF 4.4.7's RGB driver restarts its one-shot DMA chain AFTER the
// on_frame_trans_done callback. Repoint that chain to a complete second
// framebuffer before the next frame begins, without changing LCD timing.
// The layout is pinned to ESP-IDF 4.4.7 and checked against each descriptor.
#if ESP_IDF_VERSION == ESP_IDF_VERSION_VAL(4,4,7)
struct Rgb44Panel {
    esp_lcd_panel_t base;
    int panel_id;
    lcd_hal_context_t hal;
    size_t data_width,sram_trans_align,psram_trans_align;
    int disp_gpio_num;
    intr_handle_t intr;
    esp_pm_lock_handle_t pm_lock;
    size_t num_dma_nodes;
    uint8_t *fb;
    size_t fb_size;
    int data_gpio_nums[SOC_LCD_RGB_DATA_WIDTH];
    uint32_t src_clk_hz;
    esp_lcd_rgb_timing_t timings;
    gdma_channel_handle_t dma_chan;
    esp_lcd_rgb_panel_frame_trans_done_cb_t on_frame_trans_done;
    void *user_ctx;
    int x_gap,y_gap,lcd_clk_flags;
    struct { unsigned int disp_en_level:1,stream_mode:1,fb_in_psram:1; } flags;
    dma_descriptor_t dma_nodes[];
};
static uint32_t dmaOffsets[256];
static volatile size_t swapNodes=0;
static uint16_t *volatile requestedFrame=nullptr;
static uint16_t *volatile committedFrame=nullptr;
static bool IRAM_ATTR frameSwapCallback(esp_lcd_panel_handle_t handle,esp_lcd_rgb_panel_event_data_t*,void*) {
    uint16_t *next=requestedFrame;
    if(next && swapNodes){
        auto *rgb=reinterpret_cast<Rgb44Panel*>(handle);
        uint8_t *base=reinterpret_cast<uint8_t*>(next);
        for(size_t i=0;i<swapNodes;++i) rgb->dma_nodes[i].buffer=base+dmaOffsets[i];
        asm volatile("memw" ::: "memory");
        committedFrame=next;
        requestedFrame=nullptr;
    }
    return false;
}
extern "C" esp_err_t __real_esp_lcd_new_rgb_panel(const esp_lcd_rgb_panel_config_t*,esp_lcd_panel_handle_t*);
extern "C" esp_err_t __wrap_esp_lcd_new_rgb_panel(const esp_lcd_rgb_panel_config_t *config,esp_lcd_panel_handle_t *out) {
    esp_lcd_rgb_panel_config_t copy=*config;
    if(!copy.on_frame_trans_done)copy.on_frame_trans_done=frameSwapCallback;
    esp_err_t res=__real_esp_lcd_new_rgb_panel(&copy,out);
    if(res!=ESP_OK||!out||!*out)return res;
    auto *rgb=reinterpret_cast<Rgb44Panel*>(*out);
    if(rgb->fb_size!=800UL*480UL*2 || !rgb->fb || rgb->num_dma_nodes==0 || rgb->num_dma_nodes>256 || copy.on_frame_trans_done!=frameSwapCallback)return res;
    size_t sum=0;
    for(size_t i=0;i<rgb->num_dma_nodes;++i){
        auto &d=rgb->dma_nodes[i];uintptr_t ptr=reinterpret_cast<uintptr_t>(d.buffer),base=reinterpret_cast<uintptr_t>(rgb->fb);
        if(ptr<base||ptr-base>=rgb->fb_size||!d.dw0.length||ptr-base+d.dw0.length>rgb->fb_size||ptr-base!=sum)return res;
        dmaOffsets[i]=ptr-base;sum+=d.dw0.length;
    }
    if(sum==rgb->fb_size)swapNodes=rgb->num_dma_nodes;
    return res;
}
#else
#error "Frame swap must be revalidated against the installed RGB driver version"
#endif
static bool backNeedsSync=false;
// Four immutable page snapshots, plus two normal rendering buffers. Page
// navigation swaps a cached frame directly at VSYNC; no rasterization or PSRAM
// bulk copy occurs in the interaction path.
static uint16_t *pageCache[4]={};
static uint16_t *workA=nullptr,*workB=nullptr;
static uint8_t readyPages=0, rebuildPages=0;
static bool cachingPage=false;
static bool isPageCache(const uint16_t *p){for(auto *c:pageCache)if(c && c==p)return true;return false;}
static void pacePixels(uint32_t n=1){static uint32_t budget=0;budget+=n;if(budget>=64){budget=0;delayMicroseconds(7);}}

// Guition JC8048W550 RGB wiring and timings from the Arduino_GFX board example.
Arduino_ESP32RGBPanel panel(
    40, 41, 39, 42, 45, 48, 47, 21, 14, 5, 6, 7, 15, 16, 4,
    8, 3, 46, 9, 1, 0, 8, 4, 8, 0, 8, 4, 8, 1,
    // Controlled recovery trial: the original 16 MHz panel timing. A panel
    // that enters an RGB test pattern at 12 MHz may require a faster clock.
    16000000);
// Everything is drawn into an off-screen buffer (`back`); present() then copies
// it, or cross-fades it, onto the buffer the LCD scans (`front`). So the board
// never shows a half-drawn frame, and a data refresh fades instead of flashing.
// Rows drawn since the last present(), in screen coordinates, so present()
// compares only those instead of reading the whole frame twice.
bool dirtyRow[480];
bool anyDirty = false;
bool fullFramePending = false; // board redraw bypasses the expensive framebuffer diff
inline void markRows(int y0, int y1) {
    y0 = max(0, y0);
    y1 = min(479, y1);
    for (int y = y0; y <= y1; ++y) dirtyRow[y] = true;
    if (y0 <= y1) anyDirty = true;
}
class PanelDisplay : public Arduino_RGB_Display {
public:
    using Arduino_RGB_Display::Arduino_RGB_Display;
    void drawTo(uint16_t *buf) {
        _framebuffer = buf;
        _auto_flush = false;  // present() writes the LCD buffer back itself
    }
    void writePixelPreclipped(int16_t x, int16_t y, uint16_t color) override {
        markRows(y, y);
        Arduino_RGB_Display::writePixelPreclipped(x, y, color);
        if(cachingPage)pacePixels();
    }
    void writeFastVLine(int16_t x, int16_t y, int16_t h, uint16_t color) override {
        markRows(y, y + h - 1);
        Arduino_RGB_Display::writeFastVLine(x, y, h, color);
    }
    void writeFastHLine(int16_t x, int16_t y, int16_t w, uint16_t color) override {
        markRows(y, y);
        if(cachingPage&&w>64){for(int i=0;i<w;i+=64){Arduino_RGB_Display::writeFastHLine(x+i,y,min(64,(int)w-i),color);delayMicroseconds(7);}}
        else Arduino_RGB_Display::writeFastHLine(x, y, w, color);
    }
    void writeFillRectPreclipped(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) override {
        markRows(y, y + h - 1);
        // Keep the RGB DMA fed at 16 MHz while a large offscreen area is drawn.
        // The library's unbroken fill of 768 KB can starve PSRAM reads.
        if(cachingPage && static_cast<int32_t>(w)*h>256){
            for(int j=0;j<h;++j){for(int i=0;i<w;i+=128){Arduino_RGB_Display::writeFillRectPreclipped(x+i,y+j,min(128,(int)w-i),1,color);delayMicroseconds(7);}}
        }else if(static_cast<int32_t>(w)*h > 16000){
            for(int off=0;off<h;off+=8){
                Arduino_RGB_Display::writeFillRectPreclipped(x,y+off,w,min(8,static_cast<int>(h)-off),color);
                delayMicroseconds(80);
            }
        }else Arduino_RGB_Display::writeFillRectPreclipped(x, y, w, h, color);
    }
};
PanelDisplay screen(800, 480, &panel);
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
enum class Status { Connecting, Unconfigured, Live, Stale, NoWifi, NoClock, Unavailable, Portal };
Status status = Status::Connecting;
uint32_t nextPoll = 0;

// Which board is on screen. Kaizen is home; Hotel times out back to it.
enum class Screen { Kaizen, Hotel, Availability, Clock };
constexpr Screen BOARDS[] = {Screen::Kaizen, Screen::Hotel, Screen::Availability, Screen::Clock};
constexpr int BOARD_COUNT = 4;
JsonDocument localAvailability;
Screen current = Screen::Kaizen;
uint32_t lastTouch = 0;
Preferences prefs;

// ── Restart log ──────────────────────────────────────────────────────────────
// Why the panel restarted, kept across restarts in NVS ("boot"), with how far
// each start got and how long it ran. Made to tell a weak power supply (a loop
// of brownout / power-on resets that never get past starting Wi-Fi) from a
// firmware crash. Printed at boot and on serial 'B'; summarised under About.
enum BootStage : uint8_t { BS_START, BS_SCREEN, BS_BACKLIGHT, BS_WIFI_START, BS_WIFI_UP, BS_DATA };
const char *const STAGE_NAMES[] = {"start", "screen", "backlight", "Wi-Fi start", "Wi-Fi up", "data"};
struct BootEntry { uint8_t reason, stage; uint16_t pad; uint32_t upSecs; };
constexpr int BOOT_LOG_N = 16;
Preferences bprefs;
BootEntry bootLog[BOOT_LOG_N];
uint8_t bootHead = 0;      // slot of this start
uint32_t bootCount = 0;

const char *resetName(uint8_t r) {
    switch (r) {
        case ESP_RST_POWERON: return "power-on";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "crash";
        case ESP_RST_INT_WDT: case ESP_RST_TASK_WDT: case ESP_RST_WDT: return "watchdog";
        case ESP_RST_EXT: return "reset pin";
        case ESP_RST_DEEPSLEEP: return "deep sleep";
        default: return "other";
    }
}
void bootLogSave() { bprefs.putBytes("log", bootLog, sizeof(bootLog)); }
void bootLogStart() {
    bprefs.begin("boot", false);
    if (bprefs.getBytes("log", bootLog, sizeof(bootLog)) != sizeof(bootLog)) memset(bootLog, 0, sizeof(bootLog));
    bootCount = bprefs.getULong("n", 0) + 1;
    bprefs.putULong("n", bootCount);
    bootHead = bootCount % BOOT_LOG_N;
    bootLog[bootHead] = {static_cast<uint8_t>(esp_reset_reason()), BS_START, 0, 0};
    bootLogSave();
}
void bootStage(BootStage s) {
    if (bootLog[bootHead].stage >= s) return;
    bootLog[bootHead].stage = s;
    bootLog[bootHead].upSecs = millis() / 1000;
    bootLogSave();
}
// Uptime at a few marks only (1, 5, 30 min, then hourly): enough to see how long
// a start lasted without wearing the flash.
void bootLogTick() {
    static uint32_t next = 60;
    const uint32_t up = millis() / 1000;
    if (up < next) return;
    bootLog[bootHead].upSecs = up;
    bootLogSave();
    next = next < 300 ? 300 : next < 1800 ? 1800 : next + 3600;
}
void bootLogPrint() {
    Serial.printf("Restart log (%lu starts; newest first):\n", static_cast<unsigned long>(bootCount));
    for (int i = 0; i < BOOT_LOG_N && i < static_cast<int>(bootCount); ++i) {
        const uint32_t n = bootCount - i;
        const BootEntry &e = bootLog[n % BOOT_LOG_N];
        Serial.printf("  #%-5lu %-9s reached %-11s ran %lus%s\n", static_cast<unsigned long>(n), resetName(e.reason),
                      STAGE_NAMES[min<int>(e.stage, BS_DATA)], static_cast<unsigned long>(e.upSecs), i == 0 ? "  (this start)" : "");
    }
}
// e.g. "brownout 7, power-on 3" over the remembered starts, before this one.
String bootSummary() {
    int counts[16] = {0};
    const int n = min<int>(BOOT_LOG_N, static_cast<int>(bootCount));
    for (int i = 1; i < n; ++i) ++counts[bootLog[(bootCount - i) % BOOT_LOG_N].reason & 15];
    String s;
    const uint8_t order[] = {ESP_RST_BROWNOUT, ESP_RST_POWERON, ESP_RST_PANIC, ESP_RST_TASK_WDT, ESP_RST_INT_WDT, ESP_RST_WDT, ESP_RST_SW, ESP_RST_EXT};
    for (uint8_t r : order)
        if (counts[r]) { if (s.length()) s += ", "; s += resetName(r); s += " "; s += counts[r]; }
    return s.length() ? s : String("-");
}


// Panel settings, as in src/lib/panelTheme.ts (same defaults), kept in NVS.
struct PanelSettings {
    int brightness = 100;
    bool nightDim = false;
    int nightFrom = 22 * 60, nightTo = 6 * 60;  // minutes after midnight, Bangkok time
    int nightLevel = 35;
    bool rotated = false;                       // orientation 180°
    int clockCity[3] = {0, 2, 4};               // World Clock cities (CITY_LIST indexes)
    int airHome = 0;                            // where air quality is read
    bool rotate = false;                        // cycle the bottom-row boards
    uint8_t enabledBoards = 15;
    int startupBoard = 0;
    int boardDurations[4] = {30,30,30,15};
    bool freshnessAlerts = true;
    int rotateSecs = 30;                        // time per board, 15..300
    int refreshSecs = 60;
    int idleSecs = 30;
    bool touch = true;                          // touch drill-down
} cfg;
bool boardEnabled(Screen b) { return cfg.enabledBoards & (1 << static_cast<int>(b)); }
Screen defaultBoard() { return BOARDS[cfg.startupBoard]; }
int enabledCount() { int n=0; for (Screen b:BOARDS) if(boardEnabled(b)) ++n; return n; }
const char *boardName(Screen b) { switch(b) { case Screen::Kaizen:return "Kaizen System"; case Screen::Hotel:return L("Resort Report","รายงานรีสอร์ต"); case Screen::Availability:return L("Room Availability","ห้องว่าง"); default:return L("World Clock","นาฬิกาโลก"); } }
JsonObjectConst roomReport() { JsonObjectConst live=details["roomAvailability"].as<JsonObjectConst>(); if (!live.isNull() && live["types"].is<JsonArrayConst>() && strcmp(live["reportDate"]|"",localAvailability["reportDate"]|"")>=0) return live; return localAvailability.as<JsonObjectConst>(); }
int reportAge(const char *date) { if (!date || strlen(date)<10 || time(nullptr)<1700000000) return -1; struct tm t={}; int y,m,d; if(sscanf(date,"%d-%d-%d",&y,&m,&d)!=3)return -1; t.tm_year=y-1900;t.tm_mon=m-1;t.tm_mday=d; return max(0, static_cast<int>((time(nullptr)+7*3600-mktime(&t))/86400)); }
const char *freshLabel(int age) { return age>=2?L("ATTENTION REQUIRED","ต้องตรวจสอบ"):age==1?L("OUTDATED","ข้อมูลเก่า"):age==0?L("UP TO DATE","ข้อมูลล่าสุด"):""; }
uint16_t freshColor(int age) { return age>=2?C_CRITICAL:age==1?C_PENDING:C_RESOLVED; }
uint32_t pollMs() { return cfg.refreshSecs * 1000UL; }

// World Clock cities. Keep in step with src/lib/worldClock.ts and CITIES in
// supabase/functions/kaizen-ambient. The offset is the standard one, used only
// until kaizen-ambient reports the current offset (which includes DST).
// Cities of one country sit next to each other: the settings dropdown groups
// consecutive entries under one country heading.
struct CityDef {
    const char *key, *name, *nameTh, *country, *countryTh;
    int16_t stdOffset;  // minutes
};
constexpr CityDef CITY_LIST[] = {
    {"chiangmai", "Chiang Mai", "เชียงใหม่", "Thailand", "ไทย", 420},
    {"bangkok", "Bangkok", "กรุงเทพฯ", "Thailand", "ไทย", 420},
    {"tokyo", "Tokyo", "โตเกียว", "Japan", "ญี่ปุ่น", 540},
    {"osaka", "Osaka", "โอซากา", "Japan", "ญี่ปุ่น", 540},
    {"taipei", "Taipei", "ไทเป", "Taiwan", "ไต้หวัน", 480},
    {"seoul", "Seoul", "โซล", "South Korea", "เกาหลีใต้", 540},
    {"hongkong", "Hong Kong", "ฮ่องกง", "Hong Kong", "ฮ่องกง", 480},
    {"shanghai", "Shanghai", "เซี่ยงไฮ้", "China", "จีน", 480},
    {"singapore", "Singapore", "สิงคโปร์", "Singapore", "สิงคโปร์", 480},
    {"dubai", "Dubai", "ดูไบ", "UAE", "สหรัฐอาหรับเอมิเรตส์", 240},
    {"london", "London", "ลอนดอน", "UK", "สหราชอาณาจักร", 0},
    {"paris", "Paris", "ปารีส", "France", "ฝรั่งเศส", 60},
    {"newyork", "New York", "นิวยอร์ก", "USA", "สหรัฐอเมริกา", -300},
    {"losangeles", "Los Angeles", "ลอสแอนเจลิส", "USA", "สหรัฐอเมริกา", -480},
    {"sydney", "Sydney", "ซิดนีย์", "Australia", "ออสเตรเลีย", 600},
};
constexpr int CITY_COUNT = sizeof(CITY_LIST) / sizeof(CITY_LIST[0]);

// World Clock data from kaizen-ambient (see fetchAmbient).
JsonDocument ambient;
bool ambientOk = false;
uint32_t ambientAt = 0;  // 0 = fetch as soon as possible
constexpr uint32_t AMBIENT_MS = 10 * 60 * 1000;
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
uint16_t *fb = nullptr;      // where drawing goes (the off-screen buffer), set in setup()
uint16_t *front = nullptr;   // the buffer the LCD scans
uint16_t *back = nullptr;    // the off-screen buffer
bool needPresent = false;    // something was drawn since the last present()
bool fadeNext = false;       // cross-fade the next present()
bool rotated180 = false;     // Orientation 180°: framebuffer is drawn upside down
inline uint16_t *fbAt(int x, int y) {
    return rotated180 ? fb + (479 - y) * 800 + (799 - x) : fb + y * 800 + x;
}
// The LCD reads the framebuffer from PSRAM; push our CPU-cache writes out to it.
void flushRows(int y0, int y1) {
    if (fb != front) return;  // off-screen: present() writes the LCD buffer back
    y0 = max(0, y0);
    y1 = min(479, y1);
    if (!fb || y1 < y0) return;
    const int r0 = rotated180 ? 479 - y1 : y0, r1 = rotated180 ? 479 - y0 : y1;
    Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(fb + r0 * 800), (r1 - r0 + 1) * 800 * 2);
}
// ── Presenting frames ────────────────────────────────────────────────────────
// Two things make on-screen changes look torn or streaky on this panel:
//  - the LCD controller streams the frame from the same PSRAM the CPU uses, so
//    long CPU passes over the framebuffer starve it and show as shifted lines;
//  - writing while the LCD is mid-scan shows part of the old and part of the
//    new image.
// So present() finds the runs of pixels that actually changed (one compare
// pass), touches only those, and writes each step right after VSYNC, while the
// panel is between frames.
constexpr int VSYNC_PIN = 41;
uint32_t framePeriodUs = 25640;
int vsyncPulse = -1;  // level of the VSYNC pulse (1 or 0); -1 = unusable, use plain timing

// Returns at the start of the next VSYNC pulse (or after ~30 ms if unreadable).
void waitVsync() {
    if (vsyncPulse < 0) { delay(25); return; }
    const gpio_num_t pin = static_cast<gpio_num_t>(VSYNC_PIN);
    const uint32_t t0 = micros();
    while (gpio_get_level(pin) == vsyncPulse && micros() - t0 < 40000) {}  // leave a pulse in progress
    while (gpio_get_level(pin) != vsyncPulse && micros() - t0 < 60000) {}  // wait for the next one
}

// The pulse is a few lines long and the idle level fills the rest of the
// frame, so whichever level is rare over ~30 ms is the pulse.
void vsyncInit() {
    PIN_INPUT_ENABLE(GPIO_PIN_MUX_REG[VSYNC_PIN]);  // read back the pin the LCD drives
    int highs = 0, total = 0, edges = 0, last = gpio_get_level(static_cast<gpio_num_t>(VSYNC_PIN));
    const uint32_t t0 = micros();
    while (micros() - t0 < 30000) {
        const int v = gpio_get_level(static_cast<gpio_num_t>(VSYNC_PIN));
        highs += v;
        ++total;
        if (v != last) { ++edges; last = v; }
    }
    if (edges >= 2) vsyncPulse = highs * 2 < total ? 1 : 0;
    float hz = 0;
    if (vsyncPulse >= 0) {  // time 10 frames to confirm the refresh rate
        waitVsync();
        const uint32_t s = micros();
        for (int i = 0; i < 10; ++i) waitVsync();
        hz = 10e6f / (micros() - s);
        if(hz>20 && hz<100) framePeriodUs=static_cast<uint32_t>(1000000.0f/hz);
    }
    Serial.printf("VSYNC: pulse %s, %.1f Hz\n", vsyncPulse < 0 ? "not readable (plain timing)" : vsyncPulse ? "high" : "low", hz);
}
struct Span { uint32_t start; uint16_t len; };
constexpr int MAX_SPANS = 4000;
Span spans[MAX_SPANS];  // internal RAM: the fade loops never re-scan PSRAM

// Runs of differing pixels in rows top..bottom; small gaps are merged.
// Returns -1 if the change is too scattered to list (then: plain copy).
int findSpans(int top, int bottom) {
    int n = 0;
    for (int y = top; y <= bottom; ++y) {
        if ((y & 15) == 15) delayMicroseconds(60);  // let the LCD's reads through
        const uint16_t *f = front + y * 800, *b = back + y * 800;
        int x = 0;
        while (x < 800) {
            if (f[x] == b[x]) { ++x; continue; }
            int end = x + 1, gap = 0;
            while (end < 800 && gap <= 6) {
                if (f[end] != b[end]) gap = 0; else ++gap;
                ++end;
            }
            end -= gap;
            if (n == MAX_SPANS) return -1;
            spans[n++] = {static_cast<uint32_t>(y * 800 + x), static_cast<uint16_t>(end - x)};
            x = end;
        }
    }
    return n;
}

// Only a partial redraw needs a copy of the current screen. Full board
// switches are rendered directly into the inactive buffer and never copy it
// into the buffer currently scanned by the LCD.
void ensureBackSynced() {
    if(!backNeedsSync || fullFramePending || !front || !back || front==back)return;
    for(int y=0;y<480;y+=8){memcpy(back+y*800,front+y*800,8*1600);delayMicroseconds(60);}
    backNeedsSync=false;
}

bool swapToFrame(uint16_t *next) {
    if(!swapNodes||!next||((reinterpret_cast<uintptr_t>(next)&63)!=0))return false;
    if(next==front)return true;
    committedFrame=nullptr;requestedFrame=next;
    const uint32_t begin=millis();
    while(requestedFrame && millis()-begin<150)delay(1);
    if(requestedFrame){requestedFrame=nullptr;delay(2);}
    if(committedFrame!=next)return false;
    delay(1);
    uint16_t *old=front;front=next;
    if(isPageCache(old))back=(front==workA)?workB:workA;
    else if(isPageCache(front))back=(old==workA||old==workB)?old:workA;
    else back=old;
    if(!back||back==front||isPageCache(back))back=(front==workA)?workB:workA;
    fb=back;screen.drawTo(back);backNeedsSync=true;
    fullFramePending=false;anyDirty=false;needPresent=false;memset(dirtyRow,0,sizeof(dirtyRow));
    Serial.printf("Frame swapped at VSYNC in %lu ms\n",static_cast<unsigned long>(millis()-begin));
    return true;
}

void present(bool fade) {
    needPresent = false;
    fadeNext = false;
    if (!back || back == front || !anyDirty) { fullFramePending=false; return; }
    if(fullFramePending){
        fullFramePending=false; anyDirty=false; memset(dirtyRow,0,sizeof(dirtyRow));
        if(swapNodes && ((reinterpret_cast<uintptr_t>(back)&63)==0)){
            // Flush only the inactive buffer, in short stripes to avoid
            // starving the currently displayed DMA frame.
            for(int y=0;y<480;y+=8){Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(back+y*800),8*1600);delayMicroseconds(30);}
            if(swapToFrame(back))return;
            Serial.println("VSYNC swap timed out; fallback transfer");swapNodes=0;
        }
        backNeedsSync=false;
        // Single-buffer RGB driver: present behind the scan in short row
        // stripes. Avoids a complete diff read and large cache-writeback burst.
        // The old image remains lit during drawing; no black flash or fade.
        waitVsync(); const uint32_t began=micros();
        constexpr int STRIPE=8;
        for(int y=0;y<480;y+=STRIPE){
            const int rows=min(STRIPE,480-y);
            if(vsyncPulse>=0){
                const uint32_t target=framePeriodUs*(y+rows)/480+300;
                const uint32_t elapsed=micros()-began;
                if(elapsed<target)delayMicroseconds(target-elapsed);
            }
            memcpy(front+y*800,back+y*800,rows*1600);
            Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(front+y*800),rows*1600);
            delayMicroseconds(35);
        }
        Serial.printf("Frame presented in %lu ms (striped)\n",static_cast<unsigned long>((micros()-began)/1000));
        return;
    }
    // Compare only rows that were drawn (framebuffer rows flip when rotated),
    // pausing every few rows so the LCD's own PSRAM reads get through.
    int top = -1, bottom = -1;
    for (int y = 0; y < 480; ++y) {
        if (!dirtyRow[y]) continue;
        dirtyRow[y] = false;
        const int r = rotated180 ? 479 - y : y;
        if (memcmp(front + r * 800, back + r * 800, 1600)) {
            top = top < 0 ? r : min(top, r);
            bottom = max(bottom, r);
        }
        if ((y & 15) == 15) delayMicroseconds(60);
    }
    anyDirty = false;
    if (top < 0) return;
    const int n = findSpans(top, bottom);
    const uint32_t lo = top * 800, bytes = (bottom - top + 1) * 1600;
    if (n < 0) {  // a whole-screen change: copy between frames, in slices
        waitVsync();
        for (uint32_t off = 0; off < bytes; off += 32 * 1600) {
            memcpy(reinterpret_cast<uint8_t *>(front + lo) + off, reinterpret_cast<uint8_t *>(back + lo) + off,
                   min<uint32_t>(32 * 1600, bytes - off));
            delayMicroseconds(60);
        }
        Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(front + lo), bytes);
        return;
    }
    constexpr int STEPS = 8;  // ~8 frames, about 0.2 s at this panel's ~39 Hz
    const uint32_t started = millis();
    for (int k = fade ? 0 : STEPS - 1; k < STEPS; ++k) {
        const bool last = k == STEPS - 1;
        const int a = 255 / (STEPS - k);  // a 1/(steps left) share of the remaining way
        waitVsync();
        for (int s = 0; s < n; ++s) {
            uint16_t *f = front + spans[s].start;
            const uint16_t *b = back + spans[s].start;
            if (last) memcpy(f, b, spans[s].len * 2);
            else
                for (int i = 0; i < spans[s].len; ++i)
                    if (f[i] != b[i]) f[i] = blend(b[i], f[i], a);
        }
        Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(front + lo), bytes);
    }
    if (fade) Serial.printf("Faded %d runs of changed pixels in %lu ms\n", n, static_cast<unsigned long>(millis() - started));
}
inline void blendPx(int x, int y, uint16_t color, int alpha) {  // alpha 0..255
    if (x < 0 || x >= 800 || y < 0 || y >= 480 || alpha <= 0) return;
    uint16_t *p = fbAt(x, y);
    *p = alpha >= 255 ? color : blend(color, *p, alpha);
    if(cachingPage)pacePixels();
    dirtyRow[y] = true;
    anyDirty = true;
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
        case 4: return num30;
        default: return clock64;
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
    for (char *c = out; *c; ++c)  // ASCII letters only; Thai and symbols pass through
        if (*c >= 'a' && *c <= 'z') *c = *c - 'a' + 'A';
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
    ensureBackSynced();
    needPresent = true;
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
        if (current == Screen::Availability) {
            snprintf(subtitle, sizeof(subtitle), "%s", L("Room availability | 10 days", "ห้องว่างตามประเภท 10 วัน"));
        } else if (current == Screen::Clock) {
            snprintf(subtitle, sizeof(subtitle), "%s  |  %s", month,
                     L("World clock, weather and air quality", "นาฬิกาโลก สภาพอากาศ และคุณภาพอากาศ"));
        } else if (current == Screen::Hotel) {
            // The hotel figures come from the last uploaded report, which can
            // be days behind: say which day, and flag it when it is old.
            JsonObjectConst hotel = details["hotel"].as<JsonObjectConst>();
            const char *date = hotel["uploadDateLabel"] | (hotel["statDateLabel"] | "");
            if (date[0]) {
                snprintf(subtitle, sizeof(subtitle), "%s  |  %s  |  %s %s", month,
                         L("Hotel performance", "ผลประกอบการโรงแรม"), hotel["uploadDateLabel"].is<const char*>() ? L("As of", "ข้อมูล ณ วันที่") : L("Figures for", "ข้อมูลวันที่"), date);
            } else {
                snprintf(subtitle, sizeof(subtitle), "%s  |  %s", month, L("Hotel performance", "ผลประกอบการโรงแรม"));
            }
            const int age = hotel["uploadAgeDays"] | (hotel["ageDays"] | 0);
            if (cfg.freshnessAlerts && age >= 1) {
                char tag[96];
                snprintf(tag, sizeof(tag), thai ? "ข้อมูล %d วันที่แล้ว" : "%d DAYS OLD", age);
                pill(bx, 11, tag, age>=2?C_CRITICAL:C_PENDING, rgb(0x3a2e17), 17, 0);
            }
        } else {
            snprintf(subtitle, sizeof(subtitle), "%s  |  %s %s  |  %s %d%%", month,
                     L("Avg Resolution", "เวลาแก้ไขเฉลี่ย"), avg, L("Resolution Rate", "อัตราการแก้ไข"),
                     details["resolutionRate"].as<int>());
        }
    }
    if (current==Screen::Availability) snprintf(subtitle,sizeof(subtitle),"%s",L("Room availability | 10 days","ห้องว่างตามประเภท 10 วัน"));
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
void iconClock(int x, int y, uint16_t c) {
    screen.drawCircle(x + 6, y + 6, 6, c);
    screen.drawFastVLine(x + 6, y + 2, 5, c);
    screen.drawLine(x + 6, y + 6, x + 9, y + 8, c);
}
void iconSettings(int x, int y, uint16_t c, uint16_t bg) {
    aaCircle(x + 6, y + 6, 4, c);
    aaCircle(x + 6, y + 6, 2, bg);
    screen.fillRect(x + 5, y, 2, 2, c);
    screen.fillRect(x + 5, y + 10, 2, 2, c);
    screen.fillRect(x, y + 5, 2, 2, c);
    screen.fillRect(x + 10, y + 5, 2, 2, c);
}

int switchWidth() { return (800-2*PAD-enabledCount()*GAP)/(enabledCount()+1); }
void drawSwitcher() {
    const int y=SWITCH_Y,h=SWITCH_H,w=switchWidth(); int slot=0;
    for (int i=0;i<=4;++i) {
        if(i<4 && !boardEnabled(BOARDS[i])) continue;
        int x=PAD+slot++*(w+GAP); bool active=i<4&&current==BOARDS[i];
        if(active) aaRoundRect(x,y,w,h,9,BRAND); else card(x,y,w,h);
        uint16_t fg=active?TEXT:MUTED,bg=active?BRAND:CARD;
        const char *name=i<4?boardName(BOARDS[i]):L("System Settings","ตั้งค่าระบบ");
        int font=textWidth(name,1)+18<=w-8?1:0; int content=18+textWidth(name,font); int ix=x+(w-content)/2,iy=y+h/2-6;
        if(i==0)iconDashboard(ix,iy,fg);else if(i==1||i==2)iconHotel(ix,iy,fg);else if(i==3)iconClock(ix,iy,fg);else iconSettings(ix,iy,fg,bg);
        label(ix+18,y+h/2-4,name,font,fg);
    }
}

// Send 'S' over serial to receive the framebuffer, run-length encoded:
// "KZSHOT", width u16, height u16, then (count u16, rgb565 u16) runs ending
// with a zero count. Lets the layout be checked on a computer.
void dumpScreen() {
    const uint16_t *fb = front ? front : screen.getFramebuffer();  // what is on screen
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

// ── Wi-Fi: remembered networks ───────────────────────────────────────────────
// Like a phone: a network joined from System Settings > Network is remembered
// (NVS namespace "wifi", up to 6, most recent first) and the panel joins the
// strongest remembered network in range, pinned to its strongest access point.
// The network in device_config.h only seeds the list on first start and after
// a factory reset. Passwords never go to the serial log.
constexpr uint32_t ROAM_CHECK_MS = 5 * 60 * 1000;
constexpr int ROAM_BELOW_DBM = -78;
constexpr int ROAM_MARGIN_DB = 8;
constexpr uint32_t REJOIN_AFTER_MS = 45000;
constexpr int MAX_KNOWN = 6, MAX_NETS = 24;
uint32_t joinStarted = 0;  // when the last join attempt started

Preferences wprefs;
struct Known {
    String ssid, pass;
    String user;                  // set = WPA2-Enterprise (PEAP) sign-in, e.g. @JumboPlus
    bool portalSaved = false;     // signed in to this network's sign-in page before
    String portalUser, portalPass;
};
Known known[MAX_KNOWN];
int knownCount = 0;
String currentSsid;

void saveKnown() {
    wprefs.clear();
    wprefs.putUChar("n", knownCount);
    char k[8];
    for (int i = 0; i < knownCount; ++i) {
        snprintf(k, sizeof(k), "s%d", i); wprefs.putString(k, known[i].ssid);
        snprintf(k, sizeof(k), "p%d", i); wprefs.putString(k, known[i].pass);
        snprintf(k, sizeof(k), "e%d", i); wprefs.putString(k, known[i].user);
        snprintf(k, sizeof(k), "a%d", i); wprefs.putBool(k, known[i].portalSaved);
        snprintf(k, sizeof(k), "u%d", i); wprefs.putString(k, known[i].portalUser);
        snprintf(k, sizeof(k), "q%d", i); wprefs.putString(k, known[i].portalPass);
    }
}
void loadKnown() {
    knownCount = min<int>(MAX_KNOWN, wprefs.getUChar("n", 0));
    char k[8];
    for (int i = 0; i < knownCount; ++i) {
        snprintf(k, sizeof(k), "s%d", i); known[i].ssid = wprefs.getString(k, "");
        snprintf(k, sizeof(k), "p%d", i); known[i].pass = wprefs.getString(k, "");
        snprintf(k, sizeof(k), "e%d", i); known[i].user = wprefs.getString(k, "");
        snprintf(k, sizeof(k), "a%d", i); known[i].portalSaved = wprefs.getBool(k, false);
        snprintf(k, sizeof(k), "u%d", i); known[i].portalUser = wprefs.getString(k, "");
        snprintf(k, sizeof(k), "q%d", i); known[i].portalPass = wprefs.getString(k, "");
    }
    if (knownCount == 0 && WIFI_SSID[0]) {  // first start: seed from device_config.h
        known[0].ssid = WIFI_SSID;
        known[0].pass = WIFI_PASSWORD;
        knownCount = 1;
        saveKnown();
    }
}
int knownIndex(const String &ssid) {
    for (int i = 0; i < knownCount; ++i)
        if (known[i].ssid == ssid) return i;
    return -1;
}
void rememberNetwork(const String &ssid, const String &pass, const String &user) {
    Known k;
    const int i = knownIndex(ssid);
    if (i >= 0) {
        k = known[i];
        for (int j = i; j < knownCount - 1; ++j) known[j] = known[j + 1];
        --knownCount;
    }
    k.ssid = ssid;
    k.pass = pass;
    k.user = user;
    for (int j = min(knownCount, MAX_KNOWN - 1); j > 0; --j) known[j] = known[j - 1];
    known[0] = k;
    knownCount = min(knownCount + 1, MAX_KNOWN);
    saveKnown();
}
void forgetNetwork(const String &ssid) {
    const int i = knownIndex(ssid);
    if (i < 0) return;
    for (int j = i; j < knownCount - 1; ++j) known[j] = known[j + 1];
    --knownCount;
    saveKnown();
}

// Networks in range, one entry per name (its strongest access point), strongest first.
struct Net {
    String ssid;
    int32_t rssi = -127, channel = 0;
    uint8_t bssid[6] = {0};
    bool secure = true;
    bool enterprise = false;  // asks for a username and password (802.1X)
};
Net nets[MAX_NETS];
int netCount = 0;
uint32_t scannedAt = 0;

void scanNetworks() {
    // While a join keeps failing, the WiFi library restarts it on every failure
    // (auto-reconnect, plus one retry after each begin()), and each restart
    // cancels a running scan, which then reports 0 networks rather than an
    // error. The radio also refuses to start a scan mid-join (-2). So when not
    // connected, pause auto-reconnect and stop the join for the scan;
    // manageWifi() resumes joining afterwards.
    const bool connected = WiFi.status() == WL_CONNECTED;
    if (!connected) {
        WiFi.setAutoReconnect(false);
        WiFi.disconnect();
        delay(300);
    }
    int16_t n = WiFi.scanNetworks(false, false, false, 300);
    if (n <= 0 && !connected) {
        // A failure event from the stopped join can still land mid-scan once.
        Serial.printf("Scan found nothing (%d) while not connected; scanning again\n", n);
        WiFi.disconnect();
        delay(300);
        n = WiFi.scanNetworks(false, false, false, 300);
    }
    if (!connected) {
        WiFi.setAutoReconnect(true);
        joinStarted = millis();
    }
    netCount = 0;
    for (int i = 0; i < n; ++i) {
        const String ssid = WiFi.SSID(i);
        if (!ssid.length()) continue;  // hidden network
        int j = 0;
        while (j < netCount && nets[j].ssid != ssid) ++j;
        if (j < netCount && nets[j].rssi >= WiFi.RSSI(i)) continue;
        if (j == netCount) {
            if (netCount == MAX_NETS) continue;
            ++netCount;
        }
        nets[j].ssid = ssid;
        nets[j].rssi = WiFi.RSSI(i);
        nets[j].channel = WiFi.channel(i);
        memcpy(nets[j].bssid, WiFi.BSSID(i), 6);
        nets[j].secure = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
        nets[j].enterprise = WiFi.encryptionType(i) == WIFI_AUTH_WPA2_ENTERPRISE;
    }
    for (int a = 1; a < netCount; ++a)
        for (int b = a; b > 0 && nets[b].rssi > nets[b - 1].rssi; --b) std::swap(nets[b], nets[b - 1]);
    WiFi.scanDelete();
    scannedAt = millis();
    Serial.printf("Scan: %d networks in range (radio returned %d)\n", netCount, n);
    for (int i = 0; i < netCount; ++i)
        Serial.printf("  %-32s %4ld dBm  ch %2ld  %s\n", nets[i].ssid.c_str(), (long)nets[i].rssi, (long)nets[i].channel,
                      nets[i].enterprise ? "enterprise" : nets[i].secure ? "password" : "open");
}

// Start joining a network. A username means WPA2-Enterprise with PEAP/MSCHAPv2
// (what university and office networks use); otherwise a WPA/WPA2 password.
// The server certificate is not checked: there is no CA for it on the panel.
void beginJoin(const String &ssid, const String &user, const String &pass, int32_t channel = 0, const uint8_t *bssid = nullptr) {
    if (user.length()) {
        WiFi.begin(ssid.c_str(), WPA2_AUTH_PEAP, user.c_str(), user.c_str(), pass.c_str(), nullptr, nullptr, nullptr, channel, bssid);
    } else {
        esp_wifi_sta_wpa2_ent_disable();  // left on by an earlier enterprise join
        WiFi.begin(ssid.c_str(), pass.c_str(), channel, bssid);
    }
}
int netIndex(const String &ssid) {
    for (int i = 0; i < netCount; ++i)
        if (nets[i].ssid == ssid) return i;
    return -1;
}

// ── Internet check and sign-in pages (captive portals) ───────────────────────
// Phones detect a sign-in page by fetching a "no content" URL: 204 means the
// internet is reachable; a redirect or a page means something is in the way.
// The panel then tries to sign in itself: it loads the portal, finds the login
// form, fills in the username/password typed on the panel (hidden fields and
// "accept terms" boxes as the page set them), and submits it. Portals that
// need JavaScript can't be handled this way; for those the panel shows its
// MAC address so IT can allow it on the network instead.
const char CHECK_URL[] = "http://connectivitycheck.gstatic.com/generate_204";
enum class Inet { Unknown, Online, Portal, Offline };
Inet inet = Inet::Unknown;
String portalUrl;
bool portalFailed = false;
uint32_t inetCheckedAt = 0;

String attrOf(const String &tag, const char *name) {
    String lower = tag;
    lower.toLowerCase();
    const String key = String(name) + "=";
    for (int i = lower.indexOf(key); i >= 0; i = lower.indexOf(key, i + key.length())) {
        if (i > 0 && !isspace(static_cast<unsigned char>(lower[i - 1]))) continue;
        const int v = i + key.length();
        if (v >= static_cast<int>(tag.length())) return "";
        String out;
        const char q = tag[v];
        if (q == '"' || q == '\'') {
            const int e = tag.indexOf(q, v + 1);
            out = tag.substring(v + 1, e < 0 ? tag.length() : e);
        } else {
            int e = v;
            while (e < static_cast<int>(tag.length()) && !isspace(static_cast<unsigned char>(tag[e])) && tag[e] != '>') ++e;
            out = tag.substring(v, e);
        }
        out.replace("&amp;", "&");
        out.replace("&quot;", "\"");
        out.replace("&#39;", "'");
        return out;
    }
    return "";
}
String urlEncode(const String &s) {
    String o;
    char b[4];
    for (size_t i = 0; i < s.length(); ++i) {
        const unsigned char c = s[i];
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += static_cast<char>(c);
        else if (c == ' ') o += '+';
        else { snprintf(b, sizeof(b), "%%%02X", c); o += b; }
    }
    return o;
}
String resolveUrl(const String &base, const String &ref) {
    if (ref.startsWith("http://") || ref.startsWith("https://")) return ref;
    const int scheme = base.indexOf("://");
    if (scheme < 0) return ref;
    const int hostEnd = base.indexOf('/', scheme + 3);
    const String origin = hostEnd < 0 ? base : base.substring(0, hostEnd);
    if (ref.startsWith("//")) return base.substring(0, scheme + 1) + ref;
    if (ref.startsWith("/")) return origin + ref;
    if (!ref.length()) return base;
    const int q = base.indexOf('?');
    const String path = q < 0 ? base : base.substring(0, q);
    const int slash = path.lastIndexOf('/');
    if (slash < scheme + 3) return origin + "/" + ref;
    return path.substring(0, slash + 1) + ref;
}
// Meta refresh or a JavaScript location change: where a page sends the browser.
String findRedirect(const String &html) {
    String lower = html;
    lower.toLowerCase();
    for (int m = lower.indexOf("http-equiv"); m >= 0; m = lower.indexOf("http-equiv", m + 10)) {
        const int end = lower.indexOf('>', m);
        const int u = lower.indexOf("url=", m);
        if (end < 0 || u < 0 || u > end || lower.substring(m, end).indexOf("refresh") < 0) continue;
        int s = u + 4;
        while (s < end && (html[s] == '\'' || html[s] == '"' || html[s] == ' ')) ++s;
        int e = s;
        while (e < end && html[e] != '"' && html[e] != '\'' && html[e] != '>') ++e;
        return html.substring(s, e);
    }
    for (const char *pat : {"location.href", "window.location", "location.replace", "location.assign"}) {
        const int p = lower.indexOf(pat);
        if (p < 0) continue;
        int q = p + strlen(pat);
        while (q < static_cast<int>(html.length()) && html[q] != '"' && html[q] != '\'' && html[q] != ';' && html[q] != '\n') ++q;
        if (q >= static_cast<int>(html.length()) || (html[q] != '"' && html[q] != '\'')) continue;
        const int e = html.indexOf(html[q], q + 1);
        if (e > q) return html.substring(q + 1, e);
    }
    return "";
}
// One request, no automatic redirects. Sign-in pages use their own (often
// self-signed) certificates, so HTTPS here skips verification; only portal
// pages go through this, never the Kaizen data.
int portalRequest(const String &url, bool post, const String &body, String &page, String &location) {
    WiFiClient plain;
    WiFiClientSecure tls;
    tls.setInsecure();
    HTTPClient http;
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.setConnectTimeout(6000);
    http.setTimeout(8000);
    const char *headers[] = {"Location"};
    http.collectHeaders(headers, 1);
    const bool ok = url.startsWith("https://") ? http.begin(tls, url) : http.begin(plain, url);
    if (!ok) return -1;
    http.addHeader("User-Agent", "Mozilla/5.0 (nnr_esp wall panel)");
    int code;
    if (post) {
        http.addHeader("Content-Type", "application/x-www-form-urlencoded");
        code = http.POST(body);
    } else {
        code = http.GET();
    }
    if (code > 0) {
        location = http.header("Location");
        page = http.getString();
        if (page.length() > 60000) page.remove(60000);
    }
    http.end();
    return code;
}
// GET, following HTTP redirects, meta refreshes and JS redirects (up to 6 hops).
int fetchPage(String url, String &page, String &finalUrl) {
    for (int hop = 0; hop < 6; ++hop) {
        String location;
        const int code = portalRequest(url, false, "", page, location);
        if (code >= 300 && code < 400 && location.length()) { url = resolveUrl(url, location); continue; }
        const String next = findRedirect(page);
        String lower = page;
        lower.toLowerCase();
        if (code == 200 && next.length() && lower.indexOf("<form") < 0) { url = resolveUrl(url, next); continue; }
        finalUrl = url;
        return code;
    }
    finalUrl = url;
    return -3;
}
Inet checkInternet() {
    inetCheckedAt = millis();
    WiFiClient client;
    HTTPClient http;
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    http.setConnectTimeout(5000);
    http.setTimeout(6000);
    const char *headers[] = {"Location"};
    http.collectHeaders(headers, 1);
    if (!http.begin(client, CHECK_URL)) return inet = Inet::Offline;
    const int code = http.GET();
    if (code == 204) {
        inet = Inet::Online;
        portalFailed = false;
    } else if (code >= 300 && code < 400) {
        portalUrl = http.header("Location");
        inet = Inet::Portal;
    } else if (code == 200) {
        const String next = findRedirect(http.getString());
        portalUrl = next.length() ? resolveUrl(CHECK_URL, next) : String(CHECK_URL);
        inet = Inet::Portal;
    } else {
        inet = Inet::Offline;
    }
    http.end();
    Serial.printf("Internet check: HTTP %d -> %s\n", code,
                  inet == Inet::Online ? "online" : inet == Inet::Portal ? "sign-in page" : "offline");
    return inet;
}
bool portalLogin(const String &user, const String &pass) {
    String page, url;
    const int code = fetchPage(portalUrl.length() ? portalUrl : String(CHECK_URL), page, url);
    Serial.printf("Sign-in page: HTTP %d, %u bytes\n", code, static_cast<unsigned>(page.length()));
    if (code != 200) return false;
    String lower = page;
    lower.toLowerCase();
    int pw = lower.indexOf("type=\"password\"");
    if (pw < 0) pw = lower.indexOf("type='password'");
    if (pw < 0) pw = lower.indexOf("type=password");
    const int form = pw >= 0 ? lower.lastIndexOf("<form", pw) : lower.indexOf("<form");
    if (form < 0) return false;
    int formEnd = lower.indexOf("</form>", form);
    if (formEnd < 0) formEnd = lower.length();
    const String formTag = page.substring(form, lower.indexOf('>', form) + 1);
    const String action = attrOf(formTag, "action");
    String method = attrOf(formTag, "method");
    method.toLowerCase();
    String body;
    bool userSet = false;
    for (int i = lower.indexOf("<input", form); i >= 0 && i < formEnd; i = lower.indexOf("<input", i + 6)) {
        const String tag = page.substring(i, lower.indexOf('>', i) + 1);
        String type = attrOf(tag, "type");
        type.toLowerCase();
        const String name = attrOf(tag, "name");
        String value = attrOf(tag, "value");
        if (!name.length()) continue;
        if (type == "password") value = pass;
        else if (!userSet && (type == "" || type == "text" || type == "email" || type == "tel" || type == "number")) {
            value = user;
            userSet = true;
        } else if (type == "checkbox" || type == "radio") {
            if (!value.length()) value = "on";
        } else if (type == "button" || type == "reset" || type == "file" || type == "image") {
            continue;
        }
        if (body.length()) body += '&';
        body += urlEncode(name);
        body += '=';
        body += urlEncode(value);
    }
    const String target = resolveUrl(url, action);
    String out, location;
    const int sent = method == "get"
        ? portalRequest(target + (target.indexOf('?') < 0 ? "?" : "&") + body, false, "", out, location)
        : portalRequest(target, true, body, out, location);
    Serial.printf("Sign-in form sent: HTTP %d\n", sent);
    if (sent >= 300 && sent < 400 && location.length()) {
        String out2, location2;
        portalRequest(resolveUrl(target, location), false, "", out2, location2);
    }
    delay(1500);
    return checkInternet() == Inet::Online;
}
// Sign in again with the details that worked last time on this network.
void autoPortalLogin() {
    static uint32_t lastTry = 0;
    const int k = knownIndex(currentSsid);
    if (k < 0 || !known[k].portalSaved || (lastTry && millis() - lastTry < 10 * 60 * 1000)) return;
    lastTry = millis();
    const bool ok = portalLogin(known[k].portalUser, known[k].portalPass);
    portalFailed = !ok;
    Serial.printf("Automatic sign-in: %s\n", ok ? "ok" : "failed");
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
        case Status::Portal: return L("This Wi-Fi needs sign-in  |  System Settings > Network",
                                      "Wi-Fi นี้ต้องลงชื่อเข้าใช้  |  ตั้งค่าระบบ > เครือข่าย");
        default: return L("Connecting to Wi-Fi...", "กำลังเชื่อมต่อ Wi-Fi...");
    }
}

void drawStatus() {
    ensureBackSynced();
    needPresent = true;
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
    ensureBackSynced();
    needPresent = true;
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
    ensureBackSynced();
    fullFramePending=true;
    needPresent = true;
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
        present(false);
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
enum class KbFor { WifiPass, PortalUser, PortalPass, EapUser, EapPass };
struct Keyboard {
    bool open = false;
    KbFor purpose = KbFor::WifiPass;
    char title[200] = "";
    char text[72] = "";
    bool masked = true, reveal = false;
    int layer = 0;  // 0 letters, 1 numbers, 2 symbols
    int shift = 0;  // 0 off, 1 next letter, 2 caps lock
    String ssid, portalUser;  // portalUser also holds the enterprise username
} kb;
void openKeyboard(KbFor purpose, const String &ssid, const String &initial = "");
void joinNetwork(const String &ssid, const String &pass, const String &user = "");
void busy(const char *message);
int netPage = 0, netShown = 0;

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
char note[200] = "";
uint32_t noteUntil = 0;
int armed = 0;            // control id waiting for its confirming second tap
uint32_t armedUntil = 0;

enum Ctl {
    C_CLOSE = 1, C_TAB, C_BRIGHT, C_NIGHT, C_FROM_M, C_FROM_P, C_TO_M, C_TO_P, C_NIGHT_LVL, C_ORIENT,
    C_LANG, C_REFRESH, C_TOUCH, C_IDLE, C_RECONNECT, C_FIELD, C_SOUND, C_REBOOT, C_RESET, C_OTA,
    C_NET, C_SCAN, C_FORGET, C_SIGNIN, C_NET_UP, C_NET_DOWN, C_CYCLE, C_CYCLE_SECS, C_CITY_OPEN, C_CITY_PICK, C_CITY_CLOSE, C_BOARD_ENABLE, C_BOARD_DURATION, C_STARTUP, C_FRESH
};
int cityDrop = -1;  // World clock dropdown open for slot 0-2 (clocks) or 3 (air quality); -1 closed

struct Control { Rect r; int id, aux; };
Control ctls[64];
int ctlCount = 0;
void addCtl(Rect r, int id, int aux = 0) {
    if (ctlCount < 64) ctls[ctlCount++] = {r, id, aux};
}

void setNote(const char *msg) {
    copyText(note, sizeof(note), msg);
    noteUntil = millis() + 2600;
}

void saveSettings() {
    readyPages=0; rebuildPages|=15; // layout, language, or navigation may have changed
    prefs.putUChar("bright", cfg.brightness);
    prefs.putBool("ndim", cfg.nightDim);
    prefs.putUShort("nfrom", cfg.nightFrom);
    prefs.putUShort("nto", cfg.nightTo);
    prefs.putUChar("nlvl", cfg.nightLevel);
    prefs.putBool("rot", cfg.rotated);
    prefs.putBool("cycle", cfg.rotate);
    prefs.putUShort("cycle_s", cfg.rotateSecs);
    prefs.putUChar("boards",cfg.enabledBoards); prefs.putUChar("startup",cfg.startupBoard); prefs.putBool("fresh",cfg.freshnessAlerts);
    for(int i=0;i<4;++i){char k[8];snprintf(k,sizeof(k),"dur%d",i);prefs.putUShort(k,cfg.boardDurations[i]);}
    for (int i = 0; i < 3; ++i) {
        char k[6];
        snprintf(k, sizeof(k), "clk%d", i);
        prefs.putUChar(k, cfg.clockCity[i]);
    }
    prefs.putUChar("airh", cfg.airHome);
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
    cfg.rotate = prefs.getBool("cycle", false);
    cfg.rotateSecs = constrain(static_cast<int>(prefs.getUShort("cycle_s", 30)), 15, 300);
    cfg.enabledBoards=prefs.getUChar("boards",15)&15;if(!cfg.enabledBoards)cfg.enabledBoards=15;
    cfg.startupBoard=prefs.getUChar("startup",0)%4; if(!boardEnabled(BOARDS[cfg.startupBoard])){for(int i=0;i<4;++i)if(boardEnabled(BOARDS[i])){cfg.startupBoard=i;break;}}
    cfg.freshnessAlerts=prefs.getBool("fresh",true);for(int i=0;i<4;++i){char k[8];snprintf(k,sizeof(k),"dur%d",i);cfg.boardDurations[i]=constrain((int)prefs.getUShort(k,i==3?15:cfg.rotateSecs),15,300);}
    current=defaultBoard(); deserializeJson(localAvailability,prefs.getString("r052","{}"));
    const int defaults[3] = {0, 2, 4};  // Chiang Mai, Tokyo, Taipei
    for (int i = 0; i < 3; ++i) {
        char k[6];
        snprintf(k, sizeof(k), "clk%d", i);
        cfg.clockCity[i] = prefs.getUChar(k, defaults[i]) % CITY_COUNT;
    }
    cfg.airHome = prefs.getUChar("airh", 0) % CITY_COUNT;
    cfg.refreshSecs = prefs.getUShort("poll", 60);
    cfg.idleSecs = prefs.getUShort("idle", 30);
    cfg.touch = prefs.getBool("touch", true);
}

// ── controls (sizes are the web's, scaled ~0.78) ──
void chip(int x, int y) {
    pill(x, y, "DEVICE", MUTED, blend(TEXT, BG, 18), 14, 0);
}
void toggle(int right, int cy, bool on, int id, bool enabled = true, int aux = 0) {
    const Rect r = {right - 42, cy - 12, 42, 24};
    aaRoundRect(r.x, r.y, r.w, r.h, 12, on ? BRAND : blend(TEXT, BG, enabled ? 30 : 14));
    aaCircle(on ? r.x + r.w - 12 : r.x + 12, cy, 9, enabled ? TEXT : blend(TEXT, BG, 90));
    if(enabled) addCtl(r, id, aux);
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

// Wi-Fi signal as four bars, and a padlock for secured networks.
void signalBars(int x, int cy, int rssi, uint16_t c) {
    const int level = rssi >= -60 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : rssi >= -85 ? 1 : 0;
    for (int b = 0; b < 4; ++b) {
        const int h = 4 + b * 3;
        aaRoundRect(x + b * 5, cy + 6 - h, 3, h, 1, b < level ? c : blend(c, BG, 60));
    }
}
void lockIcon(int x, int cy, uint16_t c) {
    aaRoundRect(x - 5, cy - 1, 10, 8, 2, c);
    screen.drawFastVLine(x - 3, cy - 5, 4, c);
    screen.drawFastVLine(x + 2, cy - 5, 4, c);
    screen.drawFastHLine(x - 2, cy - 6, 4, c);
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
    ensureBackSynced();
    fullFramePending=true;
    needPresent = true;
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
    // Section ids keep their numbers (other code refers to them); World clock
    // is section 5 but sits second in the rail, as on the web.
    const char *tabs[] = {L("Display", "หน้าจอ"), L("Data", "ข้อมูล"), L("Network", "เครือข่าย"),
                          L("Device", "อุปกรณ์"), L("About", "เกี่ยวกับ"), L("World clock", "นาฬิกาโลก"), L("Dashboards", "แดชบอร์ด")};
    const int order[] = {0, 6, 5, 1, 2, 3, 4};
    for (int pos = 0; pos < 7; ++pos) {
        const int i = order[pos];
        const Rect r = {OX + 6, OY + 58 + pos * 40, RAIL_W - 12, 34};
        const bool on = i == section;
        if (on) aaRoundRect(r.x, r.y, r.w, r.h, 7, BRAND);
        const uint16_t fg = on ? TEXT : MUTED;
        if (i == 6) iconDashboard(r.x + 10,r.y+11,fg);
        else if (i == 5) iconClock(r.x + 10, r.y + 11, fg);
        else tabIcon(i, r.x + 10, r.y + 11, fg, on ? BRAND : BG);
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
    } else if (section == 6) {
        int cy=beginRow(L("Rotate boards","สลับหน้าจออัตโนมัติ")); toggle(CX1,cy,cfg.rotate,C_CYCLE);
        cy=beginRow(L("Default dashboard","หน้าเริ่มต้น"));
        const char *shorts[]={"Kaizen","Resort","Rooms","Clock"}; const int ids[]={0,1,2,3};
        segmented(CX1,cy,shorts,ids,4,cfg.startupBoard,C_STARTUP);
        for(int i=0;i<4;++i){
            cy=beginRow(boardName(BOARDS[i])); bool enabled=boardEnabled(BOARDS[i]);
            toggle(CX1-245,cy,enabled,C_BOARD_ENABLE,!enabled||enabledCount()>1,i);
            const char *per[]={"15s","30s","1m","2m","5m"}; int nums[]={i*1000+15,i*1000+30,i*1000+60,i*1000+120,i*1000+300};
            if(enabled)segmented(CX1,cy,per,nums,5,i*1000+cfg.boardDurations[i],C_BOARD_DURATION);
        }
        cy=beginRow(L("Report freshness alerts","แจ้งเตือนข้อมูลเก่า"));toggle(CX1,cy,cfg.freshnessAlerts,C_FRESH);
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
        // Network, laid out like a phone's Wi-Fi screen: the current network,
        // then every network in range; tap one to join it.
        const bool up = WiFi.status() == WL_CONNECTED;
        if (up) {
            const char *state = inet == Inet::Portal ? L("Connected - sign-in required", "เชื่อมต่อแล้ว - ต้องลงชื่อเข้าใช้")
                              : inet == Inet::Offline ? L("Connected - no internet", "เชื่อมต่อแล้ว - ไม่มีอินเทอร์เน็ต")
                              : L("Connected", "เชื่อมต่อแล้ว");
            snprintf(v, sizeof(v), "%s  |  IP %s  |  %d dBm", state, WiFi.localIP().toString().c_str(), WiFi.RSSI());
            int cy = beginRow(currentSsid.c_str(), v);
            actionButton(CX1, cy, L("Forget", "ลืม"), C_FORGET, true);
            signalBars(CX1 - textWidth(L("Forget", "ลืม"), 1) - 28 - 34, cy, WiFi.RSSI(), TEXT);
            aaCircle(CX0 - 7, cy - 6, 3, inet == Inet::Online ? C_RESOLVED : C_PENDING);
        } else {
            beginRow(L("Not connected", "ไม่ได้เชื่อมต่อ"),
                     knownCount ? L("Looking for a remembered network...", "กำลังหาเครือข่ายที่บันทึกไว้...")
                                : L("Choose a network below", "เลือกเครือข่ายด้านล่าง"));
        }
        if (up && inet == Inet::Portal) {
            char hint[200];
            snprintf(hint, sizeof(hint), portalFailed ? L("Couldn't sign in. Ask IT to allow MAC %s", "ลงชื่อเข้าใช้ไม่ได้ ให้ฝ่าย IT อนุญาต MAC %s")
                                                      : L("The panel can sign in for you", "จอนี้ลงชื่อเข้าใช้ให้ได้"),
                     WiFi.macAddress().c_str());
            int cy = beginRow(L("This network has a sign-in page", "เครือข่ายนี้ต้องลงชื่อเข้าใช้ผ่านหน้าเว็บ"), hint);
            actionButton(CX1, cy, L("Sign in", "ลงชื่อเข้าใช้"), C_SIGNIN);
        }

        // Networks in range
        const int hy = rowY + 16;
        label(CX0, hy - 4, L("NETWORKS", "เครือข่ายที่พบ"), 0, MUTED);
        actionButton(CX1, hy, L("Scan", "สแกน"), C_SCAN);
        const int scanW = textWidth(L("Scan", "สแกน"), 1) + 28;
        rowY += 34;
        const int listBottom = OY + OH - 28;
        int i = netPage, shown = 0;
        for (; i < netCount; ++i) {
            if (up && nets[i].ssid == currentSsid) continue;
            if (rowY + 34 > listBottom) break;
            const int cy = rowY + 17;
            signalBars(CX0, cy, nets[i].rssi, TEXT);
            const int nw = utext(CX0 + 30, cy - 8, nets[i].ssid.c_str(), TEXT, 330);
            if (knownIndex(nets[i].ssid) >= 0) pill(CX0 + 30 + nw + 10, cy - 7, L("Saved", "บันทึกแล้ว"), MUTED, blend(TEXT, BG, 18), 14, 0);
            if (nets[i].secure) lockIcon(CX1 - 12, cy, MUTED);
            screen.drawFastHLine(CX0, rowY + 33, CX1 - CX0, BORDER);
            addCtl({CX0, rowY, CX1 - CX0, 34}, C_NET, i);
            rowY += 34;
            ++shown;
        }
        netShown = shown;
        const bool more = i < netCount;
        if (netPage > 0 || more) {  // page through a long list
            const Rect upR = {CX1 - scanW - 76, hy - 13, 30, 26}, downR = {CX1 - scanW - 40, hy - 13, 30, 26};
            arrowButton(upR, true, netPage > 0);
            arrowButton(downR, false, more);
            if (netPage > 0) addCtl(upR, C_NET_UP);
            if (more) addCtl(downR, C_NET_DOWN, i);
        }
        if (netCount == 0) label(CX0, rowY + 10, L("No networks found yet - tap Scan", "ยังไม่พบเครือข่าย - แตะสแกน"), 1, MUTED);
        snprintf(v, sizeof(v), "MAC %s  |  %s", WiFi.macAddress().c_str(),
                 L("2.4 GHz networks only", "รองรับเฉพาะ 2.4 GHz"));
        label(CX0, OY + OH - 22, v, 1, MUTED);
    } else if (section == 5) {
        // World clock: three cities and the air quality location. Each row is a
        // dropdown button ("Chiang Mai · Thailand  v"); tapping it opens the
        // list below, grouped by country.
        auto dropButton = [&](int cy, int index, int slot) {
            const Rect r = {CX1 - 260, cy - 16, 260, 32};
            const bool open = cityDrop == slot;
            aaRoundRect(r.x, r.y, r.w, r.h, 7, open ? BRAND : BORDER);
            aaRoundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 6, blend(TEXT, BG, 15));
            const CityDef &c = CITY_LIST[index];
            const int w = utext(r.x + 12, cy - 8, L(c.name, c.nameTh), TEXT, 130);
            char tail[96];
            snprintf(tail, sizeof(tail), " · %s", L(c.country, c.countryTh));
            utext(r.x + 12 + w, cy - 8, tail, MUTED, r.w - 44 - w);
            const int ax = r.x + r.w - 20;  // down arrow
            screen.fillTriangle(ax - 5, cy - 3, ax + 5, cy - 3, ax, cy + 3, MUTED);
            addCtl(r, C_CITY_OPEN, slot);
        };
        for (int i = 0; i < 3; ++i) {
            snprintf(v, sizeof(v), thai ? "นาฬิกา %d" : "Clock %d", i + 1);
            const int cy = beginRow(v, i == 0 ? L("Time and temperature for each city", "เวลาและอุณหภูมิของแต่ละเมือง") : nullptr);
            dropButton(cy, cfg.clockCity[i], i);
        }
        const int cy = beginRow(L("Air quality location", "ตำแหน่งวัดคุณภาพอากาศ"),
                                L("Nearest Air4Thai station (in Thailand)", "สถานี Air4Thai ที่ใกล้ที่สุด (ในประเทศไทย)"));
        dropButton(cy, cfg.airHome, 3);

        if (cityDrop >= 0) {
            // The open list covers the rows; only its own controls take taps,
            // and a tap anywhere outside it closes it.
            ctlCount = 0;
            const int current = cityDrop == 3 ? cfg.airHome : cfg.clockCity[cityDrop];
            const Rect p = {CX0 - 8, OY + 56, CX1 - CX0 + 16, OH - 62};
            aaRoundRect(p.x, p.y, p.w, p.h, 10, BORDER);
            aaRoundRect(p.x + 1, p.y + 1, p.w - 2, p.h - 2, 9, CARD);
            if (cityDrop == 3) copyText(v, sizeof(v), L("Air quality location", "ตำแหน่งวัดคุณภาพอากาศ"));
            else snprintf(v, sizeof(v), thai ? "นาฬิกา %d" : "Clock %d", cityDrop + 1);
            utext(p.x + 14, p.y + 9, v, TEXT, 400);
            const Rect x = {p.x + p.w - 40, p.y + 5, 32, 26};
            aaRoundRect(x.x, x.y, x.w, x.h, 6, blend(TEXT, CARD, 18));
            const int xc = x.x + x.w / 2, yc = x.y + x.h / 2;
            for (int k = 0; k <= 1; ++k) {
                screen.drawLine(xc - 5 + k, yc - 5, xc + 5 + k, yc + 5, TEXT);
                screen.drawLine(xc - 5 + k, yc + 5, xc + 5 + k, yc - 5, TEXT);
            }
            addCtl(x, C_CITY_CLOSE);
            screen.drawFastHLine(p.x + 1, p.y + 35, p.w - 2, BORDER);

            // 11 countries x 30 px fit between the header and the bottom edge.
            constexpr int LIST_ROW = 30, BTN_W = 160;
            int ry = p.y + 41;
            for (int i = 0; i < CITY_COUNT;) {
                const char *country = CITY_LIST[i].country;
                utext(p.x + 14, ry + (LIST_ROW - 16) / 2, L(country, CITY_LIST[i].countryTh), MUTED, 170);
                int bx = p.x + 190;
                for (; i < CITY_COUNT && strcmp(CITY_LIST[i].country, country) == 0; ++i) {
                    const Rect b = {bx, ry + 2, BTN_W, LIST_ROW - 4};
                    const bool on = i == current;
                    aaRoundRect(b.x, b.y, b.w, b.h, 6, on ? BRAND : blend(TEXT, CARD, 15));
                    const char *name = L(CITY_LIST[i].name, CITY_LIST[i].nameTh);
                    utext(b.x + 12, b.y + (b.h - 16) / 2, name, TEXT, b.w - 20);
                    addCtl(b, C_CITY_PICK, i);
                    bx += BTN_W + 8;
                }
                ry += LIST_ROW;
            }
            addCtl({0, 0, 800, 480}, C_CITY_CLOSE);  // outside the list: close
        }
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
        cy = beginRow(L("Earlier restarts", "การรีสตาร์ทก่อนหน้า"), L("Many brownout or power-on restarts: check the power supply", "brownout หรือ power-on หลายครั้ง: ตรวจสอบแหล่งจ่ายไฟ"), true);
        readOnly(CX1, cy, bootSummary().c_str());
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
    cityDrop = -1;
    drawSettings();
}
void closeSettings() {
    settingsOpen = false;
    kb.open = false;
    cityDrop = -1;
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
    ensureBackSynced();
    needPresent = true;
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
            case C_TAB:
                section = c.aux;
                cityDrop = -1;
                if (section == 2 && (!scannedAt || millis() - scannedAt > 30000)) {
                    drawSettings();
                    busy(L("Scanning...", "กำลังสแกน..."));
                    scanNetworks();
                    netPage = 0;
                }
                break;
            case C_SCAN:
                busy(L("Scanning...", "กำลังสแกน..."));
                scanNetworks();
                netPage = 0;
                break;
            case C_NET_UP: netPage = max(0, netPage - max(1, netShown)); break;
            case C_NET_DOWN: netPage = c.aux; break;
            case C_NET: {
                const String ssid = nets[c.aux].ssid;
                const int k = knownIndex(ssid);
                if (k >= 0) joinNetwork(ssid, known[k].pass, known[k].user);
                else if (nets[c.aux].enterprise) openKeyboard(KbFor::EapUser, ssid);
                else if (!nets[c.aux].secure) joinNetwork(ssid, "");
                else openKeyboard(KbFor::WifiPass, ssid);
                return;
            }
            case C_FORGET: {
                char msg[160];
                snprintf(msg, sizeof(msg), thai ? "ลืม %s แล้ว" : "Forgot %s", currentSsid.c_str());
                forgetNetwork(currentSsid);
                WiFi.disconnect();
                currentSsid = "";
                inet = Inet::Unknown;
                setNote(msg);
                connectStrongest();
                break;
            }
            case C_SIGNIN: {
                const int k = knownIndex(currentSsid);
                openKeyboard(KbFor::PortalUser, currentSsid, k >= 0 ? known[k].portalUser : "");
                return;
            }
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
            case C_CYCLE: cfg.rotate = !cfg.rotate; break;
            case C_CITY_OPEN: cityDrop = c.aux; break;
            case C_CITY_CLOSE: cityDrop = -1; break;
            case C_CITY_PICK: {
                int &idx = cityDrop == 3 ? cfg.airHome : cfg.clockCity[cityDrop];
                if (idx != c.aux) {
                    idx = c.aux;
                    ambientAt = 0;  // fetch the new city's weather / air quality now
                }
                cityDrop = -1;
                break;
            }
            case C_CYCLE_SECS: cfg.rotateSecs = c.aux; break;
            case C_BOARD_ENABLE: { auto b=BOARDS[c.aux]; if(boardEnabled(b)&&enabledCount()==1)break; cfg.enabledBoards^=1<<c.aux; if(!boardEnabled(defaultBoard()))for(int i=0;i<4;++i)if(boardEnabled(BOARDS[i])){cfg.startupBoard=i;break;} if(!boardEnabled(current))current=defaultBoard();break; }
            case C_BOARD_DURATION: cfg.boardDurations[c.aux/1000]=c.aux%1000;break;
            case C_STARTUP: if(boardEnabled(BOARDS[c.aux]))cfg.startupBoard=c.aux;else setNote("Enable this dashboard first");break;
            case C_FRESH: cfg.freshnessAlerts=!cfg.freshnessAlerts;break;
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
                    if (c.id == C_RESET) {
                        prefs.clear();
                        wprefs.clear();  // remembered networks too; device_config.h seeds again
                    }
                    else saveSettings();
                    fullFramePending = true;
    screen.fillScreen(BG);
                    labelCenter(400, 236, L("Restarting...", "กำลังรีสตาร์ท..."), 2, TEXT);
                    present(false);
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

// ── On-screen keyboard ───────────────────────────────────────────────────────
// iPhone-style: letters / numbers / symbols, shift (tap twice for caps lock),
// Show/Hide for passwords, Cancel and Join. Used for Wi-Fi passwords and for
// the username/password of a network's sign-in page.
enum KeyAction { K_CHAR, K_SHIFT, K_BACK, K_LAYER, K_LAYER2, K_SPACE, K_DONE, K_CANCEL, K_REVEAL };
struct Key { Rect r; char ch; int action; };
Key keys[52];
int keyCount = 0;
constexpr int KEY_W = 70, KEY_H = 48, KEY_GAP = 6, KB_TOP = 200;

void addKey(const Rect &r, char ch, int action) {
    if (keyCount < 52) keys[keyCount++] = {r, ch, action};
}
void keyCap(const Rect &r, const char *text, uint16_t bg, int size = 2) {
    aaRoundRect(r.x, r.y, r.w, r.h, 8, bg);
    labelCenter(r.x + r.w / 2, r.y + r.h / 2 - 4 * size, text, size, TEXT);
}
bool kbDoneEnabled() {
    if (kb.purpose == KbFor::WifiPass) return strlen(kb.text) >= 8;  // WPA needs 8+
    if (kb.purpose == KbFor::EapUser || kb.purpose == KbFor::EapPass) return kb.text[0] != 0;
    return true;
}
const char *kbDoneLabel() {
    return kb.purpose == KbFor::WifiPass || kb.purpose == KbFor::EapPass ? L("Join", "เข้าร่วม")
         : kb.purpose == KbFor::PortalUser || kb.purpose == KbFor::EapUser ? L("Next", "ถัดไป") : L("Sign in", "ลงชื่อเข้าใช้");
}

void drawKeyboard() {
    needPresent = true;
    keyCount = 0;
    fullFramePending = true;
    screen.fillScreen(BG);
    // top bar: Cancel | title | Join
    const Rect cancel = {PAD, 12, 110, 40};
    labelCenter(cancel.x + cancel.w / 2, cancel.y + 12, L("Cancel", "ยกเลิก"), 2, BRAND);
    addKey(cancel, 0, K_CANCEL);
    const char *done = kbDoneLabel();
    const int dw = textWidth(done, 2) + 36;
    const Rect doneR = {800 - PAD - dw, 12, dw, 40};
    keyCap(doneR, done, kbDoneEnabled() ? BRAND : blend(TEXT, BG, 25));
    addKey(doneR, 0, K_DONE);
    screen.drawFastHLine(0, 62, 800, BORDER);
    utext(PAD + 20, 80, kb.title, TEXT, 800 - 2 * PAD - 40);

    // field
    const Rect field = {PAD + 20, 112, 800 - 2 * PAD - 40, 50};
    aaRoundRect(field.x, field.y, field.w, field.h, 10, BORDER);
    aaRoundRect(field.x + 1, field.y + 1, field.w - 2, field.h - 2, 9, blend(TEXT, BG, 14));
    const int fy = field.y + field.h / 2;
    int tx = field.x + 16;
    if (!kb.text[0]) {
        label(tx + 10, fy - 8, kb.purpose == KbFor::PortalUser || kb.purpose == KbFor::EapUser ? L("Username", "ชื่อผู้ใช้") : L("Password", "รหัสผ่าน"), 2, MUTED);
    } else if (kb.masked && !kb.reveal) {
        for (size_t i = 0; i < strlen(kb.text); ++i) aaCircle(tx + 5 + static_cast<int>(i) * 14, fy, 4, TEXT);
        tx += static_cast<int>(strlen(kb.text)) * 14;
    } else {
        tx += aaText(fontFor(2), tx, fy + fontFor(2).capHeight / 2, kb.text, TEXT);
    }
    screen.fillRect(tx + 3, fy - 11, 2, 22, BRAND);  // cursor
    if (kb.masked) {
        const char *rv = kb.reveal ? L("Hide", "ซ่อน") : L("Show", "แสดง");
        const int rw = textWidth(rv, 1) + 28;
        const Rect revealR = {field.x + field.w - rw - 8, field.y + 9, rw, 32};
        aaRoundRect(revealR.x, revealR.y, revealR.w, revealR.h, 7, blend(TEXT, BG, 26));
        labelCenter(revealR.x + rw / 2, revealR.y + 12, rv, 1, TEXT);
        addKey(revealR, 0, K_REVEAL);
    }

    // keys
    static const char *ROWS[3][3] = {
        {"qwertyuiop", "asdfghjkl", "zxcvbnm"},
        {"1234567890", "-/:;()$&@\"", ".,?!'"},
        {"[]{}#%^*+=", "_\\|~<>`$&@", ".,?!'"},
    };
    for (int r = 0; r < 3; ++r) {
        const char *row = ROWS[kb.layer][r];
        const int n = strlen(row);
        const bool special = r == 2;
        const int rowW = n * KEY_W + (n - 1) * KEY_GAP + (special ? 2 * (100 + KEY_GAP) : 0);
        int x = (800 - rowW) / 2;
        const int y = KB_TOP + r * (KEY_H + 10);
        if (special) {
            const Rect s = {x, y, 100, KEY_H};
            if (kb.layer == 0) {
                keyCap(s, kb.shift == 2 ? "CAPS" : "Shift", kb.shift ? BRAND : blend(TEXT, BG, 22), 1);
                addKey(s, 0, K_SHIFT);
            } else {
                keyCap(s, kb.layer == 1 ? "#+=" : "123", blend(TEXT, BG, 22), 1);
                addKey(s, 0, K_LAYER2);
            }
            x += 100 + KEY_GAP;
        }
        for (int i = 0; i < n; ++i) {
            char c = row[i];
            if (kb.layer == 0 && kb.shift) c = toupper(c);
            const char cap[2] = {c, 0};
            const Rect k = {x, y, KEY_W, KEY_H};
            keyCap(k, cap, blend(TEXT, BG, 38));
            addKey(k, c, K_CHAR);
            x += KEY_W + KEY_GAP;
        }
        if (special) {
            const Rect b = {x, y, 100, KEY_H};
            keyCap(b, L("Delete", "ลบ"), blend(TEXT, BG, 22), 1);
            addKey(b, 0, K_BACK);
        }
    }
    const int y4 = KB_TOP + 3 * (KEY_H + 10);
    const Rect layerR = {(800 - (120 + KEY_GAP + 400 + KEY_GAP + 140)) / 2, y4, 120, KEY_H};
    keyCap(layerR, kb.layer == 0 ? "123" : "ABC", blend(TEXT, BG, 22), 1);
    addKey(layerR, 0, K_LAYER);
    const Rect space = {layerR.x + 120 + KEY_GAP, y4, 400, KEY_H};
    keyCap(space, L("space", "เว้นวรรค"), blend(TEXT, BG, 38), 1);
    addKey(space, ' ', K_SPACE);
    const Rect done2 = {space.x + 400 + KEY_GAP, y4, 140, KEY_H};
    keyCap(done2, done, kbDoneEnabled() ? BRAND : blend(TEXT, BG, 25), 1);
    addKey(done2, 0, K_DONE);
}

void closeKeyboard() {
    kb.open = false;
    memset(kb.text, 0, sizeof(kb.text));
    drawDashboard();
}
void openKeyboard(KbFor purpose, const String &ssid, const String &initial) {
    kb.open = true;
    kb.purpose = purpose;
    kb.ssid = ssid;
    copyText(kb.text, sizeof(kb.text), initial.c_str(), 63);
    kb.layer = 0;
    kb.shift = 0;
    kb.reveal = false;
    kb.masked = purpose != KbFor::PortalUser && purpose != KbFor::EapUser;
    if (purpose == KbFor::EapUser)
        snprintf(kb.title, sizeof(kb.title), thai ? "ชื่อผู้ใช้สำหรับ \"%s\" (เช่น CMU IT Account)"
                                                  : "Username for \"%s\" (e.g. your CMU IT Account)", ssid.c_str());
    else if (purpose == KbFor::EapPass)
        snprintf(kb.title, sizeof(kb.title), thai ? "รหัสผ่านสำหรับ \"%s\"" : "Password for \"%s\"", ssid.c_str());
    else if (purpose == KbFor::WifiPass)
        snprintf(kb.title, sizeof(kb.title), thai ? "ป้อนรหัสผ่านของ \"%s\"" : "Enter the password for \"%s\"", ssid.c_str());
    else if (purpose == KbFor::PortalUser)
        snprintf(kb.title, sizeof(kb.title), thai ? "ชื่อผู้ใช้สำหรับหน้าลงชื่อเข้าใช้ของ \"%s\" (เว้นว่างได้)"
                                                  : "Username for the sign-in page of \"%s\" (can be empty)", ssid.c_str());
    else
        snprintf(kb.title, sizeof(kb.title), thai ? "รหัสผ่านสำหรับหน้าลงชื่อเข้าใช้ของ \"%s\" (เว้นว่างได้)"
                                                  : "Password for the sign-in page of \"%s\" (can be empty)", ssid.c_str());
    settingsTouched = millis();
    drawKeyboard();
}

// A small modal card over the current frame, shown at once (before blocking work).
void busy(const char *message) {
    ensureBackSynced();
    fullFramePending=true;
    needPresent = true;
    aaRoundRect(180, 196, 440, 88, 14, BORDER);
    aaRoundRect(181, 197, 438, 86, 13, CARD);
    const int w = textWidth(message, 2);
    label(400 - min(w, 400) / 2, 232, message, 2, TEXT);
    present(false);
}

void joinNetwork(const String &ssid, const String &pass, const String &user) {
    kb.open = false;
    char msg[200];
    snprintf(msg, sizeof(msg), thai ? "กำลังเชื่อมต่อ %s..." : "Joining %s...", ssid.c_str());
    drawDashboard();
    busy(msg);
    WiFi.disconnect();
    delay(200);
    const int n = netIndex(ssid);
    if (n >= 0) beginJoin(ssid, user, pass, nets[n].channel, nets[n].bssid);
    else beginJoin(ssid, user, pass);
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    joinStarted = millis();
    const uint32_t t0 = millis();
    // An enterprise sign-in (TLS handshake + RADIUS) takes longer than a password.
    const uint32_t limit = user.length() ? 30000 : 15000;
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < limit) delay(200);
    const bool ok = WiFi.status() == WL_CONNECTED;
    Serial.printf("Join %s: %s\n", ssid.c_str(), ok ? "connected" : "failed");
    if (ok) {
        rememberNetwork(ssid, pass, user);
        currentSsid = ssid;
        configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
        checkInternet();
        if (inet == Inet::Portal) autoPortalLogin();
        snprintf(msg, sizeof(msg), thai ? "เชื่อมต่อ %s แล้ว" : "Connected to %s", ssid.c_str());
        nextPoll = millis();  // fetch the data now
    } else {
        if (user.length())
            snprintf(msg, sizeof(msg), thai ? "เชื่อมต่อ %s ไม่ได้ ตรวจสอบชื่อผู้ใช้และรหัสผ่าน" : "Couldn't join %s. Check the username and password.", ssid.c_str());
        else
            snprintf(msg, sizeof(msg), thai ? "เชื่อมต่อ %s ไม่ได้ ตรวจสอบรหัสผ่าน" : "Couldn't join %s. Check the password.", ssid.c_str());
        connectStrongest();  // back to a remembered network
    }
    memset(kb.text, 0, sizeof(kb.text));
    setNote(msg);
    settingsTouched = millis();
    section = 2;
    drawDashboard();
}

void portalSignIn(const String &user, const String &pass) {
    kb.open = false;
    drawDashboard();
    busy(L("Signing in...", "กำลังลงชื่อเข้าใช้..."));
    const bool ok = portalLogin(user, pass);
    portalFailed = !ok;
    if (ok) {
        const int k = knownIndex(currentSsid);
        if (k >= 0) {  // remember it, so the panel signs in again by itself
            known[k].portalSaved = true;
            known[k].portalUser = user;
            known[k].portalPass = pass;
            saveKnown();
        }
        nextPoll = millis();
    }
    memset(kb.text, 0, sizeof(kb.text));
    setNote(ok ? L("Signed in", "ลงชื่อเข้าใช้แล้ว") : L("Couldn't sign in", "ลงชื่อเข้าใช้ไม่ได้"));
    settingsTouched = millis();
    drawDashboard();
}

void keyboardTap(int x, int y) {
    settingsTouched = millis();
    for (int i = 0; i < keyCount; ++i) {
        const Key &k = keys[i];
        if (!k.r.in(x, y)) continue;
        const size_t len = strlen(kb.text);
        switch (k.action) {
            case K_CHAR:
            case K_SPACE:
                if (len < 63) { kb.text[len] = k.ch; kb.text[len + 1] = 0; }
                if (kb.shift == 1) kb.shift = 0;
                break;
            case K_BACK: if (len) kb.text[len - 1] = 0; break;
            case K_SHIFT: kb.shift = (kb.shift + 1) % 3; break;
            case K_LAYER: kb.layer = kb.layer == 0 ? 1 : 0; break;
            case K_LAYER2: kb.layer = kb.layer == 1 ? 2 : 1; break;
            case K_REVEAL: kb.reveal = !kb.reveal; break;
            case K_CANCEL: closeKeyboard(); return;
            case K_DONE: {
                if (!kbDoneEnabled()) return;
                const String text = kb.text;
                if (kb.purpose == KbFor::WifiPass) joinNetwork(kb.ssid, text);
                else if (kb.purpose == KbFor::EapUser) {
                    const String user = text;
                    openKeyboard(KbFor::EapPass, kb.ssid);
                    kb.portalUser = user;
                } else if (kb.purpose == KbFor::EapPass) joinNetwork(kb.ssid, text, kb.portalUser);
                else if (kb.purpose == KbFor::PortalUser) {
                    kb.portalUser = text;
                    const int kn = knownIndex(kb.ssid);
                    const String user = text;
                    openKeyboard(KbFor::PortalPass, kb.ssid, kn >= 0 ? known[kn].portalPass : "");
                    kb.portalUser = user;
                } else portalSignIn(kb.portalUser, text);
                return;
            }
        }
        drawKeyboard();
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

    // Occupancy forecast, next 14 days: rooms occupied out of rooms in the hotel
    {
        const int x = PAD, y = ROW_A_Y, w = LEFT_W, h = ROW_A_H;
        JsonArrayConst days = hotel["forecast"].as<JsonArrayConst>();
        int rooms = 1, n = 0;
        for (JsonObjectConst day : days) {
            if (n++ == 14) break;
            rooms = max(rooms, day["total"] | 0);
        }
        char title[96];
        snprintf(title, sizeof(title), thai ? "พยากรณ์การเข้าพัก 14 วัน · ห้อง (จาก %d)" : "OCCUPANCY FORECAST · NEXT 14 DAYS · ROOMS OF %d", rooms);
        panelBox(x, y, w, h, title);
        if (days.size() == 0) {
            labelCenter(x + w / 2, y + h / 2, L("No forecast in this report", "ไม่มีข้อมูลพยากรณ์"), 1, MUTED);
        } else {
            const int base = y + h - 20, area = h - 20 - 42;
            const int slot = (w - 20) / 14, barW = slot * 3 / 5;
            int d = 0;
            for (JsonObjectConst day : days) {
                if (d == 14) break;
                const int bx = x + 10 + d * slot + (slot - barW) / 2;
                const int occupied = constrain(static_cast<int>(day["rooms"] | 0), 0, rooms);
                const int bh = area * occupied / rooms;
                if (bh > 0) aaRoundRect(bx, base - bh, barW, bh, min(3, bh / 2), d == 0 ? BRAND : BAR_FORECAST);
                char v[8];
                snprintf(v, sizeof(v), "%d", occupied);
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

// ── World Clock board: mirrors src/components/WorldClockBoard.tsx ───────────
JsonObjectConst ambientCity(const char *key) {
    for (JsonObjectConst c : ambient["clocks"].as<JsonArrayConst>())
        if (strcmp(c["key"] | "", key) == 0) return c;
    return JsonObjectConst();
}
int cityOffset(int cityIndex) {
    JsonObjectConst c = ambientCity(CITY_LIST[cityIndex].key);
    return c.isNull() ? CITY_LIST[cityIndex].stdOffset : (c["offsetMin"] | CITY_LIST[cityIndex].stdOffset);
}

// 24x24 weather icons centred on (cx, cy), for the icon names kaizen-ambient sends.
void cloudShape(int cx, int cy, uint16_t c) {
    aaCircle(cx - 5, cy + 1, 6, c);
    aaCircle(cx + 2, cy - 3, 8, c);
    aaCircle(cx + 8, cy + 2, 5, c);
    aaRoundRect(cx - 11, cy + 1, 24, 7, 3, c);
}
void weatherIcon(const char *icon, int cx, int cy, uint16_t c, uint16_t bg) {
    const uint16_t sunC = rgb(0xfbbf24);
    if (!strcmp(icon, "sun")) {
        aaCircle(cx, cy, 6, sunC);
        for (int a = 0; a < 8; ++a) {
            const float r = a * PI / 4;
            screen.drawLine(cx + cosf(r) * 9, cy + sinf(r) * 9, cx + cosf(r) * 12, cy + sinf(r) * 12, sunC);
        }
    } else if (!strcmp(icon, "moon")) {
        aaCircle(cx, cy, 9, c);
        aaCircle(cx + 5, cy - 4, 8, bg);
    } else if (!strcmp(icon, "partly") || !strcmp(icon, "partly-night")) {
        if (!strcmp(icon, "partly")) aaCircle(cx - 5, cy - 5, 6, sunC);
        else { aaCircle(cx - 5, cy - 5, 6, c); aaCircle(cx - 2, cy - 8, 5, bg); }
        cloudShape(cx + 2, cy + 3, c);
    } else if (!strcmp(icon, "fog")) {
        for (int i = 0; i < 3; ++i) aaRoundRect(cx - 11 + (i % 2) * 3, cy - 7 + i * 6, 20, 3, 1, c);
    } else {
        cloudShape(cx, cy - 4, c);
        const uint16_t drop = rgb(0x60a5fa);
        if (!strcmp(icon, "rain") || !strcmp(icon, "drizzle")) {
            for (int i = -1; i <= 1; ++i) screen.drawLine(cx + i * 6 + 1, cy + 7, cx + i * 6 - 1, cy + (strcmp(icon, "rain") ? 9 : 12), drop);
        } else if (!strcmp(icon, "snow")) {
            for (int i = -1; i <= 1; ++i) aaCircle(cx + i * 6, cy + 10, 1, c);
        } else if (!strcmp(icon, "storm")) {
            screen.drawLine(cx + 1, cy + 6, cx - 2, cy + 11, sunC);
            screen.drawLine(cx - 2, cy + 11, cx + 2, cy + 11, sunC);
            screen.drawLine(cx + 2, cy + 11, cx - 1, cy + 15, sunC);
        }
    }
}

void drawClockBoard() {
    const int cw = (800 - 2 * PAD - 2 * GAP) / 3, cy0 = 56, ch = 196;
    const time_t utc = time(nullptr);
    const int homeOff = cityOffset(cfg.airHome);
    for (int i = 0; i < 3; ++i) {
        const int x = PAD + i * (cw + GAP);
        const int ci = cfg.clockCity[i];
        const CityDef &city = CITY_LIST[ci];
        JsonObjectConst wx = ambientCity(city.key);
        card(x, cy0, cw, ch);
        label(x + 14, cy0 + 12, L(city.name, city.nameTh), 2, TEXT);
        char country[64];
        upper(country, sizeof(country), pick(wx, "country", "countryTh"));
        label(x + 14, cy0 + 34, country, 0, MUTED);
        // UTC offset, and the difference from the panel's own location
        const int off = cityOffset(ci), diff = off - homeOff;
        char v[48];
        snprintf(v, sizeof(v), "UTC%c%d%s", off < 0 ? '-' : '+', abs(off) / 60, abs(off) % 60 ? ":30" : "");
        labelRight(x + cw - 14, cy0 + 13, v, 1, MUTED);
        if (diff == 0) copyText(v, sizeof(v), L("Same time", "เวลาเดียวกัน"));
        else if (thai) snprintf(v, sizeof(v), "%s %g ชม.", diff > 0 ? "เร็วกว่า" : "ช้ากว่า", abs(diff) / 60.0);
        else snprintf(v, sizeof(v), "%c%g h", diff > 0 ? '+' : '-', abs(diff) / 60.0);
        labelRight(x + cw - 14, cy0 + 29, v, 1, diff ? BRAND : MUTED);
        // time and date
        if (utc > 1700000000) {
            const time_t local = utc + off * 60;
            struct tm tm;
            gmtime_r(&local, &tm);
            char hhmm[8], date[20];
            strftime(hhmm, sizeof(hhmm), "%H:%M", &tm);
            strftime(date, sizeof(date), "%a %d %b", &tm);
            aaText(fontFor(5), x + 12, cy0 + 106, hhmm, TEXT);
            label(x + 14, cy0 + 116, date, 1, MUTED);
        } else {
            aaText(fontFor(5), x + 12, cy0 + 106, "--:--", MUTED);
        }
        // weather
        screen.drawFastHLine(x + 14, cy0 + 138, cw - 28, BORDER);
        if (!wx.isNull() && !wx["temp"].isNull()) {
            weatherIcon(wx["icon"] | "cloud", x + 30, cy0 + 166, TEXT, CARD);
            snprintf(v, sizeof(v), "%d°C", wx["temp"].as<int>());
            label(x + 52, cy0 + 150, v, 4, TEXT);
            const int tw = textWidth(v, 4);
            utext(x + 52 + tw + 10, cy0 + 158, pick(wx, "label", "labelTh"), MUTED, cw - 52 - tw - 24);
        } else {
            label(x + 14, cy0 + 160, ambientAt ? L("Weather unavailable", "ไม่มีข้อมูลอากาศ") : L("Loading...", "กำลังโหลด..."), 1, MUTED);
        }
    }

    // Air quality at the panel's location
    const int ay = 262, ah = 134, aw = 800 - 2 * PAD;
    JsonObjectConst air = ambient["air"].as<JsonObjectConst>();
    char title[128];
    snprintf(title, sizeof(title), "%s · %s", L("AIR QUALITY", "คุณภาพอากาศ"), L(CITY_LIST[cfg.airHome].name, CITY_LIST[cfg.airHome].nameTh));
    upper(title, sizeof(title), title);
    panelBox(PAD, ay, aw, ah, title);
    if (air.isNull()) {
        labelCenter(400, ay + ah / 2, ambientAt ? L("Air quality unavailable", "ไม่มีข้อมูลคุณภาพอากาศ") : L("Loading...", "กำลังโหลด..."), 1, MUTED);
        return;
    }
    const bool thaiScale = strcmp(air["scale"] | "TH", "TH") == 0;
    labelRight(PAD + aw - 12, ay + 10, thaiScale ? L("THAI AQI", "ดัชนีคุณภาพอากาศ (ไทย)") : "US AQI", 0, MUTED);
    JsonObjectConst level = air["level"].as<JsonObjectConst>();
    const uint16_t lc = parseColor(level["color"] | "", TEXT);
    char v[48];
    if (air["aqi"].isNull()) copyText(v, sizeof(v), "-");
    else snprintf(v, sizeof(v), "%d", air["aqi"].as<int>());
    const int aw1 = aaText(fontFor(5), PAD + 16, ay + 84, v, lc);
    label(PAD + 16 + aw1 + 8, ay + 72, "AQI", 0, MUTED);
    utext(PAD + 16, ay + 96, pick(level, "label", "labelTh"), lc, 220);

    // pollutants: the first (PM2.5) large, the rest smaller
    int px = PAD + 260, i = 0;
    for (JsonObjectConst pol : air["pollutants"].as<JsonArrayConst>()) {
        char val[16];
        snprintf(val, sizeof(val), "%g", pol["value"].as<float>());
        label(px, ay + 32, pol["key"] | "", 0, MUTED);
        const int size = i == 0 ? 3 : 2;
        label(px, ay + (i == 0 ? 46 : 50), val, size, TEXT);
        const int vw = textWidth(val, size);
        label(px + vw + 4, ay + (i == 0 ? 58 : 56), pol["unit"] | "", 1, MUTED);
        px += max(vw + textWidth(pol["unit"] | "", 1) + 30, 80);
        if (++i == 5 || px > PAD + aw - 80) break;
    }
    // scale bar with a marker at the current AQI
    static const uint32_t TH_BANDS[][2] = {{25, 0x3bccff}, {50, 0x92d050}, {100, 0xffff00}, {200, 0xffa200}, {300, 0xf04646}};
    static const uint32_t US_BANDS[][2] = {{50, 0x22c55e}, {100, 0xfacc15}, {150, 0xf97316}, {200, 0xef4444}, {300, 0xa855f7}, {400, 0x9f1239}};
    const uint32_t (*bands)[2] = thaiScale ? TH_BANDS : US_BANDS;
    const int nb = thaiScale ? 5 : 6, maxV = bands[nb - 1][0];
    const int bx = PAD + 260, bw = aw - 260 - 16, by = ay + 92;
    int prev = 0, xs = bx;
    for (int b = 0; b < nb; ++b) {
        const int xe = bx + static_cast<int>(static_cast<int64_t>(bw) * bands[b][0] / maxV);
        screen.fillRect(xs, by, xe - xs, 8, rgb(bands[b][1]));
        xs = xe;
        prev = bands[b][0];
    }
    (void)prev;
    if (!air["aqi"].isNull()) {
        const int mx = bx + min(bw, static_cast<int>(static_cast<int64_t>(bw) * air["aqi"].as<int>() / maxV));
        aaCircle(mx, by + 4, 8, BG);
        aaCircle(mx, by + 4, 5, TEXT);
    }
    // source line
    char src[200];
    JsonObjectConst st = air["station"].as<JsonObjectConst>();
    const char *t = air["time"] | "";
    const char *hhmm = strlen(t) >= 16 ? t + 11 : t;
    if (!st.isNull())
        snprintf(src, sizeof(src), "%s · %s (%g km) · %.5s", air["source"] | "", pick(st, "name", "nameTh"), st["km"].as<float>(), hhmm);
    else
        snprintf(src, sizeof(src), "%s · %.5s", air["source"] | "", hhmm);
    utext(bx, ay + 106, src, MUTED, bw);
}

// ── Screens and taps ─────────────────────────────────────────────────────────
// R052 compact snapshot: types {id,name,capacity}, days {date,available:[...]}.
void drawAvailability() {
    JsonObjectConst r=roomReport(); JsonArrayConst types=r["types"].as<JsonArrayConst>(), days=r["days"].as<JsonArrayConst>();
    const int left=PAD, top=65, width=800-2*PAD, gridY=104, labelW=148, stockW=39, colW=(width-labelW-stockW-12)/10;
    card(left,top,width,34); label(left+9,top+7,L("Room type availability | 10 days","ห้องว่างตามประเภท 10 วัน"),2,TEXT);
    const char *reportDate=r["reportDate"]|""; char asof[64];snprintf(asof,sizeof(asof),"%s %s",L("As of","ข้อมูล ณ วันที่"),reportDate);labelRight(left+width-10,top+12,asof,1,MUTED);
    if(types.size()==0||days.size()==0){card(left,gridY,width,300);labelCenter(400,220,L("No room availability report uploaded","ยังไม่มีรายงานห้องว่าง"),2,MUTED);return;}
    char today[11]=""; time_t now=time(nullptr);if(now>1700000000){now+=7*3600;struct tm t;gmtime_r(&now,&t);strftime(today,sizeof(today),"%Y-%m-%d",&t);}else copyText(today,sizeof(today),r["previewDate"]|reportDate);
    int start=0;while(start<(int)days.size() && strcmp(days[start]["date"]|"",today)<0)++start;
    const int rows=min(12,(int)types.size()); int rowH=min(31, (SWITCH_Y-gridY-42)/(rows+1));
    card(left,gridY,width,SWITCH_Y-gridY-6);
    label(left+8,gridY+9,L("ROOM TYPE","ประเภทห้อง"),1,MUTED);labelCenter(left+labelW+stockW/2,gridY+9,"STOCK",0,MUTED);
    for(int d=0;d<10;++d){int cx=left+labelW+stockW+d*colW+colW/2;const char *date=days[start+d]["date"]|"";char small[12]="-";if(strlen(date)>=10){const char *months[]={"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"};int m=atoi(date+5),day=atoi(date+8);if(m>=1&&m<=12)snprintf(small,sizeof(small),"%d %s",day,months[m-1]);}labelCenter(cx,gridY+9,small,0,d==0?BRAND:TEXT);}
    for(int i=0;i<=rows;++i){int y=gridY+32+i*rowH;bool total=i==rows;const char *id=total?"":(types[i]["id"]|"");bool divider=total||i==2||i==4||i==6||i==7;if(divider)screen.drawFastHLine(left+5,y-2,width-10,total?MUTED:BORDER);
        label(left+8,y+6,total?L("Total sellable","รวมพร้อมขาย"):(types[i]["name"]|id),1,total?TEXT:MUTED);int cap=0;if(total){for(int j=0;j<rows;++j)cap+=types[j]["capacity"]|0;}else cap=types[i]["capacity"]|0;char num[12];snprintf(num,sizeof(num),"%d",cap);labelCenter(left+labelW+stockW/2,y+6,num,1,MUTED);
        for(int d=0;d<10;++d){JsonArrayConst a=days[start+d]["available"].as<JsonArrayConst>();bool valid=a.size()==types.size();int v=0;if(valid){if(total){for(int j=0;j<rows;++j)v+=a[j].as<int>();}else v=a[i].as<int>();}int x=left+labelW+stockW+d*colW;uint16_t c=!valid?MUTED:v<0?rgb(0xc084fc):v==0?C_CRITICAL:v<=2?C_PENDING:C_RESOLVED;aaRoundRect(x+2,y+1,colW-4,rowH-5,4,blend(c,CARD,42));if(valid)snprintf(num,sizeof(num),"%d",v);else strcpy(num,"-");labelCenter(x+colW/2,y+5,num,2,c);}
    }
    int age=reportAge(r["updatedAt"]|reportDate);const char *legend="3+ Available | 1-2 Limited | 0 Sold out | negative Overbooked";label(left+8,SWITCH_Y-19,legend,0,MUTED);if(cfg.freshnessAlerts&&age>=0)labelRight(800-PAD-8,SWITCH_Y-19,freshLabel(age),0,freshColor(age));
}

void drawDashboard() {
    needPresent = true;
    fullFramePending = true;
    if (kb.open) {
        drawKeyboard();
        return;
    }
    fullFramePending = true;
    screen.fillScreen(BG);
    drawHeader();
    if (current == Screen::Kaizen) {
        drawKpis();
        drawTrend();
        drawOverview();
        drawAttention();
        drawCategories();
    } else if (current == Screen::Availability) {
        drawAvailability();
    } else if (current == Screen::Clock) {
        drawClockBoard();
    } else {
        drawHotel();
    }
    drawSwitcher();
    drawStatus();
    if (drill.open) drawDrill();
    if (settingsOpen) drawSettings();
}

// Render an inactive dashboard into its dedicated PSRAM buffer. Never touch
// a cache currently used by the LCD DMA. The caller must be outside overlays.
bool buildPageCache(int idx,bool paced=true){
    if(!pageCache[idx]||pageCache[idx]==front||settingsOpen||drill.open||kb.open||needPresent)return false;
    const Screen old=current;uint16_t *oldFb=fb;
    cachingPage=paced;current=BOARDS[idx];fb=pageCache[idx];screen.drawTo(fb);
    drawDashboard();
    for(int y=0;y<480;y+=8){Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(fb+y*800),8*1600);delayMicroseconds(30);}
    cachingPage=false;current=old;fb=oldFb;screen.drawTo(fb);needPresent=false;fullFramePending=false;anyDirty=false;memset(dirtyRow,0,sizeof(dirtyRow));
    readyPages|=1<<idx;rebuildPages&=~(1<<idx);
    Serial.printf("Cached dashboard %d\n",idx);return true;
}
void setupPageCaches(){
    if(!swapNodes||!back||back==front)return;
    for(int i=0;i<4;++i){pageCache[i]=static_cast<uint16_t*>(heap_caps_aligned_alloc(64,800UL*480UL*2,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));if(!pageCache[i]){Serial.println("Page cache unavailable; using standard frame swaps");return;}}
    needPresent=false;for(int i=0;i<4;++i)buildPageCache(i,false);
    Serial.printf("Ready page cache mask %u\n",(unsigned)readyPages);
}
void refreshPageCaches(){
    static uint32_t last=0;if(!rebuildPages||needPresent||settingsOpen||drill.open||kb.open||millis()-last<700)return;
    for(int i=0;i<4;++i)if((rebuildPages&(1<<i))&&pageCache[i]!=front){if(buildPageCache(i,true))last=millis();break;}
}

// The boards on the bottom row, in switcher (and rotation) order. A board added
// to the switcher goes here too and joins the rotation.
uint32_t boardShownAt = 0;

void showScreen(Screen next) {
    if(!boardEnabled(next))return;
    boardShownAt = millis();
    if (next == current && !drill.open && !settingsOpen) return;
    drill.open = false;
    settingsOpen = false;
    current = next;
    const int idx=static_cast<int>(next);
    if((readyPages&(1<<idx))&&pageCache[idx]&&swapToFrame(pageCache[idx])){Serial.printf("Cached page switch %d\n",idx);return;}
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
    readyPages=0; rebuildPages|=15;
    prefs.putBool("thai", thai);
    Serial.printf("Language: %s\n", thai ? "Thai" : "English");
    drawDashboard();
}

void handleTap(int x, int y) {
    lastTouch = millis();
    Serial.printf("Tap %d,%d\n", x, y);
    if (kb.open) {
        keyboardTap(x, y);
        return;
    }
    if (settingsOpen) {
        settingsTap(x, y);
        return;
    }
    if (drill.open) {
        drillTap(x, y);
        return;
    }
    if (y >= SWITCH_Y && y < SWITCH_Y + SWITCH_H) {
        const int w=switchWidth(), slot=(x-PAD)/(w+GAP);
        if(x<PAD||slot>enabledCount()||(x-PAD)%(w+GAP)>=w)return;
        if(slot==enabledCount())openSettings();else{int n=0;for(Screen b:BOARDS)if(boardEnabled(b)&&n++==slot){showScreen(b);break;}}
        return;
    }
    if (current == Screen::Kaizen) kaizenTap(x, y);
}

// ── Data ─────────────────────────────────────────────────────────────────────
uint32_t dataHash = 0;  // of the board's data, to skip redraws when nothing changed
uint32_t hashDetails() {
    String s;
    serializeJson(details, s);
    uint32_t h = 2166136261u;  // FNV-1a
    for (size_t i = 0; i < s.length(); ++i) h = (h ^ static_cast<uint8_t>(s[i])) * 16777619u;
    return h;
}
// World Clock data: weather per city and air quality (kaizen-ambient), every
// 10 minutes; the same device token as the Kaizen data.
bool fetchAmbient() {
    String url = DISPLAY_URL;
    url.replace("kaizen-esp-display", "kaizen-ambient");
    url += "?clocks=";
    for (int i = 0; i < 3; ++i) {
        if (i) url += ',';
        url += CITY_LIST[cfg.clockCity[i]].key;
    }
    url += "&home=";
    url += CITY_LIST[cfg.airHome].key;
    const int code = getJson(url.c_str(), ambient, nullptr);
    ambientOk = code == HTTP_CODE_OK;
    ambientAt = millis();
    Serial.printf("Ambient fetch: %d (air: %s)\n", code, ambientOk ? (ambient["air"]["source"] | "none") : "-");
    return ambientOk;
}

bool fetchDashboard() {
    JsonDocument filter;
    for (const Metric &metric : METRICS) filter[metric.key] = true;
    for (const char *key : {"title", "month", "resolutionRate", "avgResolution", "reopened",
                            "monthly", "categories", "attentionItems", "hotel", "roomAvailability"}) {
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
void connectStrongest() {
    scanNetworks();
    inet = Inet::Unknown;
    joinStarted = millis();
    for (int i = 0; i < netCount; ++i) {  // strongest first
        const int k = knownIndex(nets[i].ssid);
        if (k < 0) continue;
        currentSsid = nets[i].ssid;
        Serial.printf("Joining %s  ch %ld  %ld dBm\n", currentSsid.c_str(), (long)nets[i].channel, (long)nets[i].rssi);
        beginJoin(currentSsid, known[k].user, known[k].pass, nets[i].channel, nets[i].bssid);
        WiFi.setTxPower(WIFI_POWER_19_5dBm);
        return;
    }
    if (knownCount) {
        currentSsid = known[0].ssid;
        Serial.println("No remembered network in range; trying the most recent");
        beginJoin(currentSsid, known[0].user, known[0].pass);
    }
}

// Pinning a BSSID means auto-reconnect only retries that one AP, so if the link
// stays down, scan again and take whichever is strongest now. While connected
// but weak, check every few minutes for a clearly stronger AP. Each time the
// link comes up, restart the clock sync and look for a sign-in page.
void manageWifi() {
    static uint32_t lastConnected = 0, lastRoamCheck = 0;
    static bool wasConnected = false;
    const bool connected = WiFi.status() == WL_CONNECTED;
    if (connected) {
        lastConnected = millis();
        if (!wasConnected) {
            bootStage(BS_WIFI_UP);
            // SNTP started before the network was up can sit in back-off for minutes.
            configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
            if (millis() - inetCheckedAt > 20000 || inet == Inet::Unknown) checkInternet();
            if (inet == Inet::Portal) autoPortalLogin();
        }
    }
    wasConnected = connected;

    if (!connected && knownCount && millis() - joinStarted > REJOIN_AFTER_MS && millis() - lastConnected > REJOIN_AFTER_MS) {
        Serial.println("Wi-Fi down; rescanning");
        WiFi.disconnect();
        connectStrongest();
        return;
    }
    if (!connected || millis() - lastRoamCheck < ROAM_CHECK_MS) return;
    lastRoamCheck = millis();
    const int rssi = WiFi.RSSI();
    if (rssi >= ROAM_BELOW_DBM) return;
    scanNetworks();
    const int i = netIndex(currentSsid), k = knownIndex(currentSsid);
    if (i >= 0 && k >= 0 && nets[i].rssi >= rssi + ROAM_MARGIN_DB && memcmp(nets[i].bssid, WiFi.BSSID(), 6) != 0) {
        Serial.printf("Roaming: %d dBm here, %ld dBm on ch %ld\n", rssi, (long)nets[i].rssi, (long)nets[i].channel);
        WiFi.disconnect();
        beginJoin(currentSsid, known[k].user, known[k].pass, nets[i].channel, nets[i].bssid);
        joinStarted = millis();
    }
}

// ── Arduino ──────────────────────────────────────────────────────────────────
// LCD power-up fix: keep the lamp off, allow the board and LCD rail to settle,
// initialize a black frame before the panel is lit, and stagger radio startup.
// The RGB wiring is unchanged; the recovery trial uses 16 MHz.
static bool lcdReady = false;
void setup() {
    pinMode(BACKLIGHT, OUTPUT);
    digitalWrite(BACKLIGHT, LOW);
    Serial.begin(115200);
    delay(750);
    Serial.println("LCD startup: staged power and black-frame initialization");
    bootLogStart();
    bootLogPrint();
    prefs.begin("nnr_esp", false);
    loadSettings();
    thai = prefs.getBool("thai", false);
    ledcSetup(BL_CHANNEL, BL_FREQ_HZ, 8);
    ledcAttachPin(BACKLIGHT, BL_CHANNEL);
    ledcWrite(BL_CHANNEL, 0);
    if (!screen.begin() || !screen.getFramebuffer()) {
        Serial.println("LCD initialization failed; backlight held off; no invalid framebuffer access");
        return;
    }
    lcdReady = true;
    bootStage(BS_SCREEN);
    fb = front = screen.getFramebuffer();
    memset(front, 0, 800UL * 480UL * sizeof(uint16_t));
    Cache_WriteBack_Addr(reinterpret_cast<uint32_t>(front), 800UL * 480UL * sizeof(uint16_t));
    delay(150);  // send several black frames before drawing or enabling the lamp
    back = static_cast<uint16_t *>(heap_caps_aligned_alloc(64,800UL*480UL*2,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    if (back) {
        memcpy(back, front, 800 * 480 * 2);
        screen.drawTo(back);
        fb = back;
    } else {
        Serial.println("No PSRAM for the off-screen buffer; drawing directly");
        back = front;
    }
    workA=front;workB=back;
    vsyncInit();
    Serial.printf("VSYNC DMA swap: %s (%u descriptors)\n",back!=front&&swapNodes?"enabled":"fallback",(unsigned)swapNodes);
    wprefs.begin("wifi", false);
    loadKnown();
    touchBegin();
    applyRotation();
    setupPageCaches();
    if(!(readyPages&(1<<static_cast<int>(current)))||!swapToFrame(pageCache[static_cast<int>(current)])){drawDashboard();present(false);}
    for (int i = 0; i < 4; ++i) waitVsync();
    // Light the panel gently at low duty during the initial Wi-Fi scan.
    for (int duty = 0; duty <= 16; duty += 2) { ledcWrite(BL_CHANNEL, duty); delay(20); }
    bootStage(BS_BACKLIGHT);
    delay(350);
    // Wi-Fi starts even with no network remembered: one can be picked on the panel.
    const bool endpointSet = DISPLAY_TOKEN[0] && ROOT_CA[0] && strncmp(DISPLAY_URL, "https://", 8) == 0;
    if (!endpointSet) {
        status = Status::Unconfigured;
        drawDashboard();
        present(false);
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
    // Say why a join failed (wrong password, no AP, enterprise sign-in refused...).
    // Repeats of the same reason are not printed again.
    WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t info) {
        static uint8_t last = 0;
        const uint8_t reason = info.wifi_sta_disconnected.reason;
        if (reason == last) return;
        last = reason;
        Serial.printf("Wi-Fi left %.*s: reason %u (%s)\n", (int)info.wifi_sta_disconnected.ssid_len,
                      reinterpret_cast<const char *>(info.wifi_sta_disconnected.ssid), reason, WiFi.disconnectReasonName(static_cast<wifi_err_reason_t>(reason)));
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    bootStage(BS_WIFI_START);
    connectStrongest();
    // Ramp to the configured duty after the radio has initialized; avoid two
    // large current changes at once. Normal brightness control resumes in loop.
    const int pct = nightNow() ? cfg.nightLevel : cfg.brightness;
    const float f = constrain(pct, 10, 100) / 100.0f;
    const int target = max(2, static_cast<int>(lroundf(255.0f * powf(f, 2.2f))));
    for (int i = 1; i <= 20; ++i) { ledcWrite(BL_CHANNEL, 16 + (target - 16) * i / 20); delay(25); }
    applyBrightness();
    Serial.println("LCD startup complete: first frame, radio, and backlight ready");
}

void quietScanTest() {
    WiFi.disconnect();
    delay(300);
    for (int i = 0; i < 2; ++i) { Serial.println("QUIET TEST normal:"); scanNetworks(); }
    ledcWrite(BL_CHANNEL, 0);
    delay(300);
    for (int i = 0; i < 2; ++i) { Serial.println("QUIET TEST backlight off:"); scanNetworks(); }
    // DE, VSYNC, HSYNC, PCLK and the 16 data lines: take them off the LCD
    // peripheral and hold them low, so nothing toggles on the ribbon.
    static const int RGB_PINS[] = {40, 41, 39, 42, 45, 48, 47, 21, 14, 5, 6, 7, 15, 16, 4, 8, 3, 46, 9, 1};
    for (int pin : RGB_PINS) {
        esp_rom_gpio_connect_out_signal(pin, SIG_GPIO_OUT_IDX, false, false);
        gpio_set_direction(static_cast<gpio_num_t>(pin), GPIO_MODE_OUTPUT);
        gpio_set_level(static_cast<gpio_num_t>(pin), 0);
    }
    delay(300);
    for (int i = 0; i < 2; ++i) { Serial.println("QUIET TEST backlight off + LCD bus still:"); scanNetworks(); }
    Serial.println("QUIET TEST done; restarting");
    delay(200);
    ESP.restart();
}

void serialCommand(int cmd) {
    if (cmd > ' ' && cmd != '@') Serial.printf("Command %c\n", cmd);
    // S = screenshot. For testing without touching the panel:
    // K / H = Kaizen / Hotel, T = settings (1-5 pick a tab, N toggles night dim),
    // L = toggle language, B = restart log, W = rescan Wi-Fi, R = recalibrate the radio,
    // D = open the Total drill-down, E = expand its first case, X = close it.
    if (cmd == '@') {  // "@x,y": a tap at x,y, for testing flows over serial
        int x, y;
        const String s = Serial.readStringUntil('\n');
        if (sscanf(s.c_str(), "%d,%d", &x, &y) == 2) handleTap(x, y);
        return;
    }
    if (cmd == 'U') {
        Serial.setTimeout(3000); String line=Serial.readStringUntil('\n'); Serial.setTimeout(1000);
        JsonDocument d; bool ok=line.length()<3900 && !deserializeJson(d,line) && d["types"].is<JsonArray>() && d["days"].is<JsonArray>() && d["types"].size()>0 && d["types"].size()<=12 && d["days"].size()<=62;
        if(ok){ for(JsonVariant day:d["days"].as<JsonArray>())if(day["available"].size()!=d["types"].size())ok=false; }
        if(ok){ if(prefs.putString("r052",line)>0){localAvailability=std::move(d); rebuildPages|=1<<static_cast<int>(Screen::Availability); Serial.println("R052 saved");drawDashboard();}else Serial.println("R052 storage failed"); }else Serial.println("R052 invalid"); return;
    }
    if (cmd == 'S') { present(false); dumpScreen(); }
    else if (cmd == 'K') showScreen(Screen::Kaizen);
    else if (cmd == 'A') { lastTouch=millis();showScreen(Screen::Availability); }
    else if (cmd == 'H') { lastTouch = millis(); showScreen(Screen::Hotel); }
    else if (cmd == 'T') openSettings();
    else if (cmd >= '1' && cmd <= '7' && settingsOpen) { section = cmd - '1'; cityDrop = -1; settingsTouched = millis(); drawSettings(); }
    else if (cmd == 'C') { lastTouch = millis(); showScreen(Screen::Clock); }
    else if (cmd == 'N' && settingsOpen) { cfg.nightDim = !cfg.nightDim; saveSettings(); applyBrightness(); drawSettings(); }
    else if (cmd == 'L') setLanguage(!thai);
    else if (cmd == 'D' && hasData) { showScreen(Screen::Kaizen); openDrill('s', "total", L(METRICS[0].en, METRICS[0].th), TEXT); }
    else if (cmd == 'E' && drill.open && drill.rows > 0) drillTap(drill.rowRect[0].x + 40, drill.rowRect[0].y + 10);
    else if (cmd == 'X' && drill.open) closeDrill();
    else if (cmd == 'B') bootLogPrint();
    else if (cmd == 'W') scanNetworks();
    // Q = is the board drowning out its own radio? Scan normally, then with the
    // backlight off, then with the RGB bus lines held still too, and restart.
    // More networks once it is quiet = self-interference; no change = antenna.
    else if (cmd == 'Q') quietScanTest();
    // R = throw away the radio's stored calibration and restart, so it calibrates
    // from scratch. Bad calibration data leaves the radio deaf: every scan finds 0.
    else if (cmd == 'R') {
        Serial.printf("Erasing RF calibration (%d); restarting\n", (int)esp_phy_erase_cal_data_in_nvs());
        delay(200);
        ESP.restart();
    }
}

void loop() {
    if (!lcdReady) { delay(1000); return; }
    if (Serial.available()) serialCommand(Serial.read());
    bootLogTick();
    int tx, ty;
    const Touch ev = touchPoll(tx, ty);
    if (ev == Touch::Down) handleTap(tx, ty);
    else if (ev == Touch::Move && dragging && settingsOpen) { settingsTouched = millis(); sliderDrag(tx); }
    else if (ev == Touch::Up && dragging) { dragging = 0; saveSettings(); }
    if (drill.open && millis() - drill.touched > drillIdleMs()) closeDrill();
    if (settingsOpen && millis() - settingsTouched > SETTINGS_IDLE_MS) closeSettings();
    if (settingsOpen && note[0] && millis() > noteUntil) { note[0] = 0; drawSettings(); }
    if (settingsOpen && armed && millis() > armedUntil) { armed = 0; drawSettings(); }
    if (cfg.rotate) {
        // Rotation: the next board after its time, paused while a list,
        // settings or the keyboard is open; a tap restarts the countdown.
        const uint32_t since = millis() - max(boardShownAt, lastTouch);
        if (!settingsOpen && !drill.open && !kb.open && enabledCount() > 1 && since >= cfg.boardDurations[static_cast<int>(current)] * 1000UL) {
            int i = 0;
            while (i < BOARD_COUNT && BOARDS[i] != current) ++i;
            do { i=(i+1)%BOARD_COUNT; } while(!boardEnabled(BOARDS[i]));
            const Screen next=BOARDS[i];
            Serial.printf("Rotate: %s\n", next == Screen::Hotel ? "Hotel" : next == Screen::Clock ? "World Clock" : "Kaizen");
            showScreen(next);
        }
    }
    if (WiFi.getMode() != WIFI_STA) {
        delay(20);
        return;
    }
    if (static_cast<int32_t>(millis() - nextPoll) >= 0) {
        const bool connected = WiFi.status() == WL_CONNECTED;
        const bool clockReady = time(nullptr) > 1700000000;
        const bool success = connected && clockReady && fetchDashboard();
        // Data blocked while connected: look for a sign-in page (at most once a minute).
        if (connected && !success && millis() - inetCheckedAt > 60000) {
            checkInternet();
            if (inet == Inet::Portal) autoPortalLogin();
        }
        if (connected) {
            Serial.printf("Wi-Fi ok, RSSI %d dBm, ch %ld, AP %s, fetch %s\n", WiFi.RSSI(),
                          (long)WiFi.channel(), WiFi.BSSIDstr().c_str(),
                          success ? "ok" : !clockReady ? "waiting for clock" : "failed");
        }
        if (success) bootStage(BS_DATA);
        status = success ? Status::Live : (connected && inet == Inet::Portal) ? Status::Portal
                 : hasData ? Status::Stale : !connected ? Status::NoWifi
                 : !clockReady ? Status::NoClock : Status::Unavailable;
        // Don't repaint the board under an open list or settings; it refreshes on close.
        static Status shownStatus = Status::Connecting;
        const uint32_t h = hashDetails();
        if (!drill.open && !settingsOpen && (h != dataHash || status != shownStatus)) {
            rebuildPages|=15;
            drawDashboard();
            fadeNext = false;  // instantaneous updates; avoid extra PSRAM traffic at 16 MHz
            dataHash = h;
            shownStatus = status;
        }
        nextPoll = millis() + (success ? pollMs() : RETRY_MS);
    }
    if ((!ambientAt || millis() - ambientAt > AMBIENT_MS) && WiFi.status() == WL_CONNECTED && time(nullptr) > 1700000000) {
        fetchAmbient();
        rebuildPages|=1<<static_cast<int>(Screen::Clock);
        if (current == Screen::Clock && !drill.open && !settingsOpen && !kb.open) {
            drawDashboard();
            fadeNext = false;
        }
    }
    static int shownMinute = -1;  // the World Clock shows minutes: redraw when one passes
    const int minuteNow = static_cast<int>((time(nullptr) / 60) % 60);
    static int cachedMinute=-1; if(minuteNow!=cachedMinute){cachedMinute=minuteNow;rebuildPages|=1<<static_cast<int>(Screen::Clock);}
    if (current == Screen::Clock && minuteNow != shownMinute && !drill.open && !settingsOpen && !kb.open) {
        shownMinute = minuteNow;
        drawDashboard();
        fadeNext = false;
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
    if (needPresent) present(fadeNext);
    refreshPageCaches();
    delay(20);  // short, so taps feel immediate
}
