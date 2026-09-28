from fractions import Fraction
from math import ceil


class AttendanceInputError(ValueError):
    pass


def _count(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AttendanceInputError(f"{name} must be a non-negative integer")
    return value


def _target(value):
    if isinstance(value, bool):
        raise AttendanceInputError("target must be between 0 and 1")
    try:
        result = Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        raise AttendanceInputError("target must be between 0 and 1") from None
    if result <= 0 or result >= 1:
        raise AttendanceInputError("target must be between 0 and 1")
    return result


def projected_percentage(attended, conducted, future_attended, future_missed, remaining):
    attended = _count(attended, "attended")
    conducted = _count(conducted, "conducted")
    future_attended = _count(future_attended, "future_attended")
    future_missed = _count(future_missed, "future_missed")
    remaining = _count(remaining, "remaining")
    if attended > conducted:
        raise AttendanceInputError("attended cannot exceed conducted")
    if future_attended + future_missed > remaining:
        raise AttendanceInputError("future attendance cannot exceed remaining classes")
    total = conducted + future_attended + future_missed
    return None if total == 0 else float(Fraction(attended + future_attended, total) * 100)


def calculate_attendance(attended, conducted, remaining=0, targets=(0.90, 0.75)):
    attended = _count(attended, "attended")
    conducted = _count(conducted, "conducted")
    remaining = _count(remaining, "remaining")
    if attended > conducted:
        raise AttendanceInputError("attended cannot exceed conducted")

    current = Fraction(attended, conducted) if conducted else None
    status = (
        "UNSTARTED" if current is None else
        "SAFE" if current >= Fraction(9, 10) else
        "WARNING" if current >= Fraction(3, 4) else
        "CRITICAL"
    )
    recovery = {}
    skips = {}
    for raw_target in targets:
        target = _target(raw_target)
        label = f"{float(target) * 100:g}"
        required = max(0, ceil((target * conducted - attended) / (1 - target)))
        recovery[label] = {
            "required": required,
            "feasible": required <= remaining,
            "projected_if_all_attended": projected_percentage(
                attended, conducted, remaining, 0, remaining
            ),
        }
        skips[label] = (
            max(0, (attended * target.denominator) // target.numerator - conducted)
            if current is not None and current >= target else 0
        )

    return {
        "attended": attended,
        "conducted": conducted,
        "remaining": remaining,
        "current_percentage": float(current * 100) if current is not None else None,
        "status": status,
        "recovery": recovery,
        "safe_skips": skips,
        "end_percentage_if_all_attended": projected_percentage(
            attended, conducted, remaining, 0, remaining
        ),
    }
