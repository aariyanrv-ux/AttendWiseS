import unittest

from services.attendance import (
    AttendanceInputError,
    calculate_attendance,
    projected_percentage,
)


class AttendanceTests(unittest.TestCase):
    def test_nine_of_ten_meets_ninety_percent_exactly(self):
        result = calculate_attendance(9, 10, remaining=12)
        self.assertEqual(result["status"], "SAFE")
        self.assertEqual(result["recovery"]["90"]["required"], 0)
        self.assertEqual(result["safe_skips"]["90"], 0)
        self.assertEqual(result["safe_skips"]["75"], 2)

    def test_eight_of_ten_requires_ten_attended_classes_for_ninety(self):
        result = calculate_attendance(8, 10, remaining=9)
        self.assertEqual(result["status"], "WARNING")
        self.assertEqual(result["recovery"]["90"]["required"], 10)
        self.assertFalse(result["recovery"]["90"]["feasible"])
        self.assertEqual(result["recovery"]["75"]["required"], 0)

    def test_critical_boundary_and_exact_safe_skip_floor(self):
        self.assertEqual(calculate_attendance(7, 10)["status"], "CRITICAL")
        result = calculate_attendance(15, 20)
        self.assertEqual(result["status"], "WARNING")
        self.assertEqual(result["safe_skips"]["75"], 0)

    def test_zero_conducted_has_no_percentage(self):
        result = calculate_attendance(0, 0, remaining=4)
        self.assertIsNone(result["current_percentage"])
        self.assertEqual(result["status"], "UNSTARTED")
        self.assertEqual(result["recovery"]["90"]["required"], 0)

    def test_projection_and_remaining_limit(self):
        result = projected_percentage(7, 10, 2, 1, 3)
        self.assertAlmostEqual(result, 900 / 13)
        with self.assertRaises(AttendanceInputError):
            projected_percentage(7, 10, 2, 2, 3)

    def test_invalid_counts_are_rejected(self):
        for values in ((-1, 2), (3, 2), (1.5, 2), (True, 2)):
            with self.subTest(values=values):
                with self.assertRaises(AttendanceInputError):
                    calculate_attendance(*values)


if __name__ == "__main__":
    unittest.main()
