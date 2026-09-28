import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY,
    academic_year TEXT NOT NULL CHECK (academic_year = '2026-27'),
    name TEXT NOT NULL,
    schedule_verified INTEGER NOT NULL DEFAULT 0 CHECK (schedule_verified IN (0, 1)),
    UNIQUE (academic_year, name)
);
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    subject_code TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (section_id, subject_code)
);
CREATE TABLE IF NOT EXISTS timetable_entries (
    id INTEGER PRIMARY KEY,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    slot TEXT NOT NULL,
    period_start INTEGER NOT NULL CHECK (period_start > 0),
    period_end INTEGER NOT NULL CHECK (period_end >= period_start),
    is_lab INTEGER NOT NULL DEFAULT 0 CHECK (is_lab IN (0, 1)),
    attendance_mode TEXT NOT NULL DEFAULT 'session'
        CHECK (attendance_mode IN ('session', 'period')),
    units INTEGER NOT NULL DEFAULT 1 CHECK (units > 0),
    room TEXT NOT NULL DEFAULT '',
    is_break INTEGER NOT NULL DEFAULT 0 CHECK (is_break IN (0, 1))
);
CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    class_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    attended INTEGER NOT NULL CHECK (attended IN (0, 1)),
    units INTEGER NOT NULL CHECK (units > 0),
    note TEXT NOT NULL DEFAULT '',
    UNIQUE (subject_id, class_date, slot)
);
CREATE TABLE IF NOT EXISTS attendance_totals (
    subject_id INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
    attended INTEGER NOT NULL CHECK (attended >= 0),
    conducted INTEGER NOT NULL CHECK (conducted >= attended),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS semester_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    academic_year TEXT NOT NULL CHECK (academic_year = '2026-27')
);
CREATE TABLE IF NOT EXISTS calendar_exceptions (
    id INTEGER PRIMARY KEY,
    exception_date TEXT NOT NULL,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('holiday', 'cancelled', 'makeup')),
    slot TEXT NOT NULL DEFAULT '',
    units INTEGER NOT NULL DEFAULT 1 CHECK (units > 0),
    room TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_timetable_weekday ON timetable_entries(weekday);
CREATE INDEX IF NOT EXISTS idx_attendance_subject_date ON attendance(subject_id, class_date);
CREATE INDEX IF NOT EXISTS idx_exceptions_date ON calendar_exceptions(exception_date);
"""


def database_path():
    configured = os.environ.get("ATTENDWISE_DATABASE")
    if configured:
        return configured
    instance = Path(__file__).resolve().parent.parent / "instance"
    instance.mkdir(parents=True, exist_ok=True)
    return str(instance / "attendwise.sqlite3")


@contextmanager
def connect(path=None):
    connection = sqlite3.connect(path or database_path())
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize(path=None):
    with connect(path) as connection:
        connection.executescript(SCHEMA)
        connection.execute(
            "INSERT OR IGNORE INTO semester_config "
            "(id, start_date, end_date, academic_year) VALUES (1, ?, ?, ?)",
            ("2026-08-29", "2026-11-29", "2026-27"),
        )
