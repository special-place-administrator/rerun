import json
import os
import tempfile
import unittest
import unittest.mock

import projects as P

OWNED = "special-place-ai-heaven/app"


class GitHub:
    def __init__(self, repos=None, issues=True, label=False, app=True):
        self.calls, self.issues, self.label, self.app = [], issues, label, app
        self.repos = repos or []

    def __call__(self, args):
        a = list(args)
        self.calls.append(a)
        path = next(x for x in a[1:] if not x.startswith("-") and x not in ("POST", "DELETE"))
        if path == "repos/%s" % OWNED:
            return json.dumps({"full_name": OWNED, "has_issues": self.issues, "permissions": {"push": True}})
        if path == "repos/%s/branches/dev" % OWNED:
            return "abc123\n"
        if path == "repos/%s/actions/workflows" % OWNED:
            return "CI\nDone-test red before green\n"
        if path == "repos/%s/labels/factory" % OWNED:
            if not self.label:
                raise RuntimeError("gh api failed: exit 1: gh: Not Found (HTTP 404)")
            return "factory\n"
        if path in ("repos/%s/labels" % OWNED, "repos/%s/git/refs" % OWNED) or path.startswith("repos/%s/git/refs/heads/factory-ready-" % OWNED):
            return "{}"
        if path == "installation/repositories":
            if not self.app:
                raise RuntimeError("gh api failed: exit 1: HTTP 403")
            return "".join(r + "\n" for r in self.repos)
        if path.startswith("user/repos"):
            return "".join(r + "\n" for r in self.repos)
        raise RuntimeError("gh api failed: exit 1: gh: Not Found (HTTP 404)")

    def writes(self):
        return [c for c in self.calls if "POST" in c or "DELETE" in c]


class Readiness(unittest.TestCase):
    def test_a_project_is_ready_only_when_every_line_passes_and_nothing_is_written_after_a_failed_line(self):
        gh = GitHub()
        got = P.readiness(gh, OWNED, 1000.0)
        self.assertTrue(got.passed)
        self.assertEqual([(x.name, x.ok) for x in got.lines], [(n, True) for n in P.READINESS_LINES])
        writes = gh.writes()
        self.assertEqual([c[c.index("-X") + 1] for c in writes], ["POST", "POST", "DELETE"])
        self.assertIn("repos/%s/labels" % OWNED, writes[0])
        pushed = [x for x in writes[1] if x.startswith("ref=")][0][len("ref=refs/heads/"):]
        self.assertIn("repos/%s/git/refs/heads/%s" % (OWNED, pushed), writes[2])
        self.assertEqual(P.serialize(got)["passed"], True)

        closed = GitHub(issues=False)
        got = P.readiness(closed, OWNED, 1000.0)
        self.assertFalse(got.passed)
        self.assertEqual((got.lines[-1].name, got.lines[-1].ok), ("issues", False))
        self.assertEqual(closed.writes(), [])

        stranger = GitHub()
        got = P.readiness(stranger, "someone/else", 1000.0)
        self.assertEqual([(x.name, x.ok) for x in got.lines], [("owner", False)])
        self.assertEqual(stranger.calls, [])


