import datetime
import math
import re
import zoneinfo
import limits
import snapshot


WEEK_S = 7 * 86400


def pace(used, mark, resets_at, now):
    if used is None or not mark or resets_at is None or resets_at <= now:
        return 1.0
    budget = max(0.0, mark - used) / mark
    time = min(1.0, (resets_at - now) / WEEK_S)
    return min(1.0, budget / time)


def watched(answer, used=(), with_default=True):
    connections = answer.get("connections") if isinstance(answer, dict) else None
    if not isinstance(connections, list):
        return []
    ids = set(used or ())
    return [c for c in connections if isinstance(c, dict) and ((with_default and c.get("isDefault") is True) or c.get("id") in ids)]


def _minutes(c):
    sign_in = c.get("signIn")
    m = sign_in.get("minutesLeft") if isinstance(sign_in, dict) else None
    return m if isinstance(m, (int, float)) and not isinstance(m, bool) else None


def left(answer, used=()):
    found = [m for m in map(_minutes, watched(answer, used)) if m is not None]
    return min(found) if found else None


def due(answer, limit, used=()):
    m = left(answer, used)
    return m is not None and m <= limit


def _windows(c):
    limits_of = c.get("planLimits")
    windows = limits_of.get("windows") if isinstance(limits_of, dict) else None
    return [w for w in windows if isinstance(w, dict)] if isinstance(windows, list) else []


def _percent(w):
    p = w.get("usedPercent")
    return min(100, max(0, p)) if isinstance(p, (int, float)) and not isinstance(p, bool) and math.isfinite(p) else None


def _week(c, now):
    week = next((w for w in _windows(c) if w.get("kind") == "weekly"), None)
    used = _percent(week) if week else None
    if used is None:
        return None, None
    try:
        at = limits.ts(week["resetsAt"])
    except (AttributeError, KeyError, TypeError, ValueError):
        return used, None
    return (0, None) if at <= now else (used, snapshot.iso(at))


def limited_until(answer, now, used=(), with_default=True):
    ends = []
    for c in watched(answer, used, with_default):
        for w in _windows(c):
            p = _percent(w)
            if p is None or p < 100:
                continue
            try:
                at = limits.ts(w["resetsAt"])
            except (AttributeError, KeyError, TypeError, ValueError):
                continue
            if at > now:
                ends.append(at)
    return max(ends) if ends else None


_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
_RESETS = re.compile(r"resets\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z_]+(?:/[A-Za-z_]+)*)\)", re.I)


def resets_in_text(text, now):
    m = _RESETS.search(text or "")
    if not m:
        return None
    month, day, hour, minute, half, zone = m.groups()
    try:
        tz = zoneinfo.ZoneInfo(zone)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        return None
    hour = int(hour) % 12 + (12 if half.lower() == "pm" else 0)
    local = datetime.datetime.fromtimestamp(now, tz)
    try:
        if month:
            at = local.replace(month=_MONTHS.index(month.lower()) + 1, day=int(day), hour=hour, minute=int(minute or 0), second=0, microsecond=0)
            if at.timestamp() <= now:
                at = at.replace(year=at.year + 1)
        else:
            at = local.replace(hour=hour, minute=int(minute or 0), second=0, microsecond=0)
            if at.timestamp() <= now:
                at += datetime.timedelta(days=1)
    except ValueError:
        return None
    return at.timestamp()


def plan(answer, now, used=()):
    connections = watched(answer, used)
    if not connections:
        return None
    weeks = [w for w in (_week(c, now) for c in connections) if w[0] is not None]
    week_used, resets = max(weeks, key=lambda w: w[0]) if weeks else (None, None)
    m = left(answer, used)
    m = m if m is not None and math.isfinite(m) else None
    if week_used is None and m is None:
        return None
    return {"weekUsedPercent": week_used, "weekResetsAt": resets, "signInMinutes": None if m is None else max(0, int(m))}
