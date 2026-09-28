import os
import tempfile
import unittest


_TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["ATTENDWISE_DATABASE"] = os.path.join(_TEMP_DIR.name, "attendwise-test.sqlite3")

from app import app, initialize


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize()
        app.config.update(TESTING=True)
        cls.client = app.test_client()

    def test_rejects_incompatible_academic_year(self):
        response = self.client.post(
            "/api/sections", json={"name": "Wrong year", "academic_year": "2025-26"}
        )
        self.assertEqual(response.status_code, 422)

    def test_summary_and_date_forecast_use_exact_recovery(self):
        section_response = self.client.post(
            "/api/sections", json={"name": "Calculator test", "academic_year": "2026-27"}
        )
        section_id = section_response.get_json()["id"]
        imported = self.client.post(
            "/api/timetable/import",
            json={
                "academic_year": "2026-27",
                "verified": True,
                "section": "Calculator test",
                "subjects": [{"subject_code": "TST101", "name": "Test Subject"}],
                "entries": [{
                    "subject_code": "TST101", "weekday": 0, "slot": "P1",
                    "period_start": 1, "period_end": 1,
                }],
            },
        )
        self.assertEqual(imported.status_code, 201)
        subject_id = self.client.get(
            f"/api/forecast?section_id={section_id}"
        ).get_json()["subjects"][0]["id"]
        saved = self.client.post(
            "/api/attendance/summary",
            json={"subject_id": subject_id, "attended": 8, "conducted": 10},
        )
        self.assertEqual(saved.status_code, 200)
        forecast = self.client.get(
            f"/api/forecast?section_id={section_id}&planning_date=2026-10-05"
        )
        subject = forecast.get_json()["subjects"][0]
        self.assertEqual(subject["metrics"]["current_percentage"], 80.0)
        self.assertEqual(subject["metrics"]["recovery"]["90"]["required"], 10)
        self.assertEqual(subject["planning_targets"]["90"]["required"], 10)
        self.assertEqual(subject["classes_by_planning_date"], 1)
        self.assertFalse(subject["metrics"]["recovery"]["90"]["feasible"])

    def test_rejects_planning_date_after_semester(self):
        response = self.client.get("/api/forecast?section_id=999&planning_date=2026-12-01")
        self.assertIn(response.status_code, (400, 404))


if __name__ == "__main__":
    unittest.main()
