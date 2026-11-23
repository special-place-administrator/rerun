import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatch

SENTENCE = (
    "When the issue has a **Proven branch** line and you change Files or Change, take that line out: "
    "you cannot push the branch again, and the builder starts from today's dev."
)


class ReplanBrief(unittest.TestCase):
    def test_the_replan_brief_takes_out_a_stale_proven_branch_line(self):
        brief = dispatch.replan_brief({"issue": 1599, "title": "Fix x", "reason": "r"}, "o/r", 1)
        self.assertIn(SENTENCE, brief)
        lines = brief.split("\n")
        step2 = [line for line in lines if line.startswith("2. ")]
        self.assertEqual(len(step2), 1)
        self.assertTrue(step2[0].endswith("save only when it prints OK. " + SENTENCE))


if __name__ == "__main__":
    unittest.main()
