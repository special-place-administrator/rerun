import json
import os
import re
import time

import factory
import limits
import projects
import states

END = states.END
REPO = projects.REPO
UNPUSHED = ("building", "fixing")
NOT_STARTED = ("waiting", "queued")
CHECK_AGAIN_S = 10 * 60
RECHECK_FLOOR_S = 60
READINESS_PER_HOUR = 20
REPOS_AGAIN_S = 5 * 60
PROBES_KEPT = 10
CONTROL_STATES = ("RUNNING", "PAUSED", "DRAINING", "STOPPED")
CONTROL_DEFAULT = "PAUSED"
CONNECTION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
CONNECTIONS_OFF_MAX = 50
ORDER_KINDS = ("feature", "bug", "issue", "all_issues")
ORDER_ISSUES_MAX = 200
ORDER_TEXT_MAX = 4000
ORDER_ACTIONS = ("retry", "skip")
FAILED = ("blocked", "failed")


def ledger_path(cfg, repo):
    if repo == cfg["repo"]:
        return cfg["ledger_file"]
    return os.path.join(os.path.dirname(cfg["ledger_file"]), "ledger-%s.db" % repo.replace("/", "--"))


def line_cfg(cfg, repo):
    if repo == cfg["repo"]:
        return cfg
    path = ledger_path(cfg, repo)
    return dict(cfg, repo=repo, home=cfg["repo"], ledger_file=path, json_state_file=path + ".json")


def live(d):
    return [j for j in d.jobs() if j["state"] not in NOT_STARTED and (j["state"] not in END or not j.get("relabelled"))]


def printable(text):
    return "".join(c if c.isprintable() else " " for c in str(text or ""))[:100]


def unpushed(d):
    return [j for j in d.jobs() if j["state"] in UNPUSHED]


