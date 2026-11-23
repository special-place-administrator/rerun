WHY = "stopped by the owner"
CANCELLED = "cancelled"


def cancel(account, store, agent, run, log):
    try:
        account("cancel_run", {"agentId": agent, "runId": run})
    except Exception as e:
        log(run, "stop: run %s not cancelled yet, tried again next beat: %s" % (run, str(e)[:200]))
        return False
    store.close_run(run, "cancelled", error=WHY)
    return True