class Probe(unittest.TestCase):
    def tree(self):
        return sorted((p, tuple(sorted(f)), os.lstat(p).st_mtime_ns) for p, _, f in os.walk(self.top))

    def clone(self, name, url):
        os.makedirs(os.path.join(self.root, name, ".git"))
        with open(os.path.join(self.root, name, ".git", "config"), "w") as f:
            f.write('[core]\n\tbare = false\n[remote "origin"]\n\turl = %s\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' % url)

    def test_a_host_folder_is_accepted_only_inside_the_root_as_a_git_checkout_with_a_github_origin(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.top = tmp.name
        self.root = os.path.join(self.top, "projects")
        outside = os.path.join(self.top, "outside")
        os.makedirs(os.path.join(outside, ".git"))
        with open(os.path.join(outside, ".git", "config"), "w") as f:
            f.write('[remote "origin"]\n\turl = https://github.com/special-place-ai-heaven/secret.git\n')
        self.clone("app", "https://x-access-token:s3cr3t@github.com/special-place-ai-heaven/app.git")
        self.clone("ssh", "git@github.com:special-place-ai-heaven/tool.git")
        self.clone("lab", "https://gitlab.com/someone/thing.git")
        os.makedirs(os.path.join(self.root, "plain"))
        os.symlink(outside, os.path.join(self.root, "link"))
        os.makedirs(os.path.join(self.root, "dotlink"))
        os.symlink(os.path.join(outside, ".git"), os.path.join(self.root, "dotlink", ".git"))
        before = self.tree()
        got = {p: P.probe(p, self.root) for p in ("app", os.path.join(self.root, "ssh"), "lab", "plain", "missing", "../outside", outside, "link", "dotlink", "", "a\0b")}
        self.assertEqual(self.tree(), before)
        self.assertEqual((got["app"].ok, got["app"].repo, got["app"].path), (True, "special-place-ai-heaven/app", os.path.join(os.path.realpath(self.root), "app")))
        self.assertEqual(got[os.path.join(self.root, "ssh")].repo, "special-place-ai-heaven/tool")
        codes = {p: g.code for p, g in got.items() if not g.ok}
        self.assertEqual(codes, {"lab": "no_github_remote", "plain": "not_git", "missing": "not_found", "../outside": "outside_root",
                                 outside: "outside_root", "link": "outside_root", "dotlink": "not_git", "": "bad_path", "a\0b": "bad_path"})
        self.assertEqual(got["missing"].message, "path not found on the factory host")
        self.assertEqual(got["plain"].message, "not a git repository")
        self.assertEqual(got["lab"].message, "needs a GitHub remote")
        self.assertNotIn("s3cr3t", json.dumps([P.serialize(g) for g in got.values()]))
        self.assertEqual(P.probe("app", None).code, "no_root")


class Accessible(unittest.TestCase):
    def test_the_list_is_every_repository_the_factory_credential_reaches(self):
        names = ["special-place-ai-heaven/b", "special-place-ai-heaven/a", "someone/c"]
        app = GitHub(repos=names)
        self.assertEqual(P.accessible(app), ["special-place-ai-heaven/a", "special-place-ai-heaven/b"])
        self.assertTrue(all(c[:2] == ["api", "--paginate"] for c in app.calls))
        token = GitHub(repos=names, app=False)
        self.assertEqual(P.accessible(token), ["special-place-ai-heaven/a", "special-place-ai-heaven/b"])
        self.assertEqual(token.writes(), [])


class Hardening(unittest.TestCase):
    def test_repo_names_dot_and_dot_dot_are_refused(self):
        for bad in ("special-place-ai-heaven/..", "special-place-ai-heaven/."):
            self.assertIsNone(P.REPO.match(bad))
            gh = GitHub()
            self.assertEqual([(x.name, x.ok) for x in P.readiness(gh, bad, 1000.0).lines], [("owner", False)])
            self.assertEqual(gh.calls, [])
        self.assertTrue(P.REPO.match("special-place-ai-heaven/.github"))

    def test_the_fallback_list_names_only_repositories_of_the_allowed_owners(self):
        names = ["special-place-ai-heaven/a", "someone-else/private-x", "special-place-administrator/b"]
        for app in (True, False):
            self.assertEqual(P.accessible(GitHub(repos=names, app=app)), ["special-place-administrator/b", "special-place-ai-heaven/a"])
        self.assertEqual(P.accessible(GitHub(repos=names, app=False), owners=("someone-else",)), ["someone-else/private-x"])

    def test_the_whole_disk_or_the_home_folder_is_never_a_project_root(self):
        home = os.path.expanduser("~")
        for root in ("/", home, home + "/", "//"):
            self.assertEqual(P.probe("x", root).code, "bad_root")

    def test_a_config_swapped_for_a_symlink_after_the_check_is_not_followed(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root, outside = os.path.join(tmp.name, "root"), os.path.join(tmp.name, "outside")
        os.makedirs(os.path.join(root, "race", ".git"))
        os.makedirs(outside)
        with open(os.path.join(outside, "config"), "w") as f:
            f.write('[remote "origin"]\n\turl = https://github.com/attacker/outside.git\n')
        config = os.path.join(root, "race", ".git", "config")
        with open(config, "w") as f:
            f.write('[remote "origin"]\n\turl = https://github.com/special-place-ai-heaven/inside.git\n')
        real = os.path.isfile

        def swap(path):
            ok = real(path)
            if path == os.path.realpath(config) and not os.path.islink(config):
                os.remove(config)
                os.symlink(os.path.join(outside, "config"), config)
            return ok

        with unittest.mock.patch.object(P.os.path, "isfile", swap):
            got = P.probe("race", root)
        self.assertNotEqual(got.repo, "attacker/outside")
        self.assertEqual(got.code, "not_git")


if __name__ == "__main__":
    unittest.main()
