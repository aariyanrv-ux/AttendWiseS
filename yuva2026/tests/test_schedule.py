import unittest
from datetime import date

from services.schedule import count_remaining


class ScheduleTests(unittest.TestCase):
    def test_holidays_cancellations_makeups_and_recorded_slots(self):
        entries = [
            {"subject_id": 1, "weekday": 0, "slot": "LAB", "units": 3, "is_break": 0},
            {"subject_id": 1, "weekday": 4, "slot": "P1", "units": 1, "is_break": 0},
            {"subject_id": None, "weekday": 0, "slot": "BREAK", "units": 1, "is_break": 1},
        ]
        exceptions = [
            {"exception_date": "2026-10-02", "subject_id": None, "kind": "holiday", "slot": "", "units": 1},
            {"exception_date": "2026-10-05", "subject_id": 1, "kind": "cancelled", "slot": "LAB", "units": 1},
            {"exception_date": "2026-10-03", "subject_id": 1, "kind": "makeup", "slot": "MAKEUP", "units": 2},
        ]
        remaining = count_remaining(
            entries,
            exceptions,
            date(2026, 9, 28),
            date(2026, 10, 5),
            today=date(2026, 9, 28),
            recorded={(1, "2026-09-28", "LAB")},
        )
        self.assertEqual(remaining, {1: 2})

    def test_period_based_lab_units_are_counted_without_expanding_slots(self):
        entry = {"subject_id": 7, "weekday": 0, "slot": "LAB", "units": 4, "is_break": 0, "is_lab": 1}
        remaining = count_remaining(
            [entry], [], date(2026, 9, 28), date(2026, 9, 28), today=date(2026, 9, 28)
        )
        self.assertEqual(remaining[7], 4)

    def test_no_future_dates_returns_empty_counts(self):
        entry = {"subject_id": 3, "weekday": 0, "slot": "A", "units": 1, "is_break": 0}
        self.assertEqual(
            count_remaining([entry], [], date(2026, 9, 1), date(2026, 9, 20), today=date(2026, 9, 28)),
            {},
        )


if __name__ == "__main__":
    unittest.main()
