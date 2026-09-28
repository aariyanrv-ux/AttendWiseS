from datetime import date, timedelta

from flask import Flask, jsonify, render_template, request, send_from_directory

from services.attendance import AttendanceInputError, calculate_attendance, projected_percentage
from services.database import connect, initialize
from services.schedule import count_remaining


app = Flask(__name__, static_folder="static", template_folder="templates")


def error(message, status=400):
    return jsonify({"error": message}), status


def as_date(value, name):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be an ISO date (YYYY-MM-DD)") from None


def required_text(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value.strip()


def get_snapshot(connection, section_id, planning_date=None):
    section = connection.execute(
        "SELECT s.id, s.name, s.academic_year, s.schedule_verified, c.start_date, c.end_date "
        "FROM sections s CROSS JOIN semester_config c WHERE s.id = ? AND c.id = 1",
        (section_id,),
    ).fetchone()
    if section is None:
        return None

    subjects = connection.execute(
        "SELECT id, subject_code, name FROM subjects WHERE section_id = ? ORDER BY name",
        (section_id,),
    ).fetchall()
    entries = [dict(row) for row in connection.execute(
        "SELECT e.* FROM timetable_entries e WHERE e.section_id = ?", (section_id,)
    ).fetchall()]
    exceptions = [dict(row) for row in connection.execute(
        "SELECT x.* FROM calendar_exceptions x "
        "LEFT JOIN subjects s ON s.id = x.subject_id "
        "WHERE x.subject_id IS NULL OR s.section_id = ?", (section_id,)
    ).fetchall()]
    records = [dict(row) for row in connection.execute(
        "SELECT a.* FROM attendance a JOIN subjects s ON s.id = a.subject_id "
        "WHERE s.section_id = ?", (section_id,)
    ).fetchall()]
    totals = {
        row["subject_id"]: dict(row)
        for row in connection.execute(
            "SELECT subject_id, attended, conducted FROM attendance_totals "
            "WHERE subject_id IN (SELECT id FROM subjects WHERE section_id = ?)",
            (section_id,),
        ).fetchall()
    }
    recorded_keys = {(row["subject_id"], row["class_date"], row["slot"]) for row in records}
    today = date.today()
    forecast_start = max(as_date(section["start_date"], "semester start"), today + timedelta(days=1))
    semester_end = as_date(section["end_date"], "semester end")
    planning_date = planning_date or semester_end
    if planning_date > semester_end:
        raise ValueError("planning_date must be within the semester.")
    term_remaining = count_remaining(
        entries,
        exceptions,
        forecast_start,
        semester_end,
        today=forecast_start,
        recorded=recorded_keys,
    )
    planned_remaining = count_remaining(
        entries,
        exceptions,
        forecast_start,
        planning_date,
        today=forecast_start,
        recorded=recorded_keys,
    )

    results = []
    for subject in subjects:
        subject_records = [row for row in records if row["subject_id"] == subject["id"]]
        total = totals.get(subject["id"])
        conducted = total["conducted"] if total else sum(row["units"] for row in subject_records)
        attended = total["attended"] if total else sum(
            row["units"] for row in subject_records if row["attended"]
        )
        future = term_remaining.get(subject["id"], 0)
        by_plan = planned_remaining.get(subject["id"], 0)
        metrics = calculate_attendance(attended, conducted, future)
        planned_metrics = calculate_attendance(attended, conducted, by_plan)
        next_slots = sorted(
            [entry for entry in entries if entry["subject_id"] == subject["id"] and not entry["is_break"]],
            key=lambda entry: (entry["weekday"], entry["period_start"]),
        )
        results.append({
            "id": subject["id"],
            "subject_code": subject["subject_code"],
            "name": subject["name"],
            "attended": attended,
            "conducted": conducted,
            "remaining": future,
            "metrics": metrics,
            "classes_by_planning_date": by_plan,
            "planning_targets": {
                target: planned_metrics["recovery"][target]
                for target in ("75", "90")
            },
            "weekly_slots": [
                {"weekday": entry["weekday"], "slot": entry["slot"],
                 "period_start": entry["period_start"], "period_end": entry["period_end"],
                 "room": entry["room"], "is_lab": bool(entry["is_lab"]), "units": entry["units"]}
                for entry in next_slots
            ],
        })
    return {
        "section": {"id": section["id"], "name": section["name"],
                "academic_year": section["academic_year"],
                "schedule_verified": bool(section["schedule_verified"])},
        "semester": {"start_date": section["start_date"], "end_date": section["end_date"]},
        "planning_date": planning_date.isoformat(),
        "calendar": {
            "today": forecast_start.isoformat(),
            "entries": entries,
            "exceptions": exceptions,
            "recorded": [list(key) for key in recorded_keys],
        },
        "subjects": results,
    }


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/service-worker.js")
def service_worker():
    return send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript")


@app.get("/api/sections")
def sections():
    with connect() as connection:
        rows = connection.execute(
            "SELECT id, name, academic_year FROM sections ORDER BY name"
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/sections")
def create_section():
    data = request.get_json(silent=True) or {}
    try:
        name = required_text(data, "name")
        academic_year = required_text(data, "academic_year")
        if academic_year != "2026-27":
            return error("Only academic year 2026-27 is supported.", 422)
        with connect() as connection:
            cursor = connection.execute(
                "INSERT INTO sections (name, academic_year) VALUES (?, ?)",
                (name, academic_year),
            )
            section_id = cursor.lastrowid
        return jsonify({"id": section_id, "name": name, "academic_year": academic_year}), 201
    except ValueError as exc:
        return error(str(exc))
    except Exception as exc:
        if "UNIQUE constraint failed" in str(exc):
            return error("That section already exists.", 409)
        raise


@app.post("/api/timetable/import")
def import_timetable():
    data = request.get_json(silent=True) or {}
    if data.get("academic_year") != "2026-27":
        return error("Only academic year 2026-27 is supported; timetable was not imported.", 422)
    if data.get("verified") is not True:
        return error("Set verified=true only after manually checking the timetable source.", 422)
    try:
        section_name = required_text(data, "section")
        subjects = data.get("subjects")
        entries = data.get("entries")
        if not isinstance(subjects, list) or not isinstance(entries, list):
            raise ValueError("subjects and entries must be arrays")
        if not entries:
            raise ValueError("at least one verified timetable entry is required")
        if any(not isinstance(item, dict) for item in subjects):
            raise ValueError("each subject must be an object")
        if any(not isinstance(item, dict) for item in entries):
            raise ValueError("each timetable entry must be an object")
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            section = connection.execute(
                "SELECT id FROM sections WHERE name = ? AND academic_year = '2026-27'",
                (section_name,),
            ).fetchone()
            if section is None:
                section_id = connection.execute(
                    "INSERT INTO sections (name, academic_year) VALUES (?, '2026-27')",
                    (section_name,),
                ).lastrowid
            else:
                section_id = section["id"]
            subject_ids = {}
            for subject in subjects:
                code = required_text(subject, "subject_code")
                name = required_text(subject, "name")
                connection.execute(
                    "INSERT INTO subjects (section_id, subject_code, name) VALUES (?, ?, ?) "
                    "ON CONFLICT(section_id, subject_code) DO UPDATE SET name = excluded.name",
                    (section_id, code, name),
                )
                subject_ids[code] = connection.execute(
                    "SELECT id FROM subjects WHERE section_id = ? AND subject_code = ?",
                    (section_id, code),
                ).fetchone()["id"]
            connection.execute("DELETE FROM timetable_entries WHERE section_id = ?", (section_id,))
            for entry in entries:
                if "is_break" in entry and not isinstance(entry["is_break"], bool):
                    raise ValueError("is_break must be true or false")
                if "is_lab" in entry and not isinstance(entry["is_lab"], bool):
                    raise ValueError("is_lab must be true or false")
                is_break = entry.get("is_break") is True
                subject_id = None
                if not is_break:
                    code = required_text(entry, "subject_code")
                    if code not in subject_ids:
                        raise ValueError(f"Unknown subject_code in timetable entry: {code}")
                    subject_id = subject_ids[code]
                weekday = entry.get("weekday")
                period_start = entry.get("period_start")
                period_end = entry.get("period_end")
                attendance_mode = entry.get("attendance_mode", "session")
                if attendance_mode not in ("session", "period"):
                    raise ValueError("attendance_mode must be session or period")
                for field, value, minimum, maximum in (
                    ("weekday", weekday, 0, 6), ("period_start", period_start, 1, 24),
                    ("period_end", period_end, 1, 24),
                ):
                    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                        raise ValueError(f"{field} must be an integer from {minimum} to {maximum}")
                if period_end < period_start:
                    raise ValueError("period_end must not be before period_start")
                units = entry.get("units", period_end - period_start + 1 if attendance_mode == "period" else 1)
                if isinstance(units, bool) or not isinstance(units, int) or not 1 <= units <= 100:
                    raise ValueError("units must be an integer from 1 to 100")
                connection.execute(
                    "INSERT INTO timetable_entries "
                    "(section_id, subject_id, label, weekday, slot, period_start, period_end, "
                    "is_lab, attendance_mode, units, room, is_break) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (section_id, subject_id, str(entry.get("label", "")), weekday,
                     required_text(entry, "slot"), period_start, period_end,
                     int(entry.get("is_lab") is True), attendance_mode, units,
                     str(entry.get("room", "")), int(is_break)),
                )
            connection.execute(
                "UPDATE sections SET schedule_verified = 1 WHERE id = ?", (section_id,)
            )
        return jsonify({"section_id": section_id, "subjects_imported": len(subjects),
                        "entries_imported": len(entries)}), 201
    except ValueError as exc:
        return error(str(exc))


@app.post("/api/attendance")
def record_attendance():
    data = request.get_json(silent=True) or {}
    try:
        subject_id = data.get("subject_id")
        units = data.get("units", 1)
        slot = required_text(data, "slot")
        class_date = as_date(data.get("date"), "date")
        attended = data.get("attended")
        if isinstance(subject_id, bool) or not isinstance(subject_id, int) or subject_id < 1:
            raise ValueError("subject_id must be a positive integer")
        if isinstance(units, bool) or not isinstance(units, int) or units < 1:
            raise ValueError("units must be a positive integer")
        if not isinstance(attended, bool):
            raise ValueError("attended must be true or false")
        with connect() as connection:
            config = connection.execute(
                "SELECT start_date, end_date FROM semester_config WHERE id = 1"
            ).fetchone()
            if not as_date(config["start_date"], "semester start") <= class_date <= as_date(config["end_date"], "semester end"):
                raise ValueError("date must be within the configured semester")
            subject = connection.execute("SELECT id FROM subjects WHERE id = ?", (subject_id,)).fetchone()
            if subject is None:
                return error("subject_id does not exist.", 404)
            previous = connection.execute(
                "SELECT attended, units FROM attendance "
                "WHERE subject_id = ? AND class_date = ? AND slot = ?",
                (subject_id, class_date.isoformat(), slot),
            ).fetchone()
            total = connection.execute(
                "SELECT attended, conducted FROM attendance_totals WHERE subject_id = ?",
                (subject_id,),
            ).fetchone()
            connection.execute(
                "INSERT INTO attendance (subject_id, class_date, slot, attended, units) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(subject_id, class_date, slot) "
                "DO UPDATE SET attended = excluded.attended, units = excluded.units",
                (subject_id, class_date.isoformat(), slot, int(attended), units),
            )
            if total:
                old_units = previous["units"] if previous else 0
                old_attended = old_units if previous and previous["attended"] else 0
                new_conducted = total["conducted"] + units - old_units
                new_attended = total["attended"] + (units if attended else 0) - old_attended
                if new_conducted < 0 or new_attended < 0 or new_attended > new_conducted:
                    raise ValueError("attendance correction conflicts with saved subject totals")
                connection.execute(
                    "UPDATE attendance_totals SET attended = ?, conducted = ?, "
                    "updated_at = CURRENT_TIMESTAMP WHERE subject_id = ?",
                    (new_attended, new_conducted, subject_id),
                )
        return jsonify({"subject_id": subject_id, "date": class_date.isoformat(),
                        "slot": slot, "attended": attended, "units": units})
    except (ValueError, AttendanceInputError) as exc:
        return error(str(exc))


@app.post("/api/attendance/summary")
def save_attendance_summary():
    data = request.get_json(silent=True) or {}
    subject_id = data.get("subject_id")
    attended = data.get("attended")
    conducted = data.get("conducted")
    if isinstance(subject_id, bool) or not isinstance(subject_id, int) or subject_id < 1:
        return error("subject_id must be a positive integer")
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 0
           for value in (attended, conducted)):
        return error("attended and conducted must be non-negative integers")
    if attended > conducted:
        return error("attended cannot exceed conducted")
    with connect() as connection:
        if connection.execute("SELECT 1 FROM subjects WHERE id = ?", (subject_id,)).fetchone() is None:
            return error("subject_id does not exist.", 404)
        connection.execute(
            "INSERT INTO attendance_totals (subject_id, attended, conducted) VALUES (?, ?, ?) "
            "ON CONFLICT(subject_id) DO UPDATE SET attended = excluded.attended, "
            "conducted = excluded.conducted, updated_at = CURRENT_TIMESTAMP",
            (subject_id, attended, conducted),
        )
    return jsonify({"subject_id": subject_id, "attended": attended, "conducted": conducted})


