import io, json, os, sys, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import factory as F
import test_risk_claims

KNOWN_BAD = json.load(open(os.path.join(HERE, "fixtures", "jev_known_bad.json"), encoding="utf-8"))
ASKED = ("BRUCE", "CODD", "GRACE", "FRED")


def patch_file(*lines):
    return "@@ -1,3 +1,%d @@\n context line\n%s" % (len(lines), "\n".join(lines))


class Judge:
    def __init__(self, answers, tokens=321):
        self.answers, self.tokens, self.sent = answers, tokens, []

    def __call__(self, req, timeout=None):
        self.sent.append(req)
        return io.BytesIO(json.dumps({"answers": {k: {"noul": p} for k, p in self.answers.items()},
                                      "usage": {"input_tokens": self.tokens}}).encode())

    def body(self):
        return json.loads(self.sent[0].data)


def ask(pr, files, answers, key="test-key"):
    judge, need = Judge(answers), {}
    with mock.patch.object(F, "_jev_key", return_value=key), mock.patch.object(F.urllib.request, "urlopen", judge):
        note = F.jev_risk(pr, files, need)
    return judge, need, note


def changed_lines(body):
    return [line for entry in body["state"]["change"]["diff_summary"] for line in entry["lines"]]


def band_of(need, who):
    if who not in need:
        return "no"
    return "unsure" if "unsure" in need[who][0] else "yes"


class TestKnownBad(unittest.TestCase):
    def test_every_known_bad_carries_its_evidence_and_never_passes_linus_alone(self):
        self.assertEqual([x["id"] for x in KNOWN_BAD], ["1635", "MW-NOSTART", "1760@ebccf89e", "1762@fc13f33e"])
        for fx in KNOWN_BAD:
            with self.subTest(fx["id"]):
                judge, need, note = ask(fx["pr"], fx["files"], fx["judge"])
                self.assertEqual(len(judge.sent), 1, note)
                body = judge.body()
                self.assertEqual(sorted(body["questions"]), sorted(ASKED))
                text = "\n".join(changed_lines(body))
                for evidence in fx["evidence"]:
                    self.assertIn(evidence, text)
                self.assertFalse([l for l in changed_lines(body) if l.startswith("@@") or l[:1] not in "+-"])
                self.assertEqual({w: band_of(need, w) for w in ASKED}, {w: fx["expect"][w] for w in ASKED}, note)
                self.assertTrue(need, "LINUS alone on a known-bad change")
                self.assertTrue(fx["expect"]["not_linus_alone"])


class TestBand(unittest.TestCase):
    PR = {"title": "t", "body": ""}
    FILES = [{"filename": "src/a.py", "status": "modified", "additions": 1, "deletions": 0, "patch": patch_file("+x = 1")}]

    def test_the_named_threshold_is_0_70(self):
        self.assertEqual(F.JEV_T, 0.70)

    def test_boundaries_of_the_band(self):
        judge, need, note = ask(self.PR, self.FILES, {"BRUCE": F.JEV_T, "CODD": 1 - F.JEV_T, "GRACE": F.JEV_T - 0.01, "FRED": 1 - F.JEV_T + 0.01})
        self.assertEqual({w: band_of(need, w) for w in ASKED}, {"BRUCE": "yes", "CODD": "no", "GRACE": "unsure", "FRED": "unsure"}, note)
        self.assertIn("Jev says likely (p 0.70, confidence 0.40)", need["BRUCE"][0])
        self.assertIn("held for this reviewer", need["GRACE"][0])
        for part in ("BRUCE yes", "CODD no", "GRACE unsure", "FRED unsure", "321 input tokens"):
            self.assertIn(part, note)
        self.assertNotIn("file names and title only", note)

    def test_the_band_follows_the_named_threshold(self):
        with mock.patch.object(F, "JEV_T", 0.9):
            judge, need, note = ask(self.PR, self.FILES, {"BRUCE": 0.8, "CODD": 0.05, "GRACE": 0.95, "FRED": 0.1})
        self.assertEqual({w: band_of(need, w) for w in ASKED}, {"BRUCE": "unsure", "CODD": "no", "GRACE": "yes", "FRED": "unsure"}, note)

    def test_confidence_is_the_noul_formula(self):
        self.assertAlmostEqual(F.jev_confidence(0.85), 0.70)
        self.assertAlmostEqual(F.jev_confidence(0.5), 0.0)
        self.assertAlmostEqual(F.jev_confidence(1.0), 1.0)