class Lines:
    def __init__(self, cfg, account, gh, now=time.time, make=None, mod=None):
        self.cfg, self.now, self.home = cfg, now, cfg["repo"]
        self.mod = mod or __import__("dispatch")
        self.make = make or (lambda c: self.mod.Dispatcher(c, account, gh, now))
        self.lines, self.said, self.last = {}, set(), None
        self.gh, self.repos, self.repos_at, self.probes, self.draining = gh, [], None, {}, []
        self.checks_run, self.future_asks = [], {}
        self.kv = self.open(self.home).store
        self.active = self.home
        saved = self.read("project", {})
        for repo in [saved.get("repo")] + list(self.read("finishing", [])):
            if isinstance(repo, str) and REPO.match(repo) and repo not in self.lines:
                try:
                    self.open(repo)
                except Exception as e:
                    self.problem("project %s not opened: %s" % (repo, e if isinstance(e, RuntimeError) else type(e).__name__))
        if saved.get("repo") in self.lines:
            self.active, self.last = saved["repo"], saved
            self.mend()
        self.roles()

    def read(self, key, default):
        try:
            got = json.loads(self.kv.get_all("-").get(key) or "null")
        except ValueError:
            return default
        return got if isinstance(got, type(default)) else default

    def mend(self):
        raw = self.kv.get_all("-").get("project")
        if not any(e["key"] == "project" and e["to"] == raw for e in self.kv.events()):
            self.kv.add_event("project", self.last.get("from"), raw)
            self.problem("project: the switch to %s had no events row; it is written now" % self.active)

    def open(self, repo):
        self.lines[repo] = self.make(line_cfg(self.cfg, repo))
        return self.lines[repo]

    def roles(self):
        for repo, d in self.lines.items():
            d.taking = d.reporting = repo == self.active
            d.others = (lambda me: lambda: [p for r, x in self.lines.items() if r != me for p in x.own()])(repo)
            d.extra = self.extra if repo == self.active else dict

    def finishing(self):
        return [(r, len(live(d))) for r, d in self.lines.items() if r != self.active and live(d)]

    def control(self):
        saved = self.read("control", {})
        return saved.get("state") if saved.get("state") in CONTROL_STATES else CONTROL_DEFAULT

    def off(self):
        saved = self.read("providers", {}).get("off")
        return sorted(c for c in saved if isinstance(c, str) and CONNECTION_ID.match(c)) if isinstance(saved, list) else []

    def apply_controls(self):
        state, off = self.control(), frozenset(self.off())
        for d in self.lines.values():
            d.run_state, d.off_connections, d.work = state, off, None
        self.lines[self.active].work = self.work()

    def chosen(self):
        return bool(self.last) and self.last.get("repo") == self.active

    def order(self):
        saved = self.read("work_order", {})
        return saved if saved.get("kind") in ORDER_KINDS else None

    def work(self):
        order = self.order()
        if not self.chosen():
            return {"wait": "no project chosen", "issues": [], "order": []}
        if order is None or order.get("repo") != self.active:
            return {"wait": "no work order", "issues": [], "order": []}
        issues = order.get("issues") or []
        if order["kind"] in ("feature", "bug"):
            return {"wait": "the %s work order has no issue to run yet" % order["kind"], "issues": [], "order": issues}
        store, skipped, retried, done = self.lines[self.active].store, order.get("skipped", []), order.get("retried", {}), []
        for n in issues:
            j, kv = store.get_job(str(n)) or {}, store.get_all(str(n))
            if n in skipped or (not j and kv.get("closed_unstarted")) or (order["kind"] == "all_issues" and kv.get("order_paused")):
                done.append(n)
                continue
            if j.get("state") in FAILED and retried.get(str(n)) != j.get("take", 1):
                return {"wait": "job #%d failed: retry or skip" % n, "issues": [], "order": issues, "done": done, "halted": n}
            if j.get("state") in states.END and j.get("state") not in FAILED:
                done.append(n)
                continue
            wait = None
            if not j and kv.get("order_paused"):
                wait = "issue #%d is labelled factory-paused" % n
            elif not j and kv.get("cutshape"):
                wait = "issue #%d body is not cut-shaped" % n
            return {"wait": wait, "issues": [n], "order": issues, "done": done}
        return {"wait": "the work order is done", "issues": [], "order": issues, "done": done}

    def learn_action(self, ask):
        if ask is None:
            return
        fingerprint = json.dumps(ask, sort_keys=True, default=str)[:2000]
        if self.read("work_order_action_asked", {}).get("raw") == fingerprint:
            return
        self.kv.set("-", "work_order_action_asked", json.dumps({"raw": fingerprint}))
        order, ask = self.order(), ask if isinstance(ask, dict) else {}
        action, n = ask.get("action"), ask.get("issue")
        if action not in ORDER_ACTIONS or order is None or ask.get("order_id") != order.get("id") or not isinstance(n, int) or isinstance(n, bool):
            return self.problem("work order action not understood: nothing changes")
        if self.work().get("halted") != n:
            return self.problem("work order action %s on #%d not taken: that job is not halted" % (action, n))
        if action == "retry":
            take = (self.lines[self.active].store.get_job(str(n)) or {}).get("take", 1)
            order = dict(order, retried=dict(order.get("retried", {}), **{str(n): take}))
        else:
            order = dict(order, skipped=order.get("skipped", []) + [n])
        self.change("work_order", dict(order, by=printable(ask.get("by")), at=self.mod.iso(self.now())), "work order %s: %s #%d" % (order["id"], action, n))

    def learn_order(self, ask):
        if ask is None:
            return
        fingerprint = json.dumps(ask, sort_keys=True, default=str)[:20000]
        if self.read("work_order_asked", {}).get("raw") == fingerprint:
            return
        kind = ask.get("kind") if isinstance(ask, dict) else None
        if kind == "none":
            self.kv.set("-", "work_order_asked", json.dumps({"raw": fingerprint}))
            if self.order() is not None:
                old = self.order()
                self.change("work_order", {"kind": "none", "by": printable(ask.get("by")), "at": self.mod.iso(self.now())},
                            "work order %s cancelled" % old.get("id"))
            return
        order = self.valid_order(ask)
        if order is None:
            return self.problem("work order answer not understood: the work order stays %s" % ((self.order() or {}).get("id") or "none"))
        self.kv.set("-", "work_order_asked", json.dumps({"raw": fingerprint}))
        self.change("work_order", dict(order, by=printable(ask.get("by")), at=self.mod.iso(self.now())),
                    "work order %s: %s %s in %s" % (order["id"], order["kind"], ", ".join("#%d" % n for n in order["issues"]) or "-", order["repo"]))

    def valid_order(self, ask):
        kind, issues, text = ask.get("kind"), ask.get("issues", []), ask.get("text", "")
        if kind not in ORDER_KINDS or not isinstance(ask.get("id"), str) or not CONNECTION_ID.match(ask["id"]):
            return None
        if not isinstance(ask.get("repo"), str) or not REPO.match(ask["repo"]) or not isinstance(text, str) or len(text) > ORDER_TEXT_MAX:
            return None
        if not isinstance(issues, list) or len(issues) > ORDER_ISSUES_MAX or len(set(issues)) != len(issues):
            return None
        if not all(isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in issues):
            return None
        if (kind == "issue" and len(issues) != 1) or (kind == "all_issues" and not issues) or (kind in ("feature", "bug") and not text.strip()):
            return None
        return {"id": ask["id"], "repo": ask["repo"], "kind": kind, "issues": issues, "text": text}

    def change(self, key, value, said):
        old = self.kv.get_all("-").get(key)
        new = json.dumps(value)
        self.kv.set("-", key, new)
        self.kv.add_event(key, old, new)
        self.mod.log(key, "%s by %s at %s" % (said, value["by"] or "?", value["at"]))

    def learn_control(self, ask):
        if ask is None:
            return
        state = ask.get("state") if isinstance(ask, dict) else None
        if state not in CONTROL_STATES:
            return self.problem("control answer not understood: the factory stays %s" % self.control())
        asked = {"state": state, "by": printable(ask.get("by")), "at": str(ask.get("at"))[:64]}
        if self.read("control_asked", {}) == asked:
            return
        self.kv.set("-", "control_asked", json.dumps(asked))
        if state in ("DRAINING", "STOPPED") and self.order() is not None:
            self.change("work_order", {"kind": "none", "by": printable(ask.get("by")), "at": self.mod.iso(self.now())},
                        "work order %s cancelled by the stop" % self.order().get("id"))
        old = self.control()
        if state == old and "control" in self.kv.get_all("-"):
            return
        self.change("control", {"state": state, "by": printable(ask.get("by")), "at": self.mod.iso(self.now())}, "%s -> %s" % (old, state))

    def drained(self):
        if self.control() != "DRAINING" or any(d.store.running() or d.store.pending() for d in self.lines.values()):
            return
        self.change("control", {"state": "STOPPED", "by": "factory", "at": self.mod.iso(self.now())}, "DRAINING -> STOPPED")

    def learn_providers(self, ask):
        if ask is None:
            return
        off = ask.get("off") if isinstance(ask, dict) else None
        if not isinstance(off, list) or len(off) > CONNECTIONS_OFF_MAX or not all(isinstance(c, str) and CONNECTION_ID.match(c) for c in off):
            return self.problem("providers answer not understood: the connections stay as they are")
        off = sorted(set(off))
        if off == self.off() and "providers" in self.kv.get_all("-"):
            return
        self.change("providers", {"off": off, "by": printable(ask.get("by")), "at": self.mod.iso(self.now())},
                    "connections off: %s (were %s)" % (", ".join(off) or "none", ", ".join(self.off()) or "none"))

    def extra(self):
        out = {"home": self.home, "finishing": [{"repo": r, "jobs": n} for r, n in self.finishing()][:10]}
        saved = self.read("control", {})
        out["control"] = {"state": self.control(), "by": saved.get("by"), "at": saved.get("at")}
        listed = (self.lines[self.active].connections or {}).get("connections") if isinstance(self.lines[self.active].connections, dict) else None
        ids = sorted(c["id"] for c in listed or [] if isinstance(c, dict) and isinstance(c.get("id"), str))
        out["providers"] = {"off": self.off(), "enabled": [c for c in ids if c not in self.off()]}
        order, work = self.order() or {}, self.work()
        out["work_order"] = {"id": order.get("id"), "repo": order.get("repo"), "kind": order.get("kind"), "issues": order.get("issues", []),
                             "text": order.get("text"), "by": order.get("by"), "at": order.get("at"), "current": (work["issues"] or [None])[0],
                             "done": work.get("done", []), "skipped": order.get("skipped", []), "halted": work.get("halted"), "wait": work["wait"]}
        if self.last:
            out["switch"] = self.last
        ready = self.readiness()
        if self.repos or ready or self.probes:
            out["projects"] = projects.report(self.repos, ready, list(self.probes.values()))
        return out

    def owners(self):
        return tuple(self.cfg.get("project_owners") or factory.OWNERS)

    def github(self, args):
        return (self.gh or self.lines[self.home].gh)(args)

    def readiness(self):
        out = []
        for k, v in sorted(self.kv.get_all("-").items()):
            if not k.startswith("ready:"):
                continue
            try:
                r = json.loads(v)
                out.append(projects.Readiness(k[len("ready:"):], r["passed"] is True, tuple(projects.Line(**x) for x in r["lines"]), r["at"]))
            except (ValueError, KeyError, TypeError):
                continue
        return out[:20]

    def record(self, repo, by=""):
        now = self.now()
        done = self.checked_at(repo)
        if done is not None and now - done < RECHECK_FLOOR_S:
            return
        self.checks_run = [t for t in self.checks_run if now - t < 3600]
        if len(self.checks_run) >= READINESS_PER_HOUR:
            return self.problem("project %s not checked: %d readiness checks per hour is the cap" % (repo, READINESS_PER_HOUR))
        self.checks_run.append(now)
        try:
            got = projects.readiness(self.github, repo, self.now(), owners=self.owners())
        except Exception as e:
            return self.problem("project %s not checked: %s" % (repo, type(e).__name__))
        self.kv.set("-", "ready:" + repo, json.dumps(projects.serialize(got)))
        failed = [x.name for x in got.lines if not x.ok]
        self.mod.log("project", "readiness of %s%s: %s" % (repo, " asked by %s" % by if by else "", "passed" if got.passed else "failed at %s" % ", ".join(failed)))

    def checked_at(self, repo):
        at = self.read("ready:" + repo, {}).get("at")
        try:
            return limits.ts(at) if isinstance(at, str) else None
        except ValueError:
            return None

    def asked_at(self, asked):
        try:
            at = limits.ts(asked) if isinstance(asked, str) else None
        except ValueError:
            return None
        if at is None or at <= self.now():
            return at
        if asked not in self.future_asks:
            while len(self.future_asks) >= PROBES_KEPT:
                self.future_asks.pop(next(iter(self.future_asks)))
            self.future_asks[asked] = self.now()
        return self.future_asks[asked]

    def fresh(self, done, asked):
        return done is not None and (asked is None or done >= asked - RECHECK_FLOOR_S)

    def check(self, ask):
        if not isinstance(ask, dict):
            return
        if isinstance(ask.get("path"), str):
            got = projects.probe(ask["path"], self.cfg.get("project_root"))
            self.probes.pop(got.path, None)
            self.probes[got.path] = got
            while len(self.probes) > PROBES_KEPT:
                self.probes.pop(next(iter(self.probes)))
            return
        repo = ask.get("repo")
        if not isinstance(repo, str) or not REPO.match(repo):
            return self.problem("project check not understood: nothing is checked")
        done, asked = self.checked_at(repo), self.asked_at(ask.get("at"))
        if done is None or (asked is not None and done < asked) or (asked is None and self.now() - done >= CHECK_AGAIN_S):
            self.record(repo, printable(ask.get("by")))

    def list_repos(self):
        if self.repos_at is not None and self.now() - self.repos_at < REPOS_AGAIN_S:
            return
        self.repos_at = self.now()
        try:
            self.repos = projects.accessible(self.github, self.owners())
        except Exception as e:
            self.problem("repositories the factory can reach not read: %s" % type(e).__name__)

    def problem(self, text):
        if text not in self.said:
            self.said.add(text)
            self.mod.log("-", text)

    def ready(self, repo, asked=None, by=""):
        if repo == self.home:
            return True
        if asked is not None and not self.fresh(self.checked_at(repo), asked):
            self.record(repo, by)
        fresh = asked is None or self.fresh(self.checked_at(repo), asked)
        return fresh and self.read("ready:" + repo, {}).get("passed") is True

    def drain(self):
        waiting = [(r, len(unpushed(d))) for r, d in self.lines.items() if r != self.active and unpushed(d)]
        self.lines[self.active].taking = not waiting
        if self.draining and not waiting:
            self.mod.log("project", "%s starts: %s has no job left to push" % (self.active, ", ".join(r for r, _ in self.draining)))
        elif waiting and waiting != self.draining:
            self.mod.log("project", "%s waits: %s" % (self.active, "; ".join("%d jobs of %s to push" % (n, r) for r, n in waiting)))
        self.draining = waiting

    def once(self):
        self.apply_controls()
        self.drain()
        self.lines[self.active].once()
        for repo in [r for r in self.lines if r != self.active]:
            if live(self.lines[repo]):
                self.lines[repo].once()
            elif repo != self.home:
                self.lines.pop(repo).close()
        self.kv.set("-", "finishing", json.dumps([r for r, _ in self.finishing()]))
        self.learn(self.lines[self.active].answer)
        self.drained()
        self.apply_controls()
        if self.control() == "STOPPED":
            for d in self.lines.values():
                d.stop_running()

    def learn(self, answer):
        if isinstance(answer, dict):
            self.learn_providers(answer.get("providers"))
            self.learn_order(answer.get("work_order"))
            self.learn_action(answer.get("work_order_action"))
            self.learn_control(answer.get("control"))
            self.check(answer.get("check"))
            if answer.get("repos"):
                self.list_repos()
        if answer is None or (isinstance(answer, dict) and answer.get("project") is None):
            return
        p = answer.get("project") if isinstance(answer, dict) else None
        repo = p.get("repo") if isinstance(p, dict) else None
        if not isinstance(repo, str) or not REPO.match(repo):
            return self.problem("project answer not understood: the factory stays on %s" % self.active)
        by = printable(p.get("by"))
        if repo == self.active:
            if not self.chosen():
                self.last = {"repo": repo, "from": None, "by": by, "at": self.mod.iso(self.now())}
                self.kv.set("-", "project", json.dumps(self.last))
                self.kv.add_event("project", None, json.dumps(self.last))
                self.mod.log("project", "%s chosen by %s" % (repo, by or "?"))
            return
        if not self.ready(repo, self.asked_at(p.get("at")), by):
            return self.problem("project %s not taken: its readiness is not recorded as passed here; the factory stays on %s (picked by %s)" % (repo, self.active, by or "?"))
        try:
            if repo not in self.lines:
                self.open(repo)
        except Exception as e:
            return self.problem("project %s not taken: %s; the factory stays on %s (picked by %s)" % (repo, e if isinstance(e, RuntimeError) else type(e).__name__, self.active, by or "?"))
        old, self.active = self.active, repo
        self.last = {"repo": repo, "from": old, "by": by, "at": self.mod.iso(self.now())}
        self.roles()
        self.kv.set("-", "project", json.dumps(self.last))
        self.kv.add_event("project", old, json.dumps(self.last))
        self.said.clear()
        self.mod.log("project", "%s -> %s by %s; finishing %d jobs of %s" % (old, repo, self.last["by"] or "?", len(live(self.lines[old])), old))

    @property
    def refresh_to(self):
        return self.lines[self.active].refresh_to

    def close(self):
        for d in self.lines.values():
            d.close()