@app.post("/api/calendar-exceptions")
def create_calendar_exception():
    data = request.get_json(silent=True) or {}
    try:
        section_id = data.get("section_id")
        if isinstance(section_id, bool) or not isinstance(section_id, int) or section_id < 1:
            raise ValueError("section_id must be a positive integer")
        exception_date = as_date(data.get("date"), "date")
        kind = data.get("kind")
        if kind not in ("holiday", "cancelled", "makeup"):
            raise ValueError("kind must be holiday, cancelled, or makeup")
        subject_id = data.get("subject_id")
        if subject_id is not None and (
            isinstance(subject_id, bool) or not isinstance(subject_id, int) or subject_id < 1
        ):
            raise ValueError("subject_id must be a positive integer")
        units = data.get("units", 1)
        if isinstance(units, bool) or not isinstance(units, int) or units < 1:
            raise ValueError("units must be a positive integer")
        slot = data.get("slot", "")
        if not isinstance(slot, str):
            raise ValueError("slot must be text")
        with connect() as connection:
            config = connection.execute(
                "SELECT start_date, end_date FROM semester_config WHERE id = 1"
            ).fetchone()
            if not as_date(config["start_date"], "semester start") <= exception_date <= as_date(config["end_date"], "semester end"):
                raise ValueError("date must be within the configured semester")
            if connection.execute("SELECT 1 FROM sections WHERE id = ?", (section_id,)).fetchone() is None:
                return error("section_id does not exist.", 404)
            if subject_id is not None and connection.execute(
                "SELECT 1 FROM subjects WHERE id = ? AND section_id = ?", (subject_id, section_id)
            ).fetchone() is None:
                return error("subject_id does not belong to this section.", 404)
            if kind == "makeup" and subject_id is None:
                raise ValueError("makeup exceptions require a subject_id")
            cursor = connection.execute(
                "INSERT INTO calendar_exceptions "
                "(exception_date, subject_id, kind, slot, units, room, note) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (exception_date.isoformat(), subject_id, kind, slot, units,
                 str(data.get("room", "")), str(data.get("note", ""))),
            )
        return jsonify({"id": cursor.lastrowid, "date": exception_date.isoformat(),
                        "kind": kind, "subject_id": subject_id}), 201
    except ValueError as exc:
        return error(str(exc))


