import io, json, os, sys, unittest, unittest.mock
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatch as D
from test_dispatch import Base


def hub_tool_error(payload):
    answer = {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(payload)}], "isError": True}}
    return D.make_account("https://hub/mcp", "k", opener=lambda req, timeout: io.BytesIO(json.dumps(answer).encode()))


def engine_refusal(prose):
    body = json.dumps({"error": prose, "code": D.NO_ROUTE})
    return {"error": "The coworker could not be reached: 503 " + body, "code": D.NO_ROUTE}


class Replan(Base):
    def setUp(self):
        super().setUp()
        self.cfg["types"] = {
            "coder": {"max_jobs": 8, "coworkers": [{"id": "b1", "name": "B1", "runs": 1}]},
            "reviewer": {"coworkers": [{"id": "r1", "name": "R1", "runs": 1}]},
            "planner": {"coworkers": [{"id": "p1", "name": "Boss", "runs": 1}, {"id": "p2", "name": "IKE", "runs": 1}]},
        }

    def data(self):
        return json.loads(self.w.rows("SELECT data FROM jobs WHERE job='5'")[0][0])

    def planner_sends(self, agent=None):
        return [s for s in self.w.sends if s[0] in (("p1", "p2") if agent is None else (agent,))]

    def block(self, text="BLOCKED: plan: a file outside its paths"):
        self.tick()
        self.w.finish("b1", text)
        self.tick()

    def test_a_plan_return_goes_to_the_first_planner_with_the_reason(self):
        self.block()
        self.assertEqual(self.state(), "returned")
        sent = self.planner_sends()
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], "p1")
        for part in ("a file outside its paths", "Re-plan 1 of 2", "**Corrections**", "--add-label factory --remove-label factory-blocked"):
            self.assertIn(part, sent[0][1])
        self.assertEqual(self.data()["replans"], 1)

    def test_an_ordinary_block_is_not_replanned(self):
        self.block("BLOCKED: cannot write the file")
        self.assertEqual(self.state(), "blocked")
        self.assertEqual(self.planner_sends(), [])

    def test_at_most_two_replans_then_it_ends_unsolvable(self):
        self.block()
        self.w.unlabelled.clear()
        self.block()
        self.w.unlabelled.clear()
        self.block()
        self.assertEqual(self.state(), "unsolvable")
        self.assertEqual(len(self.planner_sends("p1")), 2)
        self.assertEqual(self.planner_sends("p2"), [])
        self.assertEqual(self.data()["replans"], 2)
        self.tick(3)
        self.assertEqual(len(self.planner_sends()), 2)

    def test_a_send_that_raised_is_not_counted_and_is_tried_again(self):
        self.tick()
        self.w.finish("b1", "BLOCKED: plan: a file outside its paths")
        self.w.cut_off_next_send = False
        original = self.w.account

        def cut(tool, args):
            if tool == "send_message" and args["agentId"] == "p1" and not getattr(self, "cut_done", False):
                self.cut_done = True
                self.w.cut_off_next_send = True
            return original(tool, args)

        self.w.account = cut
        self.d = None
        self.tick(fresh=True)
        self.assertNotIn("replans", self.data())
        self.tick()
        self.assertEqual(self.data()["replans"], 1)
        self.assertEqual(len(self.planner_sends()), 2)

    def test_a_re_plan_the_engine_refuses_four_times_waits_with_clean_beats_and_goes_once_when_it_can_run(self):
        original, refused, beats = self.w.account, [], []

        def refuse(tool, args, **kw):
            if tool == "send_message" and args["agentId"] in ("p1", "p2") and len(refused) < 4:
                refused.append(args["agentId"])
                hub_tool_error(engine_refusal("Refusal %d, worded anew by a newer engine" % len(refused)))(tool, args)
            return original(tool, args, **kw)

        self.w.account = refuse
        with unittest.mock.patch.object(D.Dispatcher, "beat_end", lambda d, clean: beats.append(clean)):
            self.tick()
            self.w.finish("b1", "BLOCKED: plan: a file outside its paths")
            self.tick()
            self.tick()
            self.assertEqual(len(refused), 1)
            for _ in range(20):
                if len(refused) >= 4:
                    break
                self.w.clock += 300
                self.tick()
            self.assertEqual((len(refused), self.state(), self.planner_sends(), self.data().get("replans"), self.data().get("sending")), (4, "returned", [], None, None))
            self.w.clock += 300
            self.tick(3)
        self.assertEqual((len(self.planner_sends("p1")), self.data()["replans"], self.state()), (1, 1, "returned"))
        self.assertNotIn(False, beats)
        self.assertFalse(self.d.store.retries("5", "transient"))

    def test_the_hub_names_a_refusal_by_its_code_or_older_wording_and_nothing_else(self):
        def named(payload):
            with self.assertRaises(D.Error) as e:
                hub_tool_error(payload)("send_message", {})
            return D.NO_ROUTE in str(e.exception)
        older = {"error": "The coworker could not be reached: 503 {\"error\":\"No connection can run this coworker now: no model\"}"}
        self.assertEqual((named(engine_refusal("anything at all")), named(older), named({"error": "boom"}), named({"error": "x", "code": "other"})), (True, True, False, False))

    def test_a_structured_code_decides_before_the_older_wording(self):
        def named(payload):
            with self.assertRaises(D.Error) as e:
                hub_tool_error(payload)("send_message", {})
            return ("invalid_goal" in str(e.exception), D.NO_ROUTE in str(e.exception))
        self.assertEqual(named({"code": "other", "error": "No connection can run this coworker now"}), (False, False))
        self.assertEqual(named({"code": D.NO_ROUTE, "error": "invalid_goal"}), (False, True))
        self.assertEqual(named({"code": "invalid_goal", "error": "x"}), (True, False))
        self.assertEqual(named({"error": "invalid_goal: lastLineForms is empty"}), (True, False))
        self.assertEqual(named({"code": "", "error": "No connection can run this coworker now"}), (False, True))

    def test_a_re_plan_never_goes_to_a_planner_without_issue_access(self):
        self.tick()
        self.w.finish("b1", "BLOCKED: plan: a file outside its paths")
        with unittest.mock.patch.object(D.Dispatcher, "running", return_value=[("p1", 1)]):
            self.tick(2)
        self.assertEqual(self.state(), "returned")
        self.assertEqual(self.planner_sends(), [])
        self.assertNotIn("replans", self.data())
        self.tick()
        self.assertEqual([s[0] for s in self.planner_sends()], ["p1"])
        self.assertEqual(self.data()["replans"], 1)


if __name__ == "__main__":
    unittest.main()
