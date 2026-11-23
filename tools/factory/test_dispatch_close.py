import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_dispatch import Base, HEAD, wf


class DispatchClose(Base):
    def test_a_merged_job_closes_its_issue(self):
        real = self.w.gh

        def gh(args):
            a = list(args)
            if a[:2] == ["pr", "view"]:
                self.w.gh_calls.append(a)
                return json.dumps({
                    "headRefOid": HEAD,
                    "state": self.w.pr_state,
                    "mergeable": self.w.mergeable,
                    "body": "Body without closing line.",
                    "closingIssuesReferences": [],
                    "comments": [{"body": c} for c in getattr(self.w, "pr_comments", [])],
                    "mergeCommit": {"oid": self.w.merge_sha},
                })
            return real(a)

        self.w.gh = gh
        self.to_checks()
        self.w.workflows[HEAD] = [wf("ci", "success")]
        before = len(self.w.gh_calls)
        self.tick(3)
        self.assertEqual(self.state(), "merged")
        after = [
            c for c in self.w.gh_calls[before:]
            if c[:3] in (["issue", "comment", "5"], ["issue", "close", "5"])
        ]
        self.assertEqual(len(after), 2)
        self.assertEqual(
            after[0],
            ["issue", "comment", "5", "-R", "o/r", "--body", "The factory dispatcher merged pull request #42 at %s." % HEAD[:7]],
        )
        self.assertEqual(after[1], ["issue", "close", "5", "-R", "o/r"])

    def test_other_ended_states_keep_todays_path(self):
        self.tick()
        self.w.finish("b1", "tried\nBLOCKED: no")
        self.tick()
        self.assertEqual(self.state(), "blocked")
        self.assertEqual([c for c in self.w.gh_calls if c[:2] == ["issue", "close"]], [])


if __name__ == "__main__":
    unittest.main()
