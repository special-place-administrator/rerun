import hashlib
import os
import re
import secrets
import shutil
import stat
import tarfile
import unicodedata

import projects

SENSITIVE_PATHS = (
    ("Secrets folder", re.compile(r"(^|/)\.(secrets|ssh|aws|gnupg)(/|$)")),
    ("Env file", re.compile(r"(^|/)\.env(\.|$)")),
    ("Credential file", re.compile(r"(^|/)([^/]*[-_.])?(cookies?|credentials?|passwords?|client[-_]secrets?|service[-_]accounts?)(([-_.][^/]*)?\.(json|ya?ml|txt|csv|ini|toml|xml|cfg|conf|properties))?$", re.I)),
    ("Private key file", re.compile(r"\.(pem|p12|pfx|key)$|(^|/)id_(rsa|ed25519|ecdsa)$")),
)
DROPPED_MAX = 50
DROPPED_PATH_MAX = 300
SEGMENT_MAX = 255
GIT_CAPTURE = {".git/config": 64 * 1024, ".git/HEAD": 256, ".git/packed-refs": 1024 * 1024}
HEAD_REFS = ".git/refs/heads/"
REF_MAX = 100
SPECIAL_BITS = stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX
WRITTEN_TYPES = (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)
CHUNK = 1024 * 1024
COMMIT = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")


class Refused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def sensitive_labels(path):
    return [label for label, rx in SENSITIVE_PATHS if rx.search(path)]


def segments(name, max_depth):
    if not name or "\\" in name or any(unicodedata.category(c) == "Cc" for c in name):
        raise Refused("unsafe_entry")
    parts = name.split("/")
    try:
        too_long = any(len(p.encode("utf-8")) > SEGMENT_MAX for p in parts)
    except UnicodeEncodeError:
        raise Refused("unsafe_entry") from None
    if too_long or len(parts) > max_depth or any(p in ("", ".", "..") for p in parts):
        raise Refused("unsafe_entry")
    return parts


def claim(parts, is_dir, seen, dirs, files):
    keys = [unicodedata.normalize("NFC", "/".join(parts[:i + 1])).casefold() for i in range(len(parts))]
    key = keys[-1]
    if key in seen or any(k in files for k in keys[:-1]) or (not is_dir and key in dirs):
        raise Refused("unsafe_entry")
    seen.add(key)
    dirs.update(keys[:-1])
    (dirs if is_dir else files).add(key)


def dir_fd(root_fd, parts):
    fd = os.dup(root_fd)
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            inner = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = inner
    except BaseException:
        os.close(fd)
        raise
    return fd


def write(tf, member, parts, root_fd):
    parent = dir_fd(root_fd, parts[:-1])
    try:
        out = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    finally:
        os.close(parent)
    os.fchmod(out, 0o755 if member.mode & stat.S_IXUSR else 0o644)
    with os.fdopen(out, "wb") as f, tf.extractfile(member) as src:
        left = member.size
        while left:
            chunk = src.read(min(CHUNK, left))
            if not chunk:
                raise Refused("unsafe_entry")
            f.write(chunk)
            left -= len(chunk)


def place(tf, member, parts, root_fd, git, dropped):
    path = "/".join(parts)
    if any(p.casefold() == ".git" for p in parts):
        if parts[0] == ".git" and len(parts) == 1 and not member.isdir():
            raise Refused("no_github_remote")
        cap = GIT_CAPTURE.get(path, REF_MAX if path.startswith(HEAD_REFS) else 0)
        if parts[0] == ".git" and not member.isdir() and member.size <= cap:
            git[path] = tf.extractfile(member).read(cap)
        return
    labels = sensitive_labels(path)
    if labels:
        if not member.isdir() and len(dropped) < DROPPED_MAX:
            dropped.append({"label": labels[0], "path": path[:DROPPED_PATH_MAX]})
        return
    if member.isdir():
        os.close(dir_fd(root_fd, parts))
    else:
        write(tf, member, parts, root_fd)


