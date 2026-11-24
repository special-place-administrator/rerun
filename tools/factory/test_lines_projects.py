import contextlib
import json
import os
import tempfile
import unittest
import unittest.mock

import factory
import projects as P
from test_lines import Pair

LIMITS = {"max_count": 10, "max_project_mb": 500, "max_total_mb": 2000, "upload_max_mb": 200,
          "upload_max_files": 20000, "upload_max_depth": 32, "upload_max_file_mb": 50}


class ProjectDir(unittest.TestCase):
    def setUp(self):
        work = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(unittest.mock.patch.object(factory, "WORK", work))
        self.root = os.path.join(work, "projects")

    def test_only_positive_integer_parts_of_the_account_workspace_make_a_path_inside_the_root(self):
        self.assertEqual(P.project_dir("1", "7", "1"), os.path.join(os.path.realpath(self.root), "1", "7"))
        self.assertEqual(P.project_dir(1, 7, 1), os.path.join(os.path.realpath(self.root), "1", "7"))
        for parts in [("1", "0", "1"), ("1", "../2", "1"), ("2", "3", "1"), ("0", "1", "0"), ("1", "-1", "1"), ("1", "7\n", "1"),
                      ("1", "1" * 20, "1"), ("1", "", "1"), (True, "1", True), ("1", None, "1"), ("1", 1.0, "1")]:
            self.assertIsNone(P.project_dir(*parts), parts)

    def test_a_project_folder_that_is_a_link_out_of_the_root_is_refused(self):
        os.makedirs(os.path.join(self.root, "1"))
        os.symlink("/tmp", os.path.join(self.root, "1", "7"))
        self.assertIsNone(P.project_dir("1", "7", "1"))

    def test_the_repo_rules_match_the_hub(self):
        self.assertTrue(P.safe_repo("acme/app"))
        for repo in ("acme/..", "acme/.", "acme/-x", "acme/.x", "acme/a..b", "-acme/app", "acme/app/x", "acme", 7, "acme/app\n"):
            self.assertFalse(P.safe_repo(repo), repo)