class TestState(unittest.TestCase):
    PR = {"title": "t", "body": ""}
    LOW = {w: 0.1 for w in ASKED}

    def test_a_credential_looking_line_never_reaches_the_judge(self):
        values = ["gh" + "p_" + "Q7xk2Lm9" * 5, "github" + "_pat_" + "11AB" * 8, "s" + "k-" + "Zr4Tq8Wn" * 4,
                  "A9f" + "Kq2Lx7Pz4Rt8Vb1Nc6Hd3Js5Wy0Mg"]
        lines = ["+token = \"%s\"" % values[0], "+headers = {\"Authorization\": \"Bear" + "er %s\"}" % values[1],
                 "-OPENAI = '%s'" % values[2], "+    api_key: %s" % values[3], "+-----BEGIN RSA PRIV" + "ATE KEY-----",
                 "+blob = \"%s\"" % ("nB3xQ9vL2kP7wR5tY8zM4cF6hJ1sD0gA" * 2), "+keep = 'this line stays'"]
        judge, need, note = ask(self.PR, [{"filename": "src/c.py", "status": "modified", "additions": 6, "deletions": 1, "patch": patch_file(*lines)}], self.LOW)
        raw = judge.sent[0].data.decode()
        for v in values + ["PRIVATE KEY", "nB3xQ9vL2kP7wR5tY8zM4cF6hJ1sD0gA"]:
            self.assertNotIn(v, raw)
        sent = changed_lines(judge.body())
        self.assertEqual(sum(F.JEV_SECRET in l for l in sent), 6, sent)
        self.assertIn("+keep = 'this line stays'", sent)

    def test_one_huge_file_cannot_starve_the_small_ones(self):
        huge = {"filename": "src/huge.py", "status": "modified", "additions": 3000, "deletions": 0,
                "patch": patch_file(*["+value_%d = compute(%d) * %d" % (i, i, i) for i in range(3000)])}
        small = [{"filename": "src/s%d.py" % i, "status": "modified", "additions": 2, "deletions": 1,
                  "patch": patch_file("+evidence_%d = must_reach_the_judge()" % i, "-old_%d = gone()" % i)} for i in range(3)]
        judge, need, note = ask(self.PR, [huge] + small, self.LOW)
        entries = {e["file"]: e for e in judge.body()["state"]["change"]["diff_summary"]}
        self.assertLessEqual(len(judge.sent[0].data), F.JEV_TOKENS_MAX * F.JEV_CHARS_PER_TOKEN)
        text = "\n".join(changed_lines(judge.body()))
        for i in range(3):
            self.assertIn("+evidence_%d = must_reach_the_judge()" % i, text)
            self.assertIn("-old_%d = gone()" % i, text)
        self.assertEqual(entries["src/huge.py M +3000/-0"]["cut"], 3000 - len(entries["src/huge.py M +3000/-0"]["lines"]))
        self.assertGreater(len(entries["src/huge.py M +3000/-0"]["lines"]), 10)
        self.assertNotIn("cut", entries["src/s0.py M +2/-1"])

    def test_twenty_five_ordinary_files_each_send_their_lines(self):
        paths = (["apps/ui/app/(dashboard)/settings/factory/components/ProjectRow%02d.tsx" % i for i in range(8)]
                 + ["apps/engine/src/connections/refreshPlan%02d.ts" % i for i in range(7)]
                 + ["tools/factory/step%02d.py" % i for i in range(7)]
                 + ["tools/factory/test_step%02d.py" % i for i in range(3)])
        files = [{"filename": p, "status": "modified", "additions": 5, "deletions": 2,
                  "patch": patch_file(*["+    const row%d = useProjectRow(project, %d)" % (j, i) for j in range(5)]
                                      + ["-    const row%d = useRow(project)" % j for j in range(2)])} for i, p in enumerate(paths)]
        judge, need, note = ask(self.PR, files, self.LOW)
        raw, change = judge.sent[0].data.decode(), judge.body()["state"]["change"]
        self.assertNotIn("files", change)
        for p in paths:
            self.assertEqual(raw.count(json.dumps(p)[1:-1]), 1, p)
        self.assertLessEqual(len(judge.sent[0].data), F.JEV_TOKENS_MAX * F.JEV_CHARS_PER_TOKEN)
        entries = {e["file"].rsplit(" ", 2)[0]: e for e in change["diff_summary"]}
        for p in paths[:22]:
            self.assertGreaterEqual(len(entries[p]["lines"]), F.JEV_LINES_MIN, p)

        code = ["apps/engine/src/connections/refreshPlan%02d.ts" % i for i in range(17)]
        tests = ["tools/factory/test_step%02d.py" % i for i in range(8)]
        files = ([{"filename": p, "status": "modified", "additions": 6, "deletions": 0,
                   "patch": patch_file(*[("+    const plan%d = refresh(%d) " % (j, i)).ljust(40, "x") for j in range(6)])} for i, p in enumerate(code)]
                 + [{"filename": p, "status": "modified", "additions": 6, "deletions": 0,
                     "patch": patch_file(*[("+    assert step%d(%d) == " % (j, i)).ljust(F.JEV_LINE_MAX, "y") for j in range(6)])} for i, p in enumerate(tests)])
        judge, need, note = ask(self.PR, files, self.LOW)
        self.assertLessEqual(len(judge.sent[0].data), F.JEV_TOKENS_MAX * F.JEV_CHARS_PER_TOKEN)
        sent = {e["file"].rsplit(" ", 2)[0]: len(e["lines"]) for e in judge.body()["state"]["change"]["diff_summary"]}
        short = [p for p in code if sent.get(p, 0) < F.JEV_LINES_MIN]
        if short:
            self.assertEqual([p for p in tests if sent.get(p, 0)], [], short)
        self.assertEqual(short, [], sent)

    def test_no_credential_leaves_in_the_title_a_name_or_a_line(self):
        gh = "gh" + "p_" + "Q7xk2Lm9Rt4Vb8Nc1Hd6Js3Wy0Mg5Pz7Kq"
        split = "gh" + "o_" + "Zr4Tq8Wn" * 4
        secrets = {"aws": "AKIA" + "Q7XK2LM9RT4VB8NC", "slack": "xox" + "s-" + "1234567890-abcdefABCDEF",
                   "dotted": "gh" + "s_" + "Q7xk2Lm9.Rt4Vb8Nc1-Hd6Js3", "encoded": "Hunter2" + "Hunter2", "userinfo": "Sup3r" + "S3cretPw"}
        sha = "+pinned = '%s'" % ("abcdef0123456789" * 2 + "abcdef01")
        lines = ["+q = 'user%3Dbob%26pass" + "word%3D" + secrets["encoded"] + "'", "+AWS_ID = '%s'" % secrets["aws"],
                 "+hook = '%s'" % secrets["slack"], "+t = '%s'" % secrets["dotted"], "+tok = ('%s'" % split[:12], "+       '%s')" % split[12:],
                 "+DATABASE_URL=postgres://app:" + secrets["userinfo"] + "@db.internal:5432/app", sha]
        files = [{"filename": "src/app.py", "status": "modified", "additions": len(lines), "deletions": 0, "patch": patch_file(*lines)},
                 {"filename": "config/%s.env.txt" % gh, "status": "added", "additions": 1, "deletions": 0, "patch": patch_file("+x = 1")}]
        judge, need, note = ask({"title": "fix: rotate key " + gh, "body": "token " + gh}, files, self.LOW)
        raw = judge.sent[0].data.decode()
        for v in [gh, split[:12], split[12:]] + list(secrets.values()):
            self.assertNotIn(v, raw)
        self.assertIn("[name withheld] A +1/-0", [e["file"] for e in judge.body()["state"]["change"]["diff_summary"]])
        self.assertIn(sha, changed_lines(judge.body()))