def walk(tar_path, root, lim):
    file_max = lim["upload_max_file_mb"] * projects.MB
    total_max = min(lim["upload_max_mb"], lim["max_project_mb"]) * projects.MB
    seen, dirs, files, git, dropped = set(), set(), set(), {}, []
    count = total = 0
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with tarfile.open(tar_path, mode="r:", encoding="utf-8", errors="surrogateescape") as tf:
            while (member := tf.next()) is not None:
                count += 1
                if count > lim["upload_max_files"]:
                    raise Refused("too_many_files")
                parts = segments(member.name, lim["upload_max_depth"])
                if member.issparse() or member.type not in WRITTEN_TYPES or member.mode & SPECIAL_BITS:
                    raise Refused("unsafe_entry")
                total += member.size
                if member.size > file_max or total > total_max:
                    raise Refused("upload_too_large")
                claim(parts, member.isdir(), seen, dirs, files)
                place(tf, member, parts, root_fd, git, dropped)
    except (tarfile.TarError, EOFError, ValueError, UnicodeError):
        raise Refused("unsafe_entry") from None
    finally:
        os.close(root_fd)
    return git, dropped


def identify(config, owners):
    m = projects.GITHUB_ORIGIN.match(projects._origin((config or b"").decode("utf-8", "replace")) or "")
    if not m:
        return None
    owner, _, name = m.group(1).partition("/")
    listed = next((o for o in owners if o.lower() == owner.lower()), None)
    repo = "%s/%s" % (listed, name)
    return repo if listed and projects.safe_repo(repo) else None


def head(git):
    text = git.get(".git/HEAD", b"").decode("ascii", "replace").strip()
    if COMMIT.fullmatch(text):
        return text
    ref = text[len("ref: "):] if text.startswith("ref: refs/heads/") else None
    if ref is None:
        return None
    loose = git.get(".git/" + ref, b"").decode("ascii", "replace").strip()
    if COMMIT.fullmatch(loose):
        return loose
    for line in git.get(".git/packed-refs", b"").decode("ascii", "replace").splitlines():
        sha, _, name = line.partition(" ")
        if name.strip() == ref and COMMIT.fullmatch(sha):
            return sha
    return None


def unpack(tar_path, d, lim, owners):
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = os.path.join(d, "tmp-" + secrets.token_hex(8))
    os.mkdir(tmp, 0o700)
    try:
        git, dropped = walk(tar_path, tmp, lim)
        repo = identify(git.get(".git/config"), owners)
        if repo is None:
            raise Refused("no_github_remote")
        src = os.path.join(d, "src")
        if os.path.lexists(src):
            shutil.rmtree(src)
        os.rename(tmp, src)
        return {"ok": True, "repo": repo, "head": head(git), "dropped": dropped}
    except Refused as e:
        return {"ok": False, "code": e.code}
    except Exception:
        return {"ok": False, "code": "unknown"}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def fetch(open_archive, pid, path, size, sha256, limit):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    digest, got = hashlib.sha256(), 0
    with os.fdopen(fd, "wb") as out, open_archive(pid) as answer:
        while chunk := answer.read(CHUNK):
            got += len(chunk)
            if got > min(size, limit):
                return "upload_too_large"
            digest.update(chunk)
            out.write(chunk)
    return None if got == size and digest.hexdigest() == sha256 else "checksum_mismatch"


def receive(open_archive, pid, d, size, sha256, lim, owners):
    incoming = os.path.join(d, "incoming")
    try:
        os.makedirs(d, mode=0o700, exist_ok=True)
        shutil.rmtree(incoming, ignore_errors=True)
        os.mkdir(incoming, 0o700)
        archive = os.path.join(incoming, "archive.tar")
        code = fetch(open_archive, pid, archive, size, sha256, lim["upload_max_mb"] * projects.MB)
        return {"ok": False, "code": code} if code else unpack(archive, d, lim, owners)
    except Exception:
        return {"ok": False, "code": "unknown"}
    finally:
        shutil.rmtree(incoming, ignore_errors=True)
