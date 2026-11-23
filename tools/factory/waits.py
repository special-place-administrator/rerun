import states

REASONS = ("dependency", "fact recheck", "no free worker of its type", "back-off", "hold", "plan limit", "sign-in renewal")

_QUEUE_STATES = states.QUEUE


def reason(job, now, hold=None, held=(), no_provider=False):
    state = job.get("state")
    if state == "waiting":
        return "fact recheck" if job.get("recheck") else "dependency"
    if state == "checks":
        return job.get("checks_why")
    if state not in _QUEUE_STATES:
        return None
    not_before = job.get("not_before")
    if not_before is not None and not_before > now:
        return "back-off"
    if hold:
        kind = hold.get("kind")
        return kind if kind in ("plan limit", "sign-in renewal", "paused", "stopped") else "hold"
    if no_provider:
        return "no enabled provider"
    if held:
        return "coworker held: " + ", ".join(held)
    return "no free worker of its type"
