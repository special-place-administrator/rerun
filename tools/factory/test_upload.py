import io
import os
import re
import tarfile
import tempfile
import unittest

import upload as U

OWNERS = ("special-place-ai-heaven",)
LIMITS = {"max_count": 10, "max_project_mb": 5, "max_total_mb": 50, "upload_max_mb": 5,
          "upload_max_files": 40, "upload_max_depth": 32, "upload_max_file_mb": 1}
ORIGIN = b'[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/special-place-ai-heaven/moldwright.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"
SECRETS_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "contracts", "src", "secrets.ts")


def entry(name, data=b"", kind=tarfile.REGTYPE, mode=0o644, pax=None):
    info = tarfile.TarInfo(name)
    info.type, info.mode = kind, mode
    if pax:
        info.pax_headers = pax
    if kind == tarfile.REGTYPE:
        info.size = len(data)
    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
        info.linkname = "README.md"
    return info, data


def folder(name):
    return entry(name, kind=tarfile.DIRTYPE, mode=0o755)


class Walker(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.d = os.path.join(tmp, "projects", "1", "7")
        os.makedirs(self.d)
        self.tar = os.path.join(tmp, "upload.tar")

    def pack(self, entries, fmt=tarfile.PAX_FORMAT):
        with tarfile.open(self.tar, "w", format=fmt) as tf:
            for info, data in entries:
                tf.addfile(info, io.BytesIO(data) if info.type == tarfile.REGTYPE else None)
        return self.tar

    def walk(self, entries, limits=LIMITS, fmt=tarfile.PAX_FORMAT):
        return U.unpack(self.pack(entries, fmt), self.d, limits, OWNERS)

    def refused(self, entries, code, limits=LIMITS, fmt=tarfile.PAX_FORMAT):
        got = self.walk([entry("ok.txt", b"written first")] + entries, limits, fmt)
        self.assertEqual(got, {"ok": False, "code": code})
        self.assertEqual(os.listdir(self.d), [])

    def test_names_that_leave_the_folder_or_hide_a_separator_are_refused_and_nothing_is_left(self):
        for name in ("/etc/x", "../x", "a/../../x", "a\\b", "a/./b", "a//b", "a\x01b", "x" * 256):
            with self.subTest(name=name):
                self.refused([entry(name, b"x")], "unsafe_entry")

    def test_links_devices_fifos_and_special_bits_are_refused(self):
        for info in (entry("link", kind=tarfile.SYMTYPE), entry("hard", kind=tarfile.LNKTYPE), entry("pipe", kind=tarfile.FIFOTYPE),
                     entry("tty", kind=tarfile.CHRTYPE), entry("disk", kind=tarfile.BLKTYPE), entry("run.sh", b"#!/bin/sh\n", mode=0o4755),
                     entry("group.sh", b"#!/bin/sh\n", mode=0o2755), entry("sticky", kind=tarfile.DIRTYPE, mode=0o1777)):
            with self.subTest(name=info[0].name):
                self.refused([info], "unsafe_entry")

    def test_sparse_members_are_refused(self):
        pax_sparse = entry("holes.bin", b"x", pax={"GNU.sparse.size": "1073741824", "GNU.sparse.map": "0,1"})
        self.pack([pax_sparse])
        with tarfile.open(self.tar, "r:") as tf:
            self.assertTrue(tf.next().issparse())
        self.refused([pax_sparse], "unsafe_entry")
        self.refused([entry("gnu.bin", kind=tarfile.GNUTYPE_SPARSE)], "unsafe_entry", fmt=tarfile.GNU_FORMAT)

    def test_the_effective_name_of_pax_and_gnu_long_names_is_checked(self):
        evil = entry("safe.txt", b"x", pax={"path": "../evil"})
        self.pack([evil])
        with tarfile.open(self.tar, "r:") as tf:
            self.assertEqual(tf.next().name, "../evil")
        self.refused([evil], "unsafe_entry")
        deep = "/".join(["d"] * 40 + ["f.txt"])
        self.refused([entry(deep, b"x")], "unsafe_entry", fmt=tarfile.GNU_FORMAT)

    def test_duplicates_by_case_or_unicode_form_and_a_file_used_as_a_folder_are_refused(self):
        for pair in (("a/B", "a/b"), ("café.txt", "café.txt"), ("a/x", "a/x"), ("lib", "lib/x.js"), ("lib/x.js", "lib")):
            with self.subTest(pair=pair):
                self.refused([entry(pair[0], b"1"), entry(pair[1], b"2")], "unsafe_entry")

    def test_a_file_over_the_file_limit_and_more_entries_than_allowed_are_refused(self):
        self.refused([entry("big.bin", b"x" * (1024 * 1024 + 1))], "upload_too_large")
        self.refused([entry("f%d" % i, b"x") for i in range(3)], "too_many_files", limits=dict(LIMITS, upload_max_files=3))
        self.refused([entry("f%d" % i, b"x" * 600_000) for i in range(3)], "upload_too_large", limits=dict(LIMITS, upload_max_mb=1))
        self.refused([entry("f%d" % i, b"x" * 600_000) for i in range(3)], "upload_too_large", limits=dict(LIMITS, max_project_mb=1))

    def test_a_compressed_or_broken_archive_is_refused(self):
        with open(self.tar, "wb") as f:
            f.write(b"\x1f\x8b\x08\x00" + b"\x00" * 600)
        self.assertEqual(U.unpack(self.tar, self.d, LIMITS, OWNERS), {"ok": False, "code": "unsafe_entry"})
        self.assertEqual(os.listdir(self.d), [])

    def test_a_tree_with_a_github_origin_is_identified_written_without_git_and_its_secrets_dropped(self):
        got = self.walk([
            folder(".git"), entry(".git/config", ORIGIN), entry(".git/HEAD", b"ref: refs/heads/dev\n"),
            entry(".git/refs/heads/dev", HEAD_SHA.encode() + b"\n"), entry(".git/hooks/pre-commit", b"#!/bin/sh\nexit 1\n", mode=0o755),
            entry("README.md", b"# app\n"), entry("app/main.py", b"print(1)\n"), entry(".env", b"KEY=1\n"), entry(".env.example", b"KEY=\n"),
            entry("id_rsa", b"-----\n"), entry("vendor/lib/.git/config", ORIGIN), entry("vendor/lib/x.js", b"1\n"),
        ])
        self.assertEqual(got, {"ok": True, "repo": "special-place-ai-heaven/moldwright", "head": HEAD_SHA, "dropped": [
            {"label": "Env file", "path": ".env"}, {"label": "Env file", "path": ".env.example"}, {"label": "Private key file", "path": "id_rsa"}]})
        self.assertEqual(os.listdir(self.d), ["src"])
        src = os.path.join(self.d, "src")
        written = sorted(os.path.relpath(os.path.join(top, n), src) for top, dirs, files in os.walk(src) for n in files + dirs)
        self.assertEqual(written, ["README.md", "app", "app/main.py", "vendor", "vendor/lib", "vendor/lib/x.js"])
        with open(os.path.join(src, "app", "main.py"), "rb") as f:
            self.assertEqual(f.read(), b"print(1)\n")

    def test_the_head_is_read_from_packed_refs_and_an_unknown_branch_gives_no_head(self):
        packed = ("# pack-refs with: peeled\n%s refs/heads/main\n" % HEAD_SHA).encode()
        got = self.walk([entry(".git/HEAD", b"ref: refs/heads/main\n"), entry(".git/config", ORIGIN), entry(".git/packed-refs", packed), entry("a.txt", b"1")])
        self.assertEqual((got["ok"], got["head"]), (True, HEAD_SHA))
        got = self.walk([entry(".git/config", ORIGIN), entry(".git/HEAD", b"ref: refs/heads/gone\n"), entry("b.txt", b"1")])
        self.assertEqual((got["ok"], got["head"]), (True, None))
        self.assertEqual(os.listdir(os.path.join(self.d, "src")), ["b.txt"])

    def test_no_github_origin_of_an_allowed_owner_is_refused(self):
        other = ORIGIN.replace(b"https://github.com/", b"https://gitlab.com/")
        stranger = ORIGIN.replace(b"special-place-ai-heaven", b"someone-else")
        for entries in ([entry(".git/config", other)], [entry(".git/config", stranger)], [entry("a.txt", b"1")], [entry(".git", b"gitdir: /data/work/repos/x/.git\n")]):
            with self.subTest(entries=[e[0].name for e in entries]):
                self.refused(entries, "no_github_remote")


class SensitivePaths(unittest.TestCase):
    def test_the_patterns_and_labels_are_the_same_as_the_contracts(self):
        with open(SECRETS_TS, encoding="utf-8") as f:
            block = f.read().split("SENSITIVE_PATH_PATTERNS")[1].split("\n]\n")[0]
        hub = [(label, re.compile(src, re.I if "i" in flags else 0)) for label, src, flags in re.findall(r"\{ label: '([^']+)', re: /(.+?)/([a-z]*) \}", block)]
        self.assertEqual([label for label, _ in hub], [label for label, _ in U.SENSITIVE_PATHS])
        for path in (".env", ".env.example", "app/.env.local", "environment.ts", ".ssh/id_ed25519", "a/.aws/config", "certs/server.pem",
                     "keys/app.key", "keyboard.ts", "id_rsa", "id_rsa.pub", "config/credentials.yml", "src/Password.tsx", "client_secret.json",
                     "service-account.json", "README.md", ".secrets", "docs/.gnupg/x", "cookies.txt", "a.p12"):
            with self.subTest(path=path):
                self.assertEqual(U.sensitive_labels(path), [label for label, rx in hub if rx.search(path)])


if __name__ == "__main__":
    unittest.main()