class TestCallSite(unittest.TestCase):
    FILES = [{"filename": "tools/factory/dispatch.py", "additions": 60, "deletions": 10},
             {"filename": "tools/factory/plancheck.py", "additions": 10, "deletions": 5}]

    def test_the_judge_is_asked_on_every_pr_unless_told_not_to(self):
        for flags, calls in (((), 1), (("--no-jev",), 0)):
            with self.subTest(flags):
                jev = mock.Mock(return_value="Jev (diff summary, 1 input tokens): BRUCE no 0.10")
                code, lines = test_risk_claims.risk(self.FILES, other=(), jev=jev, flags=flags)
                self.assertEqual(code, 0, lines)
                self.assertEqual(jev.call_count, calls, lines)
                self.assertEqual("Jev (diff summary, 1 input tokens): BRUCE no 0.10" in lines, bool(calls), lines)


class TestNoKey(unittest.TestCase):
    def test_no_key_asks_nothing(self):
        judge, need, note = ask({"title": "t", "body": ""}, TestBand.FILES, {w: 0.9 for w in ASKED}, key=None)
        self.assertEqual(note, "Jev: not asked (no key).")
        self.assertEqual(judge.sent, [])
        self.assertEqual(need, {})


if __name__ == "__main__":
    unittest.main()
