from datetime import date, timedelta


def count_remaining(entries, exceptions, start_date, end_date, today=None, recorded=()):
    """Count future units; recorded attendance dates are excluded from future work."""
    today = today or date.today()
    start_date = max(start_date, today)
    if start_date > end_date:
        return {}

    holidays = [
        item
        for item in exceptions
        if item["kind"] == "holiday"
    ]
    cancellations = [item for item in exceptions if item["kind"] == "cancelled"]
    makeups = [item for item in exceptions if item["kind"] == "makeup"]
    recorded = set(recorded)
    remaining = {}
    cursor = start_date
    while cursor <= end_date:
        for entry in entries:
            if entry["is_break"] or entry["weekday"] != cursor.weekday():
                continue
            key = entry["subject_id"]
            date_key = cursor.isoformat()
            cancelled = any(
                item["exception_date"] == date_key
                and item["subject_id"] in (None, key)
                and item["slot"] in ("", entry["slot"])
                for item in cancellations
            )
            holiday = any(
                item["exception_date"] == date_key
                and item["subject_id"] in (None, key)
                for item in holidays
            )
            if not cancelled and not holiday and (key, date_key, entry["slot"]) not in recorded:
                remaining[key] = remaining.get(key, 0) + entry["units"]
        cursor += timedelta(days=1)

    for item in makeups:
        makeup_date = date.fromisoformat(item["exception_date"])
        if start_date <= makeup_date <= end_date:
            key = item["subject_id"]
            date_key = makeup_date.isoformat()
            if (key, date_key, item["slot"]) not in recorded:
                remaining[key] = remaining.get(key, 0) + item["units"]
    return remaining
