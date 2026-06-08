# Next steps — to pick up later

_Last updated: 2026-06-08. Notes captured before stepping away._

## 1. PMS tab — filter row layout & labels
File: `src/pages/PreventiveMaintenancePage.tsx` (the filter `<div className="flex flex-wrap items-center gap-2 mb-3">`).

- [ ] Keep all the filter controls **on the same line**:
      `[All Equipment] [All Area] [All Departments] [Inactive]`
      (consider `flex-nowrap` + horizontal scroll on small screens, or smaller controls, so they don't wrap).
- [ ] Rename the **location** filter placeholder from **"All Locations" → "All Area"**.
      (Only the dropdown label; the underlying field is still `location`. Decide later if "Location" should be relabelled to "Area" elsewhere too — asset card, asset form `tr.pm` strings.)
- [ ] Add a **symbol/emoji in front of "Inactive"** on the toggle button to signal it
      (e.g. `🚫 Inactive` or a `Ban`/`PowerOff` lucide icon).

## 2. Cases — new "PMS" tab (between Active and Pending)
File: `src/pages/CasesPage.tsx` (status tabs row) + reuse the calendar case popup.

- [ ] Add a **"PMS" tab between Active and Pending**.
- [ ] It lists **current active, non-overdue PMS cases** — i.e. cases where
      `case_number LIKE 'PM-%'` (or `category = 'preventive_maintenance'`),
      `status` not closed, and **not overdue** (per `isSLABreached`).
- [ ] Next to the **"PMS Active cases" heading**, add a **month selector**
      (previous / this / next month) to view the active PMS cases for that month
      — mirror the Month nav already used on the Console dashboard / PM calendar.
- [ ] Clicking a PMS case should **open a popup** (modal quick-view) like clicking a
      case in the **Calendar tab** — reuse the modal pattern from
      `src/pages/CasesCalendarPage.tsx` / `src/components/pm/PMSchedule.tsx`
      (`PMTaskModal` / case modal) rather than navigating to `/cases/:id`.

---
### Context already shipped (so you don't redo it)
- PM overdue → auto Case (`PM-…`, category **Preventive Maintenance**, priority High, **Opened by: PMS**); auto-prompt to assign PIC + due date; dept-manager/Top-Mgmt can change priority.
- PM assets seeded (22) with serial no, model, checklist, last & next maintenance, purchase date.
- PM page: search matches name/tag/serial/model/notes; filter bar (Equipment/Location/Department/Inactive); Inactive counter tile removed.
- Resolution rules, chronic detection (location+category+title), overdue logic (due_date + skip approval-waiting), notifications link PM→/maintenance.
- `/debug` skill (local) + `scripts/run_sql.sh` for DB via Management API.
