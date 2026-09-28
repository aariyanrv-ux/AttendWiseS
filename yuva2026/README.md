# AttendWise

AttendWise is a Flask and SQLite attendance planner for the Aug 29-Nov 29, 2026 semester. Attendance math runs in the browser and in a standalone Python service; no ML is used for calculations.

## Run

Requires Python 3.10 or later.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000`. The SQLite database is created at `instance/attendwise.sqlite3`; set `ATTENDWISE_DATABASE` to use another path. No sample timetable is seeded. The demo uses explicitly synthetic sections and attendance values.

## Verified Timetable Import

The PDFs supplied in `C:\dataset` are image-based: all 13 pages returned zero selectable text. OCR can surface headings, but it misreads subject codes, slots, and table cells. No timetable rows have been guessed or imported. Manually verify the academic year, section, subject codes/names, weekday, slot, periods, lab units, break entries, and rooms before posting normalized JSON. Only academic year `2026-27` is accepted.

`POST /api/timetable/import` accepts this shape; replace every placeholder with manually verified source values:

```json
{
  "academic_year": "2026-27",
  "verified": true,
  "section": "verified section name",
  "subjects": [
    {"subject_code": "verified code", "name": "verified subject name"}
  ],
  "entries": [
    {
      "subject_code": "verified code",
      "weekday": 0,
      "slot": "verified slot",
      "period_start": 1,
      "period_end": 1,
      "is_lab": false,
      "attendance_mode": "session",
      "units": 1,
      "room": "verified room"
    },
    {
      "is_break": true,
      "label": "verified break name",
      "weekday": 0,
      "slot": "verified break slot",
      "period_start": 3,
      "period_end": 3
    }
  ]
}
```

Weekdays are Monday `0` through Sunday `6`. For a period-counted lab, set `attendance_mode` to `period`; `units` then defaults to the number of periods if omitted. `session` mode counts a lab meeting as one unit unless units are supplied. Use `POST /api/calendar-exceptions` for holidays, cancellations, and makeup classes. Timetable entries never create attendance history.

## Calculator Behavior

- `static/section_counts.json` contains the processed dataset's 14 section weekly and full-semester totals. Partial-date figures are estimated by distributing each section's weekly total evenly over Monday-Friday; the supplied summary has no per-weekday schedule. Weekends are excluded.
- Enter the student's current attendance percentage. The provided processed dataset contains class counts, not the student's personal attendance sheet values.
- Current attendance is `100 * attended / conducted`; zero conducted displays as not started.
- Recovery uses exact integer equivalents: 90% requires `max(0, 9C - 10A)` future attended classes; 75% requires `max(0, 3C - 4A)`.
- Remaining-class forecasts begin tomorrow; entered attendance totals are treated as current through today.
- Safe misses use the exact floor form of `floor(A/t - C)` and are zero below the selected threshold.
- A what-if plan cannot allocate more future attended and missed classes than are scheduled through its selected date.
- The `Irreversible Detention` alert means 75% is unreachable by Nov 29, even if every remaining scheduled unit is attended. It is not triggered by a low percentage alone.
- The dashboard can recalculate from cached schedule data offline. The external Chart.js file is optional; a local visual fallback is used when unavailable.

## API And Tests

- `GET /api/sections`
- `POST /api/sections`
- `POST /api/timetable/import`
- `POST /api/attendance/summary`
- `POST /api/attendance`
- `GET /api/forecast?section_id=...&planning_date=YYYY-MM-DD`
- `POST /api/simulate`
- `POST /api/calendar-exceptions`

Run tests with `python -m unittest discover -s tests`. The suite covers exact attendance boundaries, forecast feasibility, semester dates, calendar exceptions, lab units, and academic-year validation.
