import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dispatch


class FinalState(unittest.TestCase):
    def test_the_allowed_files_line_names_the_tests_adapted_exception(self):
        j = {"issue": 7, "title": "Fix x", "body": "**Files**\n- `a.py`\n"}
        lines = dispatch.final_state(j, "`PR: <url>`").split("\n")
        self.assertIn(
            "- Allowed files: a.py, plus each existing test file the pull request body lists under `## Tests adapted`.",
            lines,
        )


if __name__ == "__main__":
    unittest.main()
