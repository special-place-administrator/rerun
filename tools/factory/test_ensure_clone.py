import contextlib, io, os, sys, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import factory as F
import mirror
from test_factory import FactoryCase, FULL, git, write


class EnsureCloneFollowsBase(FactoryCase):
    def setUp(self):
        super().setUp()
        p = mock.patch.object(mirror, "GITHUB", "file://" + self.tmp + "/")
        p.start()
        self.addCleanup(p.stop)

    def push_from_second_clone(self, branch, name, text):
        other = self.make_clone("other")
        git(other, "checkout", "--quiet", "-B", branch, "origin/" + branch)
        write(other, name, text)
        git(other, "add", "-A")
        git(other, "commit", "--quiet", "-m", "add " + name)
        git(other, "push", "--quiet", "origin", "HEAD:refs/heads/" + branch)
        return git(other, "rev-parse", "HEAD")

    def ensure(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            F.ensure_clone(FULL)
        return err.getvalue()

    def test_checkout_moves_to_origin_dev_after_fetch(self):
        sha = self.push_from_second_clone("dev", "new.txt", "new\n")
        self.ensure()
        self.assertEqual(git(self.clone, "rev-parse", "HEAD"), sha)
        self.assertTrue(os.path.isfile(os.path.join(self.clone, "new.txt")))

    def test_without_dev_follows_origin_head(self):
        git(self.clone, "push", "--quiet", self.origin, "refs/remotes/origin/dev:refs/heads/main")
        git(self.clone, "fetch", "--quiet", "origin")
        git(self.clone, "remote", "set-head", "origin", "main")
        git(self.clone, "push", "--quiet", self.origin, ":refs/heads/dev")
        sha = self.push_from_second_clone("main", "m.txt", "m\n")
        self.ensure()
        self.assertEqual(git(self.clone, "rev-parse", "HEAD"), sha)
        self.assertTrue(os.path.isfile(os.path.join(self.clone, "m.txt")))

    def test_tracked_change_is_left_alone(self):
        git(self.clone, "checkout", "--quiet", "--detach", "origin/dev")
        before = git(self.clone, "rev-parse", "HEAD")
        self.push_from_second_clone("dev", "new.txt", "new\n")
        write(self.clone, "README.md", "edited\n")
        err = self.ensure()
        self.assertEqual(git(self.clone, "rev-parse", "HEAD"), before)
        with open(os.path.join(self.clone, "README.md")) as f:
            self.assertEqual(f.read(), "edited\n")
        self.assertIn("has local changes", err)

    def test_untracked_index_does_not_block(self):
        sha = self.push_from_second_clone("dev", "new.txt", "new\n")
        os.makedirs(os.path.join(self.clone, ".symforge"))
        write(self.clone, ".symforge/index.bin", "idx")
        self.ensure()
        self.assertEqual(git(self.clone, "rev-parse", "HEAD"), sha)
        self.assertTrue(os.path.isfile(os.path.join(self.clone, ".symforge", "index.bin")))


class SharedCheckoutErrorsStayLocal(FactoryCase):
    def test_a_failed_shared_clone_prints_only_its_code_and_logs_the_scrubbed_text(self):
        fake = os.path.join(self.tmp, "fake-git")
        with open(fake, "w") as f:
            f.write("#!/bin/sh\necho \"fatal: unable to access 'https://x-access-token:ghs_%s@github.com/special-place-ai-heaven/other.git/': "
                    "The requested URL returned error: 403\" >&2\nexit 128\n" % ("A" * 36))
        os.chmod(fake, 0o755)
        F.GIT = fake
        code, out = self.call(lambda _: F.ensure_clone("special-place-ai-heaven/other"), [])
        self.assertEqual(code, 1, out)
        self.assertIn("not_reachable", out)
        for raw in ("ghs_", "x-access-token", "github.com"):
            self.assertNotIn(raw, out)
        log = os.path.join(F.STATE, "git-errors.log")
        self.assertEqual(os.stat(log).st_mode & 0o777, 0o600)
        with open(log) as f:
            text = f.read()
        self.assertIn("403", text)
        self.assertNotIn("ghs_", text)


if __name__ == "__main__":
    unittest.main()