class LearnProjects(Pair):
    def setUp(self):
        super().setUp()
        self.enterContext(unittest.mock.patch.object(factory, "WORK", self.dir.name))
        self.enterContext(unittest.mock.patch.object(P, "free_gb", return_value=1000, create=True))
        self.popen = self.enterContext(unittest.mock.patch("subprocess.Popen"))
        self.popen.return_value.poll.return_value = None
        self.cfg["project_owners"] = ["acme"]
        self.start()

    def learn(self, queue, ws=11, limits=LIMITS, ids=None):
        answer = {"kept": True, "projects": {"workspace_id": ws, "limits": limits, "ids": ids if ids is not None else [q["id"] for q in queue], "queue": queue}}
        with contextlib.redirect_stdout(self.out):
            self.d.learn(answer)

    def items(self):
        return {i["id"]: i for i in self.d.extra()["projects"].get("items", [])}

    def test_an_owner_outside_the_owners_list_is_failed_owner_not_allowed_and_nothing_is_cloned(self):
        self.learn([{"id": 5, "repo": "stranger/app", "source": "github"}])
        self.assertEqual(self.items()[5], {"id": 5, "state": "failed", "progress": None, "error_code": "owner_not_allowed"})
        self.popen.assert_not_called()

    def test_a_repo_outside_the_rules_is_failed_invalid_link_and_nothing_is_cloned(self):
        self.learn([{"id": 5, "repo": "acme/..", "source": "github"}, {"id": 6, "repo": "acme/-x", "source": "github"}])
        self.assertEqual({i: x["error_code"] for i, x in self.items().items()}, {5: "invalid_link", 6: "invalid_link"})
        self.popen.assert_not_called()

    def test_missing_or_invalid_limits_fail_every_queued_project_quota_unset(self):
        self.learn([{"id": 5, "repo": "acme/app", "source": "github"}], limits=None)
        self.learn([{"id": 5, "repo": "acme/app", "source": "github"}, {"id": 6, "repo": "acme/site", "source": "github"}], limits=dict(LIMITS, max_count=0))
        self.assertEqual({i: x["error_code"] for i, x in self.items().items()}, {5: "quota_unset", 6: "quota_unset"})
        self.popen.assert_not_called()

    def test_another_workspace_than_the_first_one_seen_is_refused_and_nothing_is_processed(self):
        self.learn([], ws=11)
        os.makedirs(os.path.join(self.dir.name, "projects", "11", "4"))
        self.learn([{"id": 5, "repo": "acme/app", "source": "github"}], ws=12, ids=[5])
        self.assertEqual(self.items(), {})
        self.popen.assert_not_called()
        self.assertTrue(os.path.isdir(os.path.join(self.dir.name, "projects", "11", "4")))
        self.assertIn("workspace", self.out.getvalue())

    def test_a_queued_project_is_cloned_once_through_the_mirror_and_reported_cloning(self):
        queue = [{"id": 5, "repo": "acme/app", "source": "github"}, {"id": 6, "repo": "acme/site", "source": "github"}]
        self.learn(queue)
        self.learn(queue)
        self.assertEqual(self.popen.call_count, 1)
        self.assertEqual(self.popen.call_args[0][0][-2:], ["refresh", "acme/app"])
        self.assertEqual(self.items()[5]["state"], "cloning")
        self.assertEqual(self.d.extra()["projects"]["owners"], ["acme"])

    def test_a_finished_clone_writes_meta_and_is_ready_also_after_a_restart(self):
        mirror = os.path.join(self.dir.name, "state", "mirrors", "app.git")
        os.makedirs(mirror)
        with open(os.path.join(mirror, "pack"), "wb") as f:
            f.write(b"x" * 1000)
        with unittest.mock.patch("mirror.path", return_value=mirror):
            self.learn([{"id": 5, "repo": "acme/app", "source": "github"}])
            self.popen.return_value.poll.return_value = 0
            self.learn([{"id": 5, "repo": "acme/app", "source": "github"}])
        self.assertEqual(self.items()[5]["state"], "ready")
        meta = os.path.join(self.dir.name, "projects", "11", "5", "meta.json")
        with open(meta) as f:
            self.assertEqual({k: v for k, v in json.load(f).items() if k != "at"}, {"owner": "acme", "repo": "acme/app", "source": "github", "bytes": 1000})
        self.assertEqual(os.stat(meta).st_mode & 0o777, 0o600)
        self.d.close()
        self.d = self.new()
        self.learn([], ids=[5])
        self.assertEqual(self.items()[5]["state"], "ready")

    def test_a_clone_that_ends_without_a_mirror_is_not_ready_and_is_cloned_again(self):
        missing = os.path.join(self.dir.name, "state", "mirrors", "app.git")
        with unittest.mock.patch("mirror.path", return_value=missing):
            self.learn([{"id": 5, "repo": "acme/app", "source": "github"}])
            self.popen.return_value.poll.return_value = 0
            self.learn([{"id": 5, "repo": "acme/app", "source": "github"}])
        self.assertEqual(self.items()[5]["state"], "cloning")
        self.assertEqual(self.popen.call_count, 2)
        self.assertFalse(os.path.exists(os.path.join(self.dir.name, "projects", "11", "5", "meta.json")))

    def test_a_failed_clone_reports_a_known_code_only_and_never_the_mirror_output(self):
        def failing(argv, stdout=None, **kw):
            os.write(stdout, b"TRANSIENT: not_reachable mirror acme/app: fatal: secret remote text\n")
            return self.popen.return_value
        self.popen.side_effect = failing
        self.learn([{"id": 5, "repo": "acme/app", "source": "github"}])
        self.popen.return_value.poll.return_value = 3
        self.learn([{"id": 5, "repo": "acme/app", "source": "github"}])
        self.assertEqual(self.items()[5], {"id": 5, "state": "failed", "progress": None, "error_code": "not_reachable"})
        self.assertNotIn("secret remote text", json.dumps(self.d.extra()))

    def test_a_failure_the_hub_stored_is_forgotten_so_a_retry_clones_again(self):
        self.learn([{"id": 5, "repo": "stranger/app", "source": "github"}])
        self.learn([], ids=[5])
        self.assertNotIn(5, self.items())
        self.cfg["project_owners"] = ["acme", "stranger"]
        self.learn([{"id": 5, "repo": "stranger/app", "source": "github"}])
        self.assertEqual(self.items()[5]["state"], "cloning")

    def test_a_folder_whose_id_the_hub_no_longer_has_is_removed(self):
        for n in ("4", "5"):
            os.makedirs(os.path.join(self.dir.name, "projects", "11", n))
        self.learn([], ids=[5])
        self.assertEqual(sorted(os.listdir(os.path.join(self.dir.name, "projects", "11"))), ["5"])


if __name__ == "__main__":
    unittest.main()
