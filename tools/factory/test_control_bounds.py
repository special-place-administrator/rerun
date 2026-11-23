import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class ControlBoundsTest(unittest.TestCase):
    def test_the_bounds_carry_no_copies_or_wip_only_the_rework_threshold(self):
        bounds = json.loads((HERE / "control-bounds.json").read_text(encoding="utf-8"))
        self.assertEqual(bounds, {"rework_threshold": 3})


if __name__ == "__main__":
    unittest.main()
