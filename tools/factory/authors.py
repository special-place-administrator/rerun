FACTORY_LOGINS = frozenset(("moldwright-factory[bot]", "app/moldwright-factory"))
ROB = "special-place-administrator"
TRUSTED_LOGINS = FACTORY_LOGINS | {ROB}


def trusted_author(item):
    if not isinstance(item, dict):
        return False
    login = ((item.get("author") or item.get("user")) or {}).get("login") or ""
    return login in TRUSTED_LOGINS


def is_rob(item):
    if not isinstance(item, dict):
        return False
    login = ((item.get("author") or item.get("user")) or {}).get("login") or ""
    return login == ROB


def is_factory(item):
    if not isinstance(item, dict):
        return False
    return (((item.get("author") or item.get("user")) or {}).get("login") or "") in FACTORY_LOGINS
