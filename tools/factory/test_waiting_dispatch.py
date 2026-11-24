import json, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pools
import store as S
from test_dispatch import Base, ready
from test_lines import Pair


def issue(n, deps="none"):
    return {"number": n, "title": "t%d" % n, "body": ready(deps=deps), "comments": []}


class Waiters(Base):
    def job(self, n):
        return self.d.store.get_job(str(n))

    def ended(self, n, state):
        self.d.store.put_job(str(n), state, {"issue": n, "title": "t%d" % n, "state": state, "relabelled": True, "commented": True})

    def test_a_waiter_outside_the_window_leaves_waiting_once_its_holder_ended(self):
        self.w.issues = [issue(5, "#7"), issue(6)]
        self.d = self.new()
        self.ended(7, "rejected")
        self.d.store.put_job("9", "merged", {"issue": 9, "title": "t9", "state": "merged", "pr": 1754, "relabelled": True, "commented": True})
        self.d.store.put_job("6", "waiting", {"issue": 6, "title": "t6", "body": ready(), "state": "waiting", "waiting": [9], "file_wait": [9, "x.py"]})
        self.d.work = {"wait": None, "issues": [5], "order": [5, 6]}
        self.tick(4)
        self.assertNotEqual(self.job(6)["state"], "waiting")

    def test_a_waiter_drops_its_ended_holder_while_its_worker_has_no_room(self):
        self.cfg.update(one_file_one_job=True, types={"coder": {"coworkers": [{"id": "b1", "name": "B1"}], "max_jobs": 0}})
        self.w.issues = [issue(6)]
        self.d = self.new()
        self.d.store.put_job("9", "merged", {"issue": 9, "title": "t9", "state": "merged", "pr": 1754, "relabelled": True, "commented": True})
        self.d.store.put_job("6", "waiting", {"issue": 6, "title": "t6", "body": ready(), "state": "waiting", "worker": "coder",
                                              "waiting": [9], "file_wait": [9, "a/b.py"]})
        self.tick(2)
        j = self.job(6)
        self.assertEqual(j["state"], "waiting")
        self.assertNotIn("file_wait", j)
        self.assertNotIn(9, j.get("waiting") or [])

    def test_a_waiter_on_a_rejected_dependency_ends_blocked_in_one_beat_with_one_comment(self):
        self.w.issues = [issue(5, "#7")]
        self.d = self.new()
        self.ended(7, "rejected")
        self.d.work = {"wait": None, "issues": [5], "order": [5]}
        self.tick()
        j = self.job(5)
        self.assertEqual((j["state"], j.get("reason")),("blocked", "dependency #7 ended rejected"))
        self.tick(2)
        self.assertEqual(len(self.w.issue(5)["comments"]), 1)
        self.assertEqual(self.job(5)["state"], "blocked")

    def test_a_building_row_closed_by_a_merged_pull_request_ends_merged(self):
        self.w.issues = [issue(5)]
        self.w.unlabelled.add(5)
        self.w.closers[5] = [11]
        self.w.pr_state = "MERGED"
        self.d = self.new()
        self.d.store.put_job("5", "building", {"issue": 5, "title": "t5", "body": ready(), "state": "building", "round": 1,
                                               "worker": "coder", "paths": ["a/b.py"], "test": "a/test_b.py"})
        self.d.store.set("5", "order_consent", "1")
        self.d.beats = 9
        self.tick()
        j = self.job(5)
        self.assertEqual((j["state"], j.get("pr")), ("merged", 11))


class Window(Pair):
    def order(self, issues, most):
        s = S.Store(self.cfg["ledger_file"])
        at = "2026-11-23T00:00:00Z"
        s.set("-", "project", json.dumps({"repo": "o/r", "from": None, "by": "test", "at": at}))
        s.add_event("project", None, s.get_all("-")["project"])
        s.set("-", "work_order", json.dumps({"id": "w", "repo": "o/r", "kind": "all_issues", "issues": issues, "text": "", "by": "test", "at": at}))
        s.set("-", "throttle", json.dumps({"max_ghosts": most, "stations": {}, "by": "test", "at": at}))
        s.close()

    def test_waiting_rows_take_no_slot_in_the_work_order_window(self):
        self.order([10, 11, 12, 13, 14, 15, 16], 6)
        self.d = self.new()
        line = self.d.lines["o/r"]
        for n in range(10, 16):
            line.store.put_job(str(n), "waiting", {"issue": n, "title": "t%d" % n, "body": ready(), "state": "waiting", "waiting": [99]})
        got = self.d.work()
        self.assertIn(16, got["issues"])
        self.assertEqual([n for n in got["issues"] if n < 16], [])

    def test_a_station_asked_for_zero_seats_keeps_one(self):
        self.cfg["builders"] = [{"id": "code", "name": "code"}, {"id": "larry", "name": "LARRY"}]
        self.order([5], 1)
        self.d = self.new()
        self.d.kv.set("-", "control", json.dumps({"state": "RUNNING", "by": "test", "at": "2026-11-23T00:00:00Z"}))
        self.answer["throttle"] = {"max_ghosts": 0, "stations": {"code": 0, "LARRY": 0}, "by": "rob", "at": "2026-11-23T21:00:00Z"}
        self.tick(3)
        cfg = self.d.lines["o/r"].cfg
        self.assertEqual((cfg["pool"]["seats"]["code"], cfg["pool"]["seats"]["LARRY"]), (1, 1))
        self.assertGreaterEqual(pools.seats(cfg, "coder"), 1)
        self.assertGreaterEqual(cfg["pool"]["max"], 1)


if __name__ == "__main__":
    unittest.main()
