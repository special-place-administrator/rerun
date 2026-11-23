import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pools

HERE = os.path.dirname(os.path.abspath(__file__))
BARBARA = "b0e5b39f-74e3-4dfd-9d16-8cf53934ad05"


def load(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return json.load(f)


class SettingsAcceptor(unittest.TestCase):
    def test_the_shipped_settings_have_the_acceptor_type_with_barbara(self):
        settings = load("dispatch.json")
        acceptor = settings["types"]["acceptor"]
        self.assertEqual(acceptor["coworkers"], [{"id": BARBARA, "name": "BARBARA"}])
        self.assertNotIn("max_jobs", acceptor)
        pool = pools.types({"types": {"acceptor": acceptor}})["acceptor"]
        self.assertEqual([(c["name"], c["runs"]) for c in pool["coworkers"]], [("BARBARA", 1)])


if __name__ == "__main__":
    unittest.main()