@app.get("/api/forecast")
def forecast():
    section_id = request.args.get("section_id", type=int)
    if not section_id:
        return error("section_id is required")
    raw_date = request.args.get("planning_date")
    try:
        planning_date = as_date(raw_date, "planning_date") if raw_date else None
        if planning_date and planning_date < date.today():
            return error("planning_date must be today or later.")
    except ValueError as exc:
        return error(str(exc))
    try:
        with connect() as connection:
            snapshot = get_snapshot(connection, section_id, planning_date)
    except ValueError as exc:
        return error(str(exc))
    if snapshot is None:
        return error("Section not found.", 404)
    return jsonify(snapshot)


@app.post("/api/simulate")
def simulate():
    data = request.get_json(silent=True) or {}
    section_id = data.get("section_id")
    subject_id = data.get("subject_id")
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 1
           for value in (section_id, subject_id)):
        return error("section_id and subject_id must be positive integers")
    raw_date = data.get("planning_date")
    try:
        planning_date = as_date(raw_date, "planning_date") if raw_date else None
        if planning_date and planning_date < date.today():
            return error("planning_date must be today or later.")
        with connect() as connection:
            snapshot = get_snapshot(connection, section_id, planning_date)
    except ValueError as exc:
        return error(str(exc))
    if snapshot is None:
        return error("Section not found.", 404)
    subject = next((item for item in snapshot["subjects"] if item["id"] == subject_id), None)
    if subject is None:
        return error("Subject does not belong to this section.", 404)
    try:
        attended = data.get("future_attended", 0)
        missed = data.get("future_missed", 0)
        projected = projected_percentage(
            subject["attended"], subject["conducted"], attended, missed,
            subject["classes_by_planning_date"],
        )
        return jsonify({"subject_id": subject_id, "future_attended": attended,
                        "future_missed": missed, "remaining": subject["classes_by_planning_date"],
                        "projected_percentage": projected})
    except AttendanceInputError as exc:
        return error(str(exc))


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "academic_year": "2026-27"})


initialize()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)
