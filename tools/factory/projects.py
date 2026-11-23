import dataclasses
import datetime
import json
import os
import re
import stat

import factory

REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$")
READINESS_LINES = ("owner", "read", "issues", "base", "proof", "label", "push")
PROOF_CHECK = "Done-test red before green"
PROBE_MESSAGES = {
    "bad_path": "the path is empty or not a plain path",
    "no_root": "the factory has no folder set for host projects",
    "bad_root": "the factory's folder for host projects may not be the whole disk or a home folder",
    "outside_root": "the path is outside the folder the factory may read",
    "not_found": "path not found on the factory host",
    "not_git": "not a git repository",
    "no_github_remote": "needs a GitHub remote",
}
GITHUB_ORIGIN = re.compile(r"^(?:https://(?:[^@/\s]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)([^/\s]+/[^/\s]+?)(?:\.git)?/?$")
CONFIG_MAX_BYTES = 64 * 1024
REPOS_MAX = 300


@dataclasses.dataclass(frozen=True)
class Line:
    name: str
    ok: bool
    why: str = ""


@dataclasses.dataclass(frozen=True)
class Readiness:
    repo: str
    passed: bool
    lines: tuple
    at: str


@dataclasses.dataclass(frozen=True)
class Probe:
    path: str
    ok: bool
    code: str = ""
    message: str = ""
    repo: str = ""


def serialize(item):
    return dataclasses.asdict(item)


def report(repos, ready, probes):
    return {"repos": list(repos)[:REPOS_MAX], "ready": [serialize(r) for r in ready], "probes": [serialize(p) for p in probes]}


def stamp(now):
    return datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def readiness(gh, repo, now, base="dev", owners=factory.OWNERS):
    lines = []

    def done(name, ok, why=""):
        lines.append(Line(name, ok, why))
        return ok

    def result():
        return Readiness(repo, all(x.ok for x in lines) and len(lines) == len(READINESS_LINES), tuple(lines), stamp(now))

    if not (isinstance(repo, str) and REPO.match(repo) and repo.split("/")[0] in owners):
        done("owner", False, "the factory works only on repositories of %s" % ", ".join(owners))
        return result()
    done("owner", True)
    try:
        info = json.loads(gh(["api", "repos/%s" % repo]))
    except Exception:
        done("read", False, "the repository cannot be read with the factory's GitHub credential")
        return result()
    if not done("read", isinstance(info, dict), "" if isinstance(info, dict) else "the repository answer is not understood"):
        return result()
    if not done("issues", info.get("has_issues") is True, "" if info.get("has_issues") is True else "issues are turned off"):
        return result()
    try:
        sha = gh(["api", "repos/%s/branches/%s" % (repo, base), "--jq", ".commit.sha"]).strip()
    except Exception:
        sha = ""
    if not done("base", bool(re.fullmatch(r"[0-9a-f]{6,40}", sha)), "" if sha else "the base branch %s is missing" % base):
        return result()
    try:
        names = [n.strip() for n in gh(["api", "repos/%s/actions/workflows" % repo, "--jq", ".workflows[].name"]).splitlines()]
    except Exception:
        names = []
    if not done("proof", PROOF_CHECK in names, "" if PROOF_CHECK in names else "the check '%s' is missing" % PROOF_CHECK):
        return result()
    try:
        gh(["api", "repos/%s/labels/factory" % repo, "--jq", ".name"])
        done("label", True)
    except Exception as e:
        if "404" not in str(e) and "Not Found" not in str(e):
            done("label", False, "the factory label cannot be read")
            return result()
        try:
            gh(["api", "-X", "POST", "repos/%s/labels" % repo, "-f", "name=factory", "-f", "color=5319e7"])
            done("label", True, "created")
        except Exception:
            done("label", False, "the factory label is missing and cannot be created")
            return result()
    branch = "factory-ready-%d" % int(now)
    try:
        gh(["api", "-X", "POST", "repos/%s/git/refs" % repo, "-f", "ref=refs/heads/" + branch, "-f", "sha=" + sha])
    except Exception:
        done("push", False, "a branch cannot be pushed with the factory's GitHub credential")
        return result()
    try:
        gh(["api", "-X", "DELETE", "repos/%s/git/refs/heads/%s" % (repo, branch)])
    except Exception:
        done("push", False, "the branch %s was pushed but cannot be removed" % branch)
        return result()
    done("push", True)
    return result()


def _inside(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _read_inside(config, target):
    try:
        fd = os.open(config, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or not _inside(os.path.realpath("/proc/self/fd/%d" % fd), target):
            return None
        with os.fdopen(fd, encoding="utf-8", errors="replace") as f:
            fd = None
            return f.read(CONFIG_MAX_BYTES)
    except OSError:
        return None
    finally:
        if fd is not None:
            os.close(fd)


def _origin(text):
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("["):
            section = re.sub(r"\s+", " ", line.strip("[]").strip())
            continue
        if section == 'remote "origin"' and re.match(r"url\s*=", line):
            return line.split("=", 1)[1].strip()
    return None


def probe(path, root):
    shown = path[:300] if isinstance(path, str) else ""
    if not isinstance(path, str) or not path.strip() or "\0" in path or len(path) > 4096:
        return Probe(shown.replace("\0", ""), False, "bad_path", PROBE_MESSAGES["bad_path"])
    if not root:
        return Probe(shown, False, "no_root", PROBE_MESSAGES["no_root"])
    base = os.path.realpath(root)
    if base in ("/", os.path.realpath(os.path.expanduser("~")), os.path.realpath(os.environ.get("HOME") or "/")):
        return Probe(shown, False, "bad_root", PROBE_MESSAGES["bad_root"])
    target = os.path.realpath(os.path.join(base, path))
    if not _inside(target, base):
        return Probe(shown, False, "outside_root", PROBE_MESSAGES["outside_root"])
    if not os.path.isdir(target):
        return Probe(shown, False, "not_found", PROBE_MESSAGES["not_found"])
    git = os.path.join(target, ".git")
    config = os.path.realpath(os.path.join(git, "config"))
    if os.path.islink(git) or not os.path.isdir(git) or not _inside(config, target) or not os.path.isfile(config):
        return Probe(target, False, "not_git", PROBE_MESSAGES["not_git"])
    text = _read_inside(config, target)
    if text is None:
        return Probe(target, False, "not_git", PROBE_MESSAGES["not_git"])
    m = GITHUB_ORIGIN.match(_origin(text) or "")
    if not m or not REPO.match(m.group(1)):
        return Probe(target, False, "no_github_remote", PROBE_MESSAGES["no_github_remote"])
    return Probe(target, True, repo=m.group(1))


def accessible(gh, owners=factory.OWNERS):
    try:
        out = gh(["api", "--paginate", "installation/repositories", "--jq", ".repositories[].full_name"])
    except Exception:
        out = gh(["api", "--paginate", "user/repos?per_page=100", "--jq", ".[].full_name"])
    return sorted({n.strip() for n in out.splitlines() if REPO.match(n.strip()) and n.strip().split("/")[0] in owners})[:REPOS_MAX]
