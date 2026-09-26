#!/usr/bin/env python3
# inaya-nas-agent.py -- the appliance-side half of Inaya Sovereign NAS.
#
# Runs as root ON the Linux appliance. The Inaya control plane never builds a
# shell string: it writes one JSON request file, runs
#     python3 /usr/local/sbin/inaya-nas-agent.py <request.json>
# and reads one JSON response from stdout. Every name/path/CIDR is validated
# here, every external command is an argv list (no shell=True anywhere), and
# every path that reaches the filesystem must resolve inside the NAS root.
# This is SOW Section 37's "strict argument arrays and validation".
#
# Nothing here fakes a capability: every operation drives real Linux
# primitives (Samba, nfsd, mdadm RAID1, Btrfs, chattr immutability, POSIX
# ACLs, ext4 user quotas, pdbedit lockout). Where a primitive is unavailable
# the op returns {"supported": false, "reason": ...} instead of a fabricated
# value, and metrics carry a MEASURED/DERIVED/ESTIMATED/UNKNOWN label.

import collections
import hashlib
import ipaddress
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

AGENT_VERSION = "2.0.0"
NAS_ROOT = "/srv/inaya-nas"
STATE_DIR = "/var/lib/inaya-nas"
REGISTRY = STATE_DIR + "/registry.json"
SMB_DIR = "/etc/samba/shares.d"
SMB_CONF = "/etc/samba/smb.conf"
SMB_SHARES_INCLUDE = "/etc/samba/inaya-shares.conf"
SMB_GLOBAL_INCLUDE = "/etc/samba/inaya-global.conf"
GLOBAL_DEFAULT = "# managed by inaya-nas-agent\n   log level = 1 auth:2\n"
EXPORTS_DIR = "/etc/exports.d"
POOLS_ROOT = NAS_ROOT + "/.pools"
SNAP_ROOT = NAS_ROOT + "/.snapshots"
REPLICA_ROOT = NAS_ROOT + "/.replicas"
VOLUMES_DIR = STATE_DIR + "/volumes"
POOL_IMG_DIR = STATE_DIR + "/pools"
SCAN_DIR = STATE_DIR + "/scan"
WORM_DIR = STATE_DIR + "/worm"

NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
SNAP_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
USER_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
HOST_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,60}[a-zA-Z0-9])?$")
TEMP_RE = re.compile(r"^/mnt/[a-z]/.*inaya-nas-[0-9a-f-]{8,}\.(bin|json|txt)$")


class AgentError(Exception):
    def __init__(self, message, code="ERROR"):
        super().__init__(message)
        self.code = code


def run(argv, input=None, timeout=120, check=True):
    """The ONLY way this agent runs a command: an argv list, no shell."""
    try:
        p = subprocess.run(argv, input=input, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AgentError("%s timed out after %ss" % (argv[0], timeout), "TIMEOUT")
    except FileNotFoundError:
        raise AgentError("%s is not installed on this appliance" % argv[0], "MISSING_TOOL")
    if check and p.returncode != 0:
        raise AgentError("%s failed: %s" % (argv[0], (p.stderr or p.stdout).strip()[:600]), "CMD_FAILED")
    return p


def have(tool):
    return shutil.which(tool) is not None


# ---------------------------------------------------------------- validation
def v_name(v, label="name"):
    if not isinstance(v, str) or not NAME_RE.match(v):
        raise AgentError("Invalid %s %r: letters, digits, '-' and '_' only, max 64." % (label, v), "BAD_INPUT")
    return v


def v_snap(v):
    if not isinstance(v, str) or not SNAP_RE.match(v) or v in (".", ".."):
        raise AgentError("Invalid snapshot name %r." % (v,), "BAD_INPUT")
    return v


def v_user(v):
    if not isinstance(v, str) or not USER_RE.match(v):
        raise AgentError("Invalid unix user %r." % (v,), "BAD_INPUT")
    return v


def v_principal(v):
    """A Samba principal: a user or @group."""
    if isinstance(v, str) and v.startswith("@"):
        return "@" + v_name(v[1:], "group")
    return v_user(v)


def v_rel(rel):
    if not isinstance(rel, str) or len(rel) == 0 or len(rel) > 1024 or "\0" in rel:
        raise AgentError("Invalid relative path.", "BAD_INPUT")
    if re.search(r"[\x00-\x1f\x7f]", rel):
        raise AgentError("Control characters are not allowed in a path.", "BAD_INPUT")
    if any(seg == ".." for seg in rel.split("/")):
        raise AgentError("Path traversal rejected: %r" % rel, "TRAVERSAL")
    rel = rel.lstrip("/")
    if rel == "":
        raise AgentError("Invalid relative path.", "BAD_INPUT")
    return rel


def v_client(c):
    """An NFS/SMB client: a CIDR/IP (never a wildcard) or a plain hostname."""
    if not isinstance(c, str) or c.strip() in ("", "*"):
        raise AgentError("Wildcard/empty client rejected (no public exposure).", "PUBLIC_EXPOSURE")
    try:
        net = ipaddress.ip_network(c, strict=False)
    except ValueError:
        if not HOST_RE.match(c):
            raise AgentError("Invalid client %r." % (c,), "BAD_INPUT")
        return c
    if net.prefixlen == 0:
        raise AgentError("A /0 network is public exposure and is rejected.", "PUBLIC_EXPOSURE")
    return str(net)


def is_private_net(c):
    try:
        net = ipaddress.ip_network(c, strict=False)
    except ValueError:
        return False
    return net.is_private or net.is_loopback or net.is_link_local


def within(base, path):
    b = os.path.realpath(base)
    p = os.path.realpath(path)
    return p == b or p.startswith(b + os.sep)


def real_within(base, path):
    if not within(base, path):
        raise AgentError("Path escapes its share (symlink/traversal): %s" % path, "TRAVERSAL")
    return os.path.realpath(path)


def check_temp(path):
    if not isinstance(path, str) or not TEMP_RE.match(path) or ".." in path:
        raise AgentError("Transfer path is not an approved Inaya temp file.", "BAD_INPUT")
    return path


# -------------------------------------------------------------------- state
def load_reg():
    try:
        with open(REGISTRY, "r", encoding="utf8") as f:
            reg = json.load(f)
    except (FileNotFoundError, ValueError):
        reg = {}
    for k in ("pools", "shares", "volumes", "settings"):
        reg.setdefault(k, {})
    return reg


def save_reg(reg):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = REGISTRY + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(reg, f, indent=1, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, REGISTRY)


def share_dir(reg, name):
    s = reg["shares"].get(name)
    return s["path"] if s and s.get("path") else NAS_ROOT + "/" + name


def share_backend(reg, name):
    s = reg["shares"].get(name)
    return (s or {}).get("backend", "dir")


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def is_subvolume(path):
    p = run(["stat", "-f", "-c", "%T", path], check=False)
    if "btrfs" not in p.stdout:
        return False
    return run(["stat", "-c", "%i", path], check=False).stdout.strip() == "256"


# ------------------------------------------------------------------ samba
def testparm_ok():
    p = run(["testparm", "-s"], check=False)
    return p.returncode == 0, (p.stderr or "")[-400:]


def samba_reload():
    p = run(["smbcontrol", "smbd", "reload-config"], check=False)
    if p.returncode != 0:
        run(["service", "smbd", "restart"], check=False)


def ensure_samba_layout():
    """One managed include of a generated file, instead of the per-share
    include lines the first pass appended inside random stanzas."""
    os.makedirs(SMB_DIR, exist_ok=True)
    with open(SMB_CONF, "r", encoding="utf8") as f:
        lines = f.read().split("\n")
    kept = [l for l in lines if not re.match(r"^\s*include\s*=\s*/etc/samba/(shares\.d/|inaya-)", l)]
    out = []
    injected = False
    for l in kept:
        out.append(l)
        if not injected and l.strip().lower() == "[global]":
            out.append("   include = " + SMB_GLOBAL_INCLUDE)
            injected = True
    if not injected:
        out.insert(0, "[global]")
        out.insert(1, "   include = " + SMB_GLOBAL_INCLUDE)
    while out and out[-1].strip() == "":
        out.pop()
    out.append("")
    out.append("include = " + SMB_SHARES_INCLUDE)
    text = "\n".join(out) + "\n"
    if text != "\n".join(lines):
        with open(SMB_CONF, "w", encoding="utf8") as f:
            f.write(text)
    if not os.path.exists(SMB_GLOBAL_INCLUDE):
        with open(SMB_GLOBAL_INCLUDE, "w", encoding="utf8") as f:
            f.write(GLOBAL_DEFAULT)
    write_shares_include()


def write_shares_include():
    names = sorted(n[:-5] for n in os.listdir(SMB_DIR) if n.endswith(".conf")) if os.path.isdir(SMB_DIR) else []
    with open(SMB_SHARES_INCLUDE, "w", encoding="utf8") as f:
        f.write(GLOBAL_DEFAULT)
        for n in names:
            f.write("include = %s/%s.conf\n" % (SMB_DIR, n))


def render_conf(spec, path):
    name = v_name(spec["name"], "share name")
    owner = v_user(spec["owner"]) if spec.get("owner") else None
    principals = lambda key: [v_principal(u) for u in spec.get(key, []) or []]
    valid = principals("validUsers")
    if owner and owner not in valid:
        valid.insert(0, owner)
    read_only = bool(spec.get("readOnly")) or bool(spec.get("lockdown")) or bool(spec.get("worm"))
    lines = [
        "[%s]" % name,
        "   path = %s" % path,
        "   browseable = %s" % ("no" if spec.get("hidden") else "yes"),
        "   read only = %s" % ("yes" if read_only else "no"),
        "   available = %s" % ("no" if (spec.get("enabled") is False) else "yes"),
        "   guest ok = no",
        "   valid users = %s" % " ".join(valid),
        "   create mask = 0664",
        "   directory mask = 0775",
        "   inherit acls = yes",
        "   map acl inherit = yes",
    ]
    read_list = principals("readList")
    write_list = principals("writeList")
    if read_only:
        # Samba's `write list` OVERRIDES `read only`, so on a read-only,
        # locked-down or WORM-frozen share every listed writer would still be
        # able to write. A read-only share therefore never emits a write list:
        # those users are demoted to the read list.
        read_list = sorted(set(read_list + write_list))
        write_list = []
    for opt, vals in (("read list", read_list), ("write list", write_list), ("invalid users", principals("invalidUsers"))):
        if vals:
            lines.append("   %s = %s" % (opt, " ".join(vals)))
    hosts = [v_client(c) for c in spec.get("hostsAllow", []) or []]
    if hosts:
        lines.append("   hosts allow = %s" % " ".join(hosts))
    rec = spec.get("recycle", {}) or {}
    if rec.get("enabled", True):
        lines += [
            "   vfs objects = recycle",
            "   recycle:repository = .recycle/%U",
            "   recycle:keeptree = yes",
            "   recycle:versions = yes",
            "   recycle:touch = yes",
            "   recycle:maxsize = 0",
        ]
    if spec.get("comment"):
        c = re.sub(r"[^A-Za-z0-9 ._-]", "", str(spec["comment"]))[:80]
        lines.append("   comment = %s" % c)
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------- NFS exports
def nfs_reload():
    run(["exportfs", "-ra"], check=False)


# ------------------------------------------------------------------- pools
def loop_attach(img):
    # reuse an existing attachment if present
    p = run(["losetup", "-j", img], check=False)
    m = re.match(r"^(/dev/loop\d+):", p.stdout or "")
    if m:
        return m.group(1)
    return run(["losetup", "-f", "--show", img]).stdout.strip()


def md_dev(pool):
    return "/dev/md/inaya_" + pool


def pool_mount(pool):
    return POOLS_ROOT + "/" + pool


def is_mounted(path):
    with open("/proc/mounts", "r", encoding="utf8") as f:
        return any(l.split()[1] == path for l in f)


def mdstat_detail(pool):
    dev = md_dev(pool)
    p = run(["mdadm", "--detail", dev], check=False)
    if p.returncode != 0:
        return None
    info = {"raw": p.stdout}
    for key, rx in (("state", r"State :\s*(.+)"), ("activeDevices", r"Active Devices :\s*(\d+)"), ("workingDevices", r"Working Devices :\s*(\d+)"), ("failedDevices", r"Failed Devices :\s*(\d+)"), ("spareDevices", r"Spare Devices :\s*(\d+)"), ("raidDevices", r"Raid Devices :\s*(\d+)")):
        m = re.search(rx, p.stdout)
        info[key] = (int(m.group(1)) if m and m.group(1).isdigit() else (m.group(1).strip() if m else None))
    info.pop("raw")
    st = (info.get("state") or "").lower()
    info["degraded"] = "degraded" in st
    info["rebuilding"] = "recovering" in st or "resync" in st
    prog = None
    try:
        with open("/proc/mdstat", "r", encoding="utf8") as f:
            txt = f.read()
        m = re.search(r"(?:recovery|resync)\s*=\s*([0-9.]+)%", txt)
        if m:
            prog = float(m.group(1))
    except OSError:
        pass
    info["rebuildPercent"] = prog
    return info


def op_pool_create(p):
    pool = v_name(p["pool"], "pool")
    level = p.get("level", "single")
    if level not in ("single", "raid1"):
        raise AgentError("level must be single or raid1.", "BAD_INPUT")
    size_mb = int(p.get("memberSizeMb", 512))
    if size_mb < 128 or size_mb > 200000:
        raise AgentError("memberSizeMb must be 128..200000.", "BAD_INPUT")
    reg = load_reg()
    if pool in reg["pools"]:
        raise AgentError("Pool already exists.", "EXISTS")
    for tool in ("mkfs.btrfs", "btrfs") + (("mdadm",) if level == "raid1" else ()):
        if not have(tool):
            raise AgentError("%s is required for this pool level." % tool, "MISSING_TOOL")
    n = 2 if level == "raid1" else 1
    os.makedirs(POOL_IMG_DIR + "/" + pool, exist_ok=True)
    imgs = []
    for i in range(n):
        img = "%s/%s/disk%d.img" % (POOL_IMG_DIR, pool, i)
        with open(img, "wb") as f:
            f.truncate(size_mb * 1024 * 1024)
        imgs.append(img)
    loops = [loop_attach(i) for i in imgs]
    try:
        if level == "raid1":
            run(["mdadm", "--create", md_dev(pool), "--level=1", "--raid-devices=2", "--run", "--metadata=1.2", "--force"] + loops, input="y\n")
            target = md_dev(pool)
        else:
            target = loops[0]
        run(["mkfs.btrfs", "-q", "-f", "-L", "inaya-" + pool, target])
        os.makedirs(pool_mount(pool), exist_ok=True)
        run(["mount", target, pool_mount(pool)])
        run(["btrfs", "quota", "enable", pool_mount(pool)], check=False)
        os.makedirs(pool_mount(pool) + "/.snapshots", exist_ok=True)
    except AgentError:
        for l in loops:
            run(["losetup", "-d", l], check=False)
        raise
    reg["pools"][pool] = {"level": level, "images": imgs, "createdAt": int(time.time()), "memberSizeMb": size_mb}
    save_reg(reg)
    return op_pool_status({"pool": pool})


def op_pool_status(p):
    pool = v_name(p["pool"], "pool")
    reg = load_reg()
    meta = reg["pools"].get(pool)
    if not meta:
        raise AgentError("Pool not found.", "NOT_FOUND")
    mnt = pool_mount(pool)
    mounted = is_mounted(mnt)
    out = {"pool": pool, "level": meta["level"], "mounted": mounted, "mountPath": mnt, "filesystem": "btrfs", "measurement": "MEASURED"}
    out["redundancy"] = "RAID1 (mdadm mirror over 2 virtual disks)" if meta["level"] == "raid1" else "none (single device)"
    if meta["level"] == "raid1":
        d = mdstat_detail(pool)
        out["md"] = d
        out["degraded"] = bool(d and d["degraded"])
        out["rebuilding"] = bool(d and d["rebuilding"])
        out["health"] = "DEGRADED" if out["degraded"] else ("REBUILDING" if out["rebuilding"] else ("ONLINE" if d else "OFFLINE"))
    else:
        out["degraded"] = False
        out["rebuilding"] = False
        out["health"] = "ONLINE" if mounted else "OFFLINE"
    if mounted:
        p2 = run(["df", "-B1", "--output=size,used,avail", mnt], check=False)
        vals = (p2.stdout.strip().split("\n")[-1] or "").split()
        if len(vals) == 3:
            out["capacity"] = {"totalBytes": int(vals[0]), "usedBytes": int(vals[1]), "availBytes": int(vals[2])}
        e = run(["btrfs", "device", "stats", mnt], check=False)
        errs = sum(int(x) for x in re.findall(r"\s(\d+)\s*$", e.stdout, re.M)) if e.returncode == 0 else None
        out["deviceErrorCounters"] = errs
    out["members"] = [{"image": i, "sizeBytes": os.path.getsize(i) if os.path.exists(i) else None} for i in meta["images"]]
    return out


def op_pool_fail_disk(p):
    """Real failure injection on a mirrored pool: mdadm --fail + --remove of
    one member. Used to prove degraded operation and rebuild -- never on a
    pool with only one member."""
    pool = v_name(p["pool"], "pool")
    idx = int(p.get("member", 1))
    reg = load_reg()
    meta = reg["pools"].get(pool)
    if not meta or meta["level"] != "raid1":
        raise AgentError("Only a raid1 pool can lose a member safely.", "BAD_INPUT")
    img = meta["images"][idx]
    loop = loop_attach(img)
    run(["mdadm", md_dev(pool), "--fail", loop])
    run(["mdadm", md_dev(pool), "--remove", loop])
    return op_pool_status({"pool": pool})


def op_pool_replace_disk(p):
    pool = v_name(p["pool"], "pool")
    idx = int(p.get("member", 1))
    reg = load_reg()
    meta = reg["pools"].get(pool)
    if not meta or meta["level"] != "raid1":
        raise AgentError("Only a raid1 pool can rebuild a member.", "BAD_INPUT")
    old = meta["images"][idx]
    old_loop = loop_attach(old)
    if os.path.exists(old):
        os.remove(old)
    run(["losetup", "-d", old_loop], check=False)
    with open(old, "wb") as f:
        f.truncate(meta["memberSizeMb"] * 1024 * 1024)
    new_loop = loop_attach(old)
    run(["mdadm", md_dev(pool), "--add", new_loop])
    if p.get("wait", True):
        run(["mdadm", "--wait", md_dev(pool)], check=False, timeout=600)
    return op_pool_status({"pool": pool})


def op_pool_scrub(p):
    pool = v_name(p["pool"], "pool")
    mnt = pool_mount(pool)
    # btrfs exits non-zero when the scrub FINDS errors; that is a result to
    # report (the whole point of a scrub), not a failure of the operation.
    r = run(["btrfs", "scrub", "start", "-B", "-R", mnt], timeout=900, check=False)
    if r.returncode != 0 and "scrub" not in (r.stdout or ""):
        raise AgentError("btrfs scrub could not run: %s" % (r.stderr or r.stdout).strip()[:300], "CMD_FAILED")

    def num(k):
        m = re.search(k + r":\s*(\d+)", r.stdout)
        return int(m.group(1)) if m else None
    return {"pool": pool, "errorsFound": r.returncode != 0, "dataBytesScrubbed": num("data_bytes_scrubbed"), "csumErrors": num("csum_errors"), "readErrors": num("read_errors"), "uncorrectableErrors": num("uncorrectable_errors"), "correctedErrors": num("corrected_errors"), "measurement": "MEASURED"}


def op_pool_ensure(p):
    reg = load_reg()
    result = {}
    for pool, meta in reg["pools"].items():
        try:
            mnt = pool_mount(pool)
            if is_mounted(mnt):
                result[pool] = "already-mounted"
                continue
            loops = [loop_attach(i) for i in meta["images"] if os.path.exists(i)]
            if meta["level"] == "raid1":
                if not os.path.exists(md_dev(pool)):
                    run(["mdadm", "--assemble", "--run", md_dev(pool)] + loops, check=False)
                target = md_dev(pool)
            else:
                target = loops[0]
            os.makedirs(mnt, exist_ok=True)
            run(["mount", target, mnt])
            result[pool] = "mounted"
        except AgentError as e:
            result[pool] = "error: %s" % e
    for name, vol in reg["volumes"].items():
        try:
            if not is_mounted(vol["path"]):
                os.makedirs(vol["path"], exist_ok=True)
                run(["mount", "-o", "loop,usrquota,grpquota", vol["image"], vol["path"]])
                run(["quotaon", "-u", "-g", vol["path"]], check=False)
                result["volume:" + name] = "mounted"
        except AgentError as e:
            result["volume:" + name] = "error: %s" % e
    return result


def op_pool_destroy(p):
    pool = v_name(p["pool"], "pool")
    reg = load_reg()
    meta = reg["pools"].get(pool)
    if not meta:
        return {"destroyed": False}
    for name, s in list(reg["shares"].items()):
        if s.get("pool") == pool:
            raise AgentError("Pool still holds share %s." % name, "IN_USE")
    mnt = pool_mount(pool)
    if is_mounted(mnt):
        run(["umount", mnt], check=False)
        if is_mounted(mnt):
            run(["umount", "-l", mnt], check=False)
    if meta["level"] == "raid1":
        run(["mdadm", "--stop", md_dev(pool)], check=False)
    for img in meta["images"]:
        for l in (run(["losetup", "-j", img], check=False).stdout or "").split("\n"):
            m = re.match(r"^(/dev/loop\d+):", l)
            if m:
                run(["losetup", "-d", m.group(1)], check=False)
    shutil.rmtree(POOL_IMG_DIR + "/" + pool, ignore_errors=True)
    try:
        os.rmdir(mnt)
    except OSError:
        pass
    del reg["pools"][pool]
    save_reg(reg)
    return {"destroyed": True}


# ------------------------------------------------------------------- disks
def op_disks(p):
    out = []
    j = run(["lsblk", "-J", "-b", "-o", "NAME,SIZE,TYPE,MODEL,SERIAL,ROTA,MOUNTPOINTS"], check=False)
    try:
        devs = json.loads(j.stdout).get("blockdevices", [])
    except ValueError:
        devs = []
    for d in devs:
        if d.get("type") not in ("disk",):
            continue
        entry = {"name": d["name"], "sizeBytes": int(d["size"]) if d.get("size") else None, "model": d.get("model"), "serial": d.get("serial"), "rotational": d.get("rota"), "measurement": "MEASURED"}
        if have("smartctl"):
            s = run(["smartctl", "-H", "-j", "/dev/" + d["name"]], check=False)
            try:
                sj = json.loads(s.stdout)
                passed = sj.get("smart_status", {}).get("passed")
                if passed is None:
                    entry["smart"] = {"status": "UNKNOWN", "reason": "Device does not expose SMART (virtual disk)."}
                else:
                    entry["smart"] = {"status": "PASSED" if passed else "FAILING", "measurement": "MEASURED"}
                temp = sj.get("temperature", {}).get("current")
                entry["temperatureC"] = temp if temp is not None else None
            except ValueError:
                entry["smart"] = {"status": "UNKNOWN", "reason": "smartctl gave no readable result."}
        else:
            entry["smart"] = {"status": "UNKNOWN", "reason": "smartmontools is not installed."}
        entry["virtual"] = (d.get("model") or "").lower().startswith("virtual")
        if entry["virtual"] and entry["smart"].get("status") == "PASSED":
            entry["smart"]["note"] = "Reported by a hypervisor virtual disk; it says nothing about physical media health."
        entry["temperatureLabel"] = "MEASURED" if entry.get("temperatureC") is not None else "UNKNOWN"
        out.append(entry)
    return {"disks": out}


# --------------------------------------------------------------- metrics
def read_cpu():
    with open("/proc/stat", "r", encoding="utf8") as f:
        parts = f.readline().split()[1:]
    vals = [int(x) for x in parts]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    return sum(vals), idle


def read_net():
    out = {}
    with open("/proc/net/dev", "r", encoding="utf8") as f:
        for line in f.readlines()[2:]:
            name, rest = line.split(":", 1)
            f2 = rest.split()
            out[name.strip()] = (int(f2[0]), int(f2[8]))
    return out


def read_disk_io():
    tot = [0, 0, 0, 0]
    with open("/proc/diskstats", "r", encoding="utf8") as f:
        for line in f:
            x = line.split()
            if len(x) < 14 or not re.match(r"^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|md\d+)$", x[2]):
                continue
            tot[0] += int(x[3]); tot[1] += int(x[5]); tot[2] += int(x[9]); tot[3] += int(x[6]) + int(x[10])
    return tot


def op_metrics(p):
    t1, i1 = read_cpu(); n1 = read_net(); d1 = read_disk_io(); s1 = time.time()
    time.sleep(0.4)
    t2, i2 = read_cpu(); n2 = read_net(); d2 = read_disk_io(); s2 = time.time()
    dt = max(s2 - s1, 0.001)
    cpu = 100.0 * (1 - (i2 - i1) / max(t2 - t1, 1))
    mem = {}
    with open("/proc/meminfo", "r", encoding="utf8") as f:
        for l in f:
            k, v = l.split(":")
            mem[k] = int(v.split()[0]) * 1024
    net = {k: {"rxBytesPerSec": (n2[k][0] - n1.get(k, (0, 0))[0]) / dt, "txBytesPerSec": (n2[k][1] - n1.get(k, (0, 0))[1]) / dt} for k in n2 if k != "lo"}
    with open("/proc/loadavg", "r", encoding="utf8") as f:
        load = [float(x) for x in f.read().split()[:3]]
    with open("/proc/uptime", "r", encoding="utf8") as f:
        up = float(f.read().split()[0])
    shares = run(["smbstatus", "--json", "-S"], check=False)
    sess = run(["smbstatus", "--json", "-p"], check=False)
    try:
        session_count = len(json.loads(sess.stdout).get("sessions", {}))
    except ValueError:
        session_count = None
    thermal = None
    for z in ("/sys/class/thermal/thermal_zone0/temp",):
        try:
            with open(z, "r") as f:
                thermal = int(f.read().strip()) / 1000.0
        except (OSError, ValueError):
            pass
    usage = shutil.disk_usage(NAS_ROOT) if os.path.isdir(NAS_ROOT) else None
    return {
        "cpuPercent": {"value": round(cpu, 1), "measurement": "MEASURED"},
        "memory": {"totalBytes": mem.get("MemTotal"), "availableBytes": mem.get("MemAvailable"), "measurement": "MEASURED"},
        "loadAverage": {"values": load, "measurement": "MEASURED"},
        "uptimeSeconds": {"value": up, "measurement": "MEASURED"},
        "network": {"interfaces": net, "measurement": "MEASURED"},
        "diskIo": {"readOps": d2[0] - d1[0], "writeOps": d2[1] - d1[1], "readSectors": d2[2] - d1[2], "writeSectors": d2[3] - d1[3], "windowSeconds": round(dt, 2), "measurement": "MEASURED", "note": "Counters over the sample window; not a latency or IOPS guarantee."},
        "smbSessions": {"value": session_count, "measurement": "MEASURED" if session_count is not None else "UNKNOWN"},
        "thermal": {"celsius": thermal, "measurement": "MEASURED" if thermal is not None else "UNKNOWN", "reason": None if thermal is not None else "No thermal sensor is exposed to this VM."},
        "fans": {"measurement": "UNKNOWN", "reason": "No fan sensors are exposed to this VM."},
        "ups": {"measurement": "UNKNOWN", "reason": "No UPS is attached / no NUT service is configured."},
        "storageLatency": {"measurement": "UNKNOWN", "reason": "Latency is not measured by this agent."},
        "nasRootUsage": ({"totalBytes": usage.total, "usedBytes": usage.used, "freeBytes": usage.free, "measurement": "MEASURED"} if usage else {"measurement": "UNKNOWN"}),
    }


# --------------------------------------------------------------- services
def svc_active(name):
    return run(["systemctl", "is-active", name], check=False).stdout.strip() == "active" or ("active (running)" in run(["service", name, "status"], check=False).stdout)


def op_services(p):
    return {"smbd": svc_active("smbd"), "nfs": svc_active("nfs-kernel-server"), "avahi": svc_active("avahi-daemon")}


def op_ensure_online(p):
    """Bring the appliance to its configured state after a (re)start."""
    result = {"pools": op_pool_ensure({})}
    ensure_samba_layout()
    for s in ("smbd", "nmbd", "nfs-kernel-server"):
        run(["service", s, "start"], check=False)
    try:
        with open(BOOT_MARKER, "w", encoding="utf8") as f:
            f.write(str(time.time()))
    except OSError:
        pass
    nfs_reload()
    result["services"] = op_services({})
    result["agentVersion"] = AGENT_VERSION
    return result


# ------------------------------------------------------------------ shares
def ensure_share_dir(reg, name, backend, pool, owner):
    if backend == "btrfs":
        if not pool or pool not in reg["pools"]:
            raise AgentError("A btrfs share needs an existing pool.", "BAD_INPUT")
        path = pool_mount(pool) + "/" + name
        if not os.path.exists(path):
            run(["btrfs", "subvolume", "create", path])
        return path
    path = NAS_ROOT + "/" + name
    os.makedirs(path, exist_ok=True)
    return path


def op_share_apply(p):
    spec = p["spec"]
    name = v_name(spec["name"], "share name")
    backend = p.get("backend", "dir")
    if backend not in ("dir", "btrfs", "ext4quota"):
        raise AgentError("Unknown share backend.", "BAD_INPUT")
    reg = load_reg()
    existing = reg["shares"].get(name)
    if existing:
        backend = existing["backend"]
        pool = existing.get("pool")
        path = existing["path"]
    elif p.get("_path"):
        pool = p.get("pool")
        path = os.path.realpath(p["_path"])
        if not within(NAS_ROOT, path):
            raise AgentError("Rename target path escapes the NAS root.", "TRAVERSAL")
    else:
        pool = p.get("pool")
        if backend == "ext4quota":
            vol = reg["volumes"].get(name)
            if not vol:
                raise AgentError("Create the quota volume first.", "BAD_INPUT")
            path = vol["path"]
        else:
            path = ensure_share_dir(reg, name, backend, pool, spec.get("owner"))
    owner = spec.get("owner")
    if owner and not existing:
        v_user(owner)
        run(["chown", owner + ":nogroup", path])
        run(["chmod", "0775", path])
    ensure_samba_layout()
    conf_path = "%s/%s.conf" % (SMB_DIR, name)
    prev = None
    if os.path.exists(conf_path):
        with open(conf_path, "r", encoding="utf8") as f:
            prev = f.read()
    text = render_conf(spec, path)
    with open(conf_path, "w", encoding="utf8") as f:
        f.write(text)
    write_shares_include()
    ok, err = testparm_ok()
    if not ok:  # fail closed: put the last good config back
        if prev is None:
            os.remove(conf_path)
        else:
            with open(conf_path, "w", encoding="utf8") as f:
                f.write(prev)
        write_shares_include()
        raise AgentError("Samba rejected the share configuration: %s" % err, "BAD_CONFIG")
    samba_reload()
    reg["shares"][name] = {"backend": backend, "pool": pool, "path": path, "spec": spec, "updatedAt": int(time.time())}
    save_reg(reg)
    return {"dataPath": path, "confPath": conf_path, "backend": backend}


def op_share_delete(p):
    name = v_name(p["name"], "share name")
    reg = load_reg()
    s = reg["shares"].get(name)
    path = share_dir(reg, name)
    conf = "%s/%s.conf" % (SMB_DIR, name)
    if os.path.exists(conf):
        os.remove(conf)
    write_shares_include()
    ex = "%s/inaya-%s.exports" % (EXPORTS_DIR, name)
    if os.path.exists(ex):
        os.remove(ex)
        nfs_reload()
    samba_reload()
    if p.get("purgeData"):
        if s and s["backend"] == "btrfs":
            for snap in list_snapshots_raw(reg, name):
                snapshot_unlock(reg, name, snap["name"], force=True)
                run(["btrfs", "subvolume", "delete", snap["path"]], check=False)
            run(["btrfs", "subvolume", "delete", path], check=False)
        elif s and s["backend"] == "ext4quota":
            vol = reg["volumes"].pop(name, None)
            if vol:
                run(["umount", vol["path"]], check=False)
                shutil.rmtree(vol["path"], ignore_errors=True)
                if os.path.exists(vol["image"]):
                    os.remove(vol["image"])
        else:
            if within(NAS_ROOT, path) and os.path.realpath(path) != os.path.realpath(NAS_ROOT):
                run(["chattr", "-R", "-i", path], check=False)
                shutil.rmtree(path, ignore_errors=True)
    reg["shares"].pop(name, None)
    save_reg(reg)
    return {"deleted": True}


def op_nfs_apply(p):
    name = v_name(p["name"], "share name")
    reg = load_reg()
    path = share_dir(reg, name)
    if not os.path.isdir(path):
        raise AgentError("Share directory does not exist.", "NOT_FOUND")
    clients = [v_client(c) for c in p.get("clients", [])]
    if not clients:
        raise AgentError("At least one client network is required (no wildcard export).", "BAD_INPUT")
    mode = "ro" if p.get("readOnly") else "rw"
    squash = "root_squash" if p.get("rootSquash", True) else "no_root_squash"
    if squash == "no_root_squash" and not p.get("allowNoRootSquash"):
        raise AgentError("no_root_squash requires explicit allowNoRootSquash.", "BAD_INPUT")
    opts = "%s,sync,no_subtree_check,%s,sec=sys,fsid=%d" % (mode, squash, 1000 + (int(hashlib.sha1(name.encode()).hexdigest()[:6], 16) % 60000))
    os.makedirs(EXPORTS_DIR, exist_ok=True)
    line = "%s %s\n" % (path, " ".join("%s(%s)" % (c, opts) for c in clients))
    with open("%s/inaya-%s.exports" % (EXPORTS_DIR, name), "w", encoding="utf8") as f:
        f.write("# managed by inaya-nas-agent\n" + line)
    nfs_reload()
    active = run(["exportfs", "-v"], check=False).stdout
    if path not in active:
        raise AgentError("The export did not become active.", "CMD_FAILED")
    return {"exported": True, "path": path, "clients": clients, "mode": mode, "rootSquash": squash == "root_squash"}


def op_nfs_remove(p):
    name = v_name(p["name"], "share name")
    ex = "%s/inaya-%s.exports" % (EXPORTS_DIR, name)
    if os.path.exists(ex):
        os.remove(ex)
        nfs_reload()
    return {"removed": True}


# -------------------------------------------------- users, groups, lockout
def op_user_create(p):
    u = v_user(p["username"])
    pw = p["password"]
    if not isinstance(pw, str) or len(pw) < 12 or len(pw) > 128 or "\n" in pw or "\0" in pw:
        raise AgentError("Password must be 12-128 characters without line breaks.", "BAD_INPUT")
    if run(["id", "-u", u], check=False).returncode != 0:
        run(["useradd", "-M", "-s", "/usr/sbin/nologin", u])
    run(["smbpasswd", "-a", "-s", u], input="%s\n%s\n" % (pw, pw))
    run(["smbpasswd", "-e", u])
    return {"created": True}


def op_user_set_password(p):
    u = v_user(p["username"])
    pw = p["password"]
    if not isinstance(pw, str) or len(pw) < 12 or len(pw) > 128 or "\n" in pw:
        raise AgentError("Password must be 12-128 characters without line breaks.", "BAD_INPUT")
    run(["smbpasswd", "-s", u], input="%s\n%s\n" % (pw, pw))
    return {"rotated": True}


def op_user_disable(p):
    run(["smbpasswd", "-d", v_user(p["username"])], check=False)
    return {"disabled": True}


def op_user_enable(p):
    run(["smbpasswd", "-e", v_user(p["username"])])
    return {"enabled": True}


def op_user_delete(p):
    u = v_user(p["username"])
    run(["smbpasswd", "-x", u], check=False)
    run(["userdel", u], check=False)
    return {"deleted": True}


def op_user_status(p):
    u = v_user(p["username"])
    r = run(["pdbedit", "-L", "-v", "-u", u], check=False)
    if r.returncode != 0:
        return {"exists": False}
    flags = re.search(r"Account Flags:\s*(\[[^\]]*\])", r.stdout)
    bad = re.search(r"Bad Password Count\s*:\s*(\d+)", r.stdout) or re.search(r"Bad password count\s*:\s*(\d+)", r.stdout, re.I)
    flags = flags.group(1) if flags else ""
    return {"exists": True, "flags": flags, "disabled": "D" in flags, "locked": "L" in flags, "badPasswordCount": int(bad.group(1)) if bad else None}


def op_user_unlock(p):
    u = v_user(p["username"])
    # `-c "[-L]"` clears the autolock flag Samba set after too many bad
    # passwords (and resets the count); `-z` alone leaves the account locked.
    run(["pdbedit", "-c", "[-L]", "-u", u], check=False)
    run(["pdbedit", "-z", "-u", u], check=False)
    st = op_user_status({"username": u})
    return {"unlocked": not st.get("locked", False), "flags": st.get("flags")}


def op_lockout_policy(p):
    attempts = int(p.get("attempts", 5))
    minutes = int(p.get("durationMinutes", 15))
    if not 1 <= attempts <= 100 or not 0 <= minutes <= 10080:
        raise AgentError("attempts 1..100, durationMinutes 0..10080.", "BAD_INPUT")
    run(["pdbedit", "-P", "bad lockout attempt", "-C", str(attempts)])
    run(["pdbedit", "-P", "lockout duration", "-C", str(minutes)])
    run(["pdbedit", "-P", "reset count minutes", "-C", str(max(minutes, 1))])
    return {"attempts": attempts, "durationMinutes": minutes}


def op_group_create(p):
    g = v_name(p["group"], "group")
    if run(["getent", "group", g], check=False).returncode != 0:
        run(["groupadd", g])
    return {"created": True}


def op_group_delete(p):
    run(["groupdel", v_name(p["group"], "group")], check=False)
    return {"deleted": True}


def op_group_member(p):
    g = v_name(p["group"], "group")
    u = v_user(p["username"])
    if p.get("action") == "remove":
        run(["gpasswd", "-d", u, g], check=False)
    else:
        run(["gpasswd", "-a", u, g])
    return {"ok": True}


def op_group_members(p):
    g = v_name(p["group"], "group")
    r = run(["getent", "group", g], check=False)
    if r.returncode != 0:
        return {"exists": False, "members": []}
    members = [m for m in r.stdout.strip().split(":")[-1].split(",") if m]
    return {"exists": True, "members": members}


# ------------------------------------------------------------------- ACLs
def op_acl_apply(p):
    reg = load_reg()
    name = v_name(p["share"], "share")
    base = share_dir(reg, name)
    rel = v_rel(p["relPath"]) if p.get("relPath") not in (None, "", ".") else None
    target = real_within(base, base + "/" + rel) if rel else base
    entries = p.get("entries", [])
    if not entries or len(entries) > 64:
        raise AgentError("1..64 ACL entries required.", "BAD_INPUT")
    specs = []
    for e in entries:
        kind = e.get("type")
        who = v_user(e["name"]) if kind == "user" else v_name(e["name"], "group") if kind == "group" else None
        if who is None:
            raise AgentError("ACL entry type must be user or group.", "BAD_INPUT")
        perms = e.get("perms", "---")
        if not re.match(r"^[r-][w-][x-]$", perms):
            raise AgentError("Invalid permission string.", "BAD_INPUT")
        specs.append(("u" if kind == "user" else "g", who, perms, bool(e.get("default"))))
    for kind, who, perms, dflt in specs:
        argv = ["setfacl"] + (["-R"] if p.get("recursive") else []) + (["-d"] if dflt else []) + ["-m", "%s:%s:%s" % (kind, who, perms), target]
        run(argv)
    return op_acl_get({"share": name, "relPath": rel or "."})


def op_acl_get(p):
    reg = load_reg()
    name = v_name(p["share"], "share")
    base = share_dir(reg, name)
    rel = v_rel(p["relPath"]) if p.get("relPath") not in (None, "", ".") else None
    target = real_within(base, base + "/" + rel) if rel else base
    r = run(["getfacl", "-p", "-c", target])
    return {"path": rel or ".", "acl": [l for l in r.stdout.split("\n") if l and not l.startswith("#")]}


# -------------------------------------------------------- volumes (quotas)
def op_volume_create(p):
    """A fixed-size ext4 volume with user+group quotas -- the backend that
    supports per-user quotas (Btrfs qgroups are per-subvolume only)."""
    name = v_name(p["name"], "volume")
    size_mb = int(p.get("sizeMb", 256))
    if size_mb < 32 or size_mb > 200000:
        raise AgentError("sizeMb must be 32..200000.", "BAD_INPUT")
    reg = load_reg()
    if name in reg["volumes"]:
        raise AgentError("Volume already exists.", "EXISTS")
    for tool in ("mkfs.ext4", "setquota", "quotaon"):
        if not have(tool):
            raise AgentError("%s is required for quota volumes." % tool, "MISSING_TOOL")
    os.makedirs(VOLUMES_DIR, exist_ok=True)
    img = "%s/%s.img" % (VOLUMES_DIR, name)
    with open(img, "wb") as f:
        f.truncate(size_mb * 1024 * 1024)
    run(["mkfs.ext4", "-q", "-F", "-O", "quota", "-E", "quotatype=usrquota:grpquota", img])
    path = NAS_ROOT + "/" + name
    os.makedirs(path, exist_ok=True)
    run(["mount", "-o", "loop,usrquota,grpquota", img, path])
    run(["quotaon", "-u", "-g", path], check=False)
    reg["volumes"][name] = {"image": img, "path": path, "sizeMb": size_mb}
    save_reg(reg)
    return {"path": path, "sizeMb": size_mb}


def op_user_quota_set(p):
    name = v_name(p["share"], "share")
    u = v_user(p["username"])
    reg = load_reg()
    vol = reg["volumes"].get(name)
    if not vol:
        return {"supported": False, "reason": "User quotas need an ext4 quota volume backend."}
    soft = int(p.get("softBytes", 0)) // 1024
    hard = int(p.get("hardBytes", 0)) // 1024
    if hard < 0 or soft < 0 or (hard and soft > hard):
        raise AgentError("Invalid quota values.", "BAD_INPUT")
    run(["setquota", "-u", u, str(soft), str(hard), "0", "0", vol["path"]])
    return {"supported": True, "username": u, "softBytes": soft * 1024, "hardBytes": hard * 1024}


def op_user_quota_usage(p):
    name = v_name(p["share"], "share")
    reg = load_reg()
    vol = reg["volumes"].get(name)
    if not vol:
        return {"supported": False, "reason": "User quotas need an ext4 quota volume backend."}
    r = run(["repquota", "-u", "-v", "-O", "csv", vol["path"]], check=False)
    rows = []
    for l in r.stdout.split("\n")[1:]:
        c = l.split(",")
        if len(c) >= 6 and c[0] and not c[0].startswith("*"):
            try:
                rows.append({"user": c[0], "usedBytes": int(c[2]) * 1024 if c[2].isdigit() else None, "softBytes": int(c[3]) * 1024 if c[3].isdigit() else None, "hardBytes": int(c[4]) * 1024 if c[4].isdigit() else None})
            except (ValueError, IndexError):
                pass
    return {"supported": True, "users": rows, "measurement": "MEASURED"}


def op_share_quota_set(p):
    name = v_name(p["share"], "share")
    reg = load_reg()
    s = reg["shares"].get(name)
    if not s:
        raise AgentError("Share not registered with the agent.", "NOT_FOUND")
    nbytes = p.get("hardBytes")
    if s["backend"] == "btrfs":
        run(["btrfs", "qgroup", "limit", "none" if not nbytes else str(int(nbytes)), s["path"]])
        return {"supported": True, "enforced": True, "mechanism": "btrfs qgroup referenced limit", "hardBytes": nbytes}
    if s["backend"] == "ext4quota":
        vol = reg["volumes"][name]
        return {"supported": True, "enforced": True, "mechanism": "fixed-size ext4 volume (%d MB)" % vol["sizeMb"], "hardBytes": vol["sizeMb"] * 1024 * 1024}
    return {"supported": False, "enforced": False, "reason": "Legacy directory shares live on the appliance root filesystem, which has no quota support."}


def op_share_usage(p):
    name = v_name(p["share"], "share")
    reg = load_reg()
    s = reg["shares"].get(name)
    path = share_dir(reg, name)
    backend = (s or {}).get("backend", "dir")
    out = {"backend": backend, "measurement": "MEASURED"}
    if backend == "btrfs":
        r = run(["btrfs", "qgroup", "show", "-reF", "--raw", path], check=False)
        rows = [l.split() for l in r.stdout.split("\n") if re.match(r"^\s*0/\d+", l)]
        if rows:
            out["usedBytes"] = int(rows[0][1])
            out["limitBytes"] = int(rows[0][3]) if rows[0][3].isdigit() else None
            out["enforced"] = out["limitBytes"] is not None
            return out
    if backend == "ext4quota":
        u = shutil.disk_usage(path)
        out.update({"usedBytes": u.used, "limitBytes": u.total, "enforced": True})
        return out
    r = run(["du", "-sb", "--exclude=.recycle", path], check=False)
    out["usedBytes"] = int(r.stdout.split()[0]) if r.stdout.split() else None
    out["limitBytes"] = None
    out["enforced"] = False
    return out


# ---------------------------------------------------------------- snapshots
def snap_dir(reg, share):
    s = reg["shares"].get(share)
    if s and s["backend"] == "btrfs":
        return "%s/.snapshots/%s" % (pool_mount(s["pool"]), share)
    return "%s/%s" % (SNAP_ROOT, share)


def is_locked(path):
    r = run(["lsattr", "-d", path], check=False)
    return bool(re.match(r"^\S*i\S*\s", r.stdout or ""))


def list_snapshots_raw(reg, share):
    d = snap_dir(reg, share)
    out = []
    if not os.path.isdir(d):
        return out
    for n in sorted(os.listdir(d)):
        pth = d + "/" + n
        if os.path.isdir(pth):
            meta = {}
            mp = "%s/%s.meta.json" % (d, n)
            try:
                with open(mp, "r", encoding="utf8") as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                pass
            out.append({"name": n, "path": pth, "locked": is_locked(pth), **meta})
    return out


UNSAFE_NAME = re.compile(r"[\x00-\x1f\x7f]")


def dir_manifest(root, skip=(".recycle", ".restored", ".recovery-drill")):
    lines = []
    total = 0
    count = 0
    unsafe = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not (dirpath == root and d in skip)]
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, root)
            if UNSAFE_NAME.search(rel):
                unsafe += 1
                continue
            try:
                size = os.path.getsize(full)
                digest = sha256_file(full)
            except OSError:
                continue
            lines.append("%s\t%d\t%s" % (rel, size, digest))
            total += size
            count += 1
    lines.sort()
    return {"manifestHash": hashlib.sha256("\n".join(lines).encode("utf8")).hexdigest(), "fileCount": count, "totalBytes": total, "lines": lines, "skippedUnsafeNames": unsafe}


def op_manifest(p):
    reg = load_reg()
    name = v_name(p["share"], "share")
    if p.get("snapshot"):
        root = snap_dir(reg, name) + "/" + v_snap(p["snapshot"])
    else:
        root = share_dir(reg, name)
    if not os.path.isdir(root):
        raise AgentError("Path not found.", "NOT_FOUND")
    m = dir_manifest(root)
    if not p.get("includeLines"):
        m.pop("lines")
    return m


def op_snapshot_create(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    snap = v_snap(p["snapshot"])
    s = reg["shares"].get(share)
    src = share_dir(reg, share)
    if not os.path.isdir(src):
        raise AgentError("Share directory not found.", "NOT_FOUND")
    immutable = bool(p.get("immutable"))
    retention = int(p.get("retentionUntil") or 0)
    if immutable and (retention <= time.time()):
        raise AgentError("An immutable snapshot needs a future retentionUntil.", "BAD_INPUT")
    d = snap_dir(reg, share)
    os.makedirs(d, exist_ok=True)
    dest = d + "/" + snap
    if os.path.exists(dest):
        raise AgentError("Snapshot already exists.", "EXISTS")
    backend = (s or {}).get("backend", "dir")
    started = time.time()
    if backend == "btrfs":
        if immutable:
            run(["btrfs", "subvolume", "snapshot", src, dest])
            run(["chattr", "-R", "+i", dest])
            run(["btrfs", "property", "set", "-ts", dest, "ro", "true"])
        else:
            run(["btrfs", "subvolume", "snapshot", "-r", src, dest])
        stype = "copy-on-write"
    else:
        run(["cp", "-a", "--reflink=auto", src, dest], timeout=900)
        if immutable:
            run(["chattr", "-R", "+i", dest])
        stype = "full-copy"
    elapsed = time.time() - started
    m = dir_manifest(dest)
    meta = {"type": stype, "immutable": immutable, "retentionUntil": retention or None, "createdAt": int(time.time()), "manifestHash": m["manifestHash"], "fileCount": m["fileCount"], "totalBytes": m["totalBytes"], "createLatencyMs": int(elapsed * 1000)}
    mp = "%s/%s.meta.json" % (d, snap)
    with open(mp, "w", encoding="utf8") as f:
        json.dump(meta, f)
    return {"name": snap, "path": dest, "locked": immutable, **meta}


def op_snapshot_list(p):
    reg = load_reg()
    return {"snapshots": list_snapshots_raw(reg, v_name(p["share"], "share"))}


def snapshot_unlock(reg, share, snap, force=False):
    d = snap_dir(reg, share)
    dest = d + "/" + snap
    if not os.path.isdir(dest):
        raise AgentError("Snapshot not found.", "NOT_FOUND")
    meta = {}
    try:
        with open("%s/%s.meta.json" % (d, snap), "r", encoding="utf8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        pass
    if meta.get("immutable") and meta.get("retentionUntil") and meta["retentionUntil"] > time.time() and not force:
        raise AgentError("Snapshot is locked until %s." % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(meta["retentionUntil"])), "LOCKED")
    s = reg["shares"].get(share)
    if s and s["backend"] == "btrfs":
        run(["btrfs", "property", "set", "-ts", dest, "ro", "false"], check=False)
    run(["chattr", "-R", "-i", dest], check=False)
    if s and s["backend"] == "btrfs":
        run(["btrfs", "property", "set", "-ts", dest, "ro", "true"], check=False)
    return meta


def op_snapshot_delete(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    snap = v_snap(p["snapshot"])
    d = snap_dir(reg, share)
    dest = d + "/" + snap
    snapshot_unlock(reg, share, snap, force=bool(p.get("override")))
    s = reg["shares"].get(share)
    if s and s["backend"] == "btrfs":
        run(["btrfs", "property", "set", "-ts", dest, "ro", "false"], check=False)
        run(["btrfs", "subvolume", "delete", dest])
    else:
        shutil.rmtree(dest)
    mp = "%s/%s.meta.json" % (d, snap)
    if os.path.exists(mp):
        os.remove(mp)
    return {"deleted": True}


def op_snapshot_release_expired(p):
    reg = load_reg()
    released = []
    for share in list(reg["shares"].keys()):
        for sn in list_snapshots_raw(reg, share):
            if sn.get("immutable") and sn.get("locked") and sn.get("retentionUntil") and sn["retentionUntil"] <= time.time():
                snapshot_unlock(reg, share, sn["name"])
                released.append("%s/%s" % (share, sn["name"]))
    return {"released": released}


def op_snapshot_restore(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    snap = v_snap(p["snapshot"])
    src_root = snap_dir(reg, share) + "/" + snap
    live = share_dir(reg, share)
    if not os.path.isdir(src_root):
        raise AgentError("Snapshot not found.", "NOT_FOUND")
    in_place = bool(p.get("inPlace"))
    rel = v_rel(p["relPath"]) if p.get("relPath") else None
    if rel:
        src = real_within(src_root, src_root + "/" + rel)
        if not os.path.exists(src):
            raise AgentError("That path is not in the snapshot.", "NOT_FOUND")
        if in_place:
            dst = real_within(live, live + "/" + rel)
        else:
            dst = live + "/.restored/" + snap + "/" + rel
            real_within(live, dst)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.isdir(src):
            run(["rsync", "-a", src + "/", dst + "/"])
        else:
            run(["rsync", "-a", src, dst])
        return {"restoredTo": os.path.relpath(dst, live), "inPlace": in_place, "scope": "path"}
    if in_place:
        run(["rsync", "-a", "--delete", "--exclude=.recycle", src_root + "/", live + "/"], timeout=900)
        return {"restoredTo": ".", "inPlace": True, "scope": "share"}
    dst = live + "/.restored/" + snap
    os.makedirs(dst, exist_ok=True)
    run(["rsync", "-a", src_root + "/", dst + "/"], timeout=900)
    return {"restoredTo": ".restored/" + snap, "inPlace": False, "scope": "share"}


def op_snapshot_browse(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    snap = v_snap(p["snapshot"])
    root = snap_dir(reg, share) + "/" + snap
    rel = v_rel(p["relPath"]) if p.get("relPath") else None
    base = real_within(root, root + "/" + rel) if rel else root
    entries = []
    for n in sorted(os.listdir(base))[:2000]:
        full = base + "/" + n
        st = os.lstat(full)
        entries.append({"name": n, "dir": os.path.isdir(full), "sizeBytes": st.st_size})
    return {"entries": entries}


def op_snapshot_try_tamper(p):
    """Security-test hook: try to delete/modify inside a snapshot the way a
    compromised process would, and report what the backend prevented."""
    reg = load_reg()
    share = v_name(p["share"], "share")
    snap = v_snap(p["snapshot"])
    dest = snap_dir(reg, share) + "/" + snap
    res = {}
    victim = None
    for dp, dn, fn in os.walk(dest):
        if fn:
            victim = os.path.join(dp, fn[0])
            break
    if victim:
        r = run(["rm", "-f", victim], check=False)
        res["deleteFile"] = "blocked" if os.path.exists(victim) else "SUCCEEDED"
        r = run(["sh", "-c", "echo tamper >> \"$1\"", "sh", victim], check=False)
        res["appendFile"] = "blocked" if r.returncode != 0 else "SUCCEEDED"
    r = run(["rm", "-rf", dest], check=False)
    res["removeSnapshotDir"] = "blocked" if os.path.exists(dest) else "SUCCEEDED"
    s = reg["shares"].get(share)
    if s and s["backend"] == "btrfs" and os.path.exists(dest):
        r = run(["btrfs", "subvolume", "delete", dest], check=False)
        res["btrfsDeleteSubvolume"] = "blocked" if os.path.exists(dest) else "SUCCEEDED"
    return res


# ------------------------------------------------------------- files / IO
def op_put_file(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    rel = v_rel(p["relPath"])
    src = check_temp(p["srcPath"])
    dst = real_within(base, base + "/" + rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    real_within(base, os.path.dirname(dst))
    shutil.copyfile(src, dst)
    if p.get("owner"):
        run(["chown", v_user(p["owner"]) + ":nogroup", dst])
    return {"bytes": os.path.getsize(dst), "sha256": sha256_file(dst)}


def op_get_file(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    rel = v_rel(p["relPath"])
    if p.get("snapshot"):
        base = snap_dir(reg, share) + "/" + v_snap(p["snapshot"])
    src = real_within(base, base + "/" + rel)
    dst = check_temp(p["dstPath"])
    if not os.path.isfile(src):
        raise AgentError("File not found.", "NOT_FOUND")
    shutil.copyfile(src, dst)
    return {"bytes": os.path.getsize(dst), "sha256": sha256_file(dst)}


def op_delete_file(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    rel = v_rel(p["relPath"])
    target = real_within(base, base + "/" + rel)
    run(["rm", "-rf", "--one-file-system", target])
    return {"deleted": True}


def op_list_files(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    files = []
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if not (dp == base and d in (".recycle", ".restored"))]
        for n in fn:
            full = os.path.join(dp, n)
            if os.path.islink(full):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            if UNSAFE_NAME.search(os.path.relpath(full, base)):
                continue
            files.append({"relativePath": os.path.relpath(full, base), "sizeBytes": st.st_size, "mtime": st.st_mtime, "atime": st.st_atime})
            if len(files) >= int(p.get("limit", 50000)):
                return {"files": files, "truncated": True}
    return {"files": files, "truncated": False}


def op_stat_path(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    rel = v_rel(p["relPath"])
    target = base + "/" + rel
    if not os.path.lexists(target):
        return {"exists": False}
    resolved = os.path.realpath(target)
    return {"exists": True, "isSymlink": os.path.islink(target), "escapesShare": not within(base, resolved), "immutable": is_locked(target)}


def op_make_symlink(p):
    """Security-test helper: plant a symlink so escape defenses can be tested."""
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    rel = v_rel(p["relPath"])
    link = real_within(base, os.path.dirname(base + "/" + rel)) + "/" + os.path.basename(rel)
    if os.path.lexists(link):
        os.remove(link)
    os.symlink(p["target"], link)
    return {"created": True}


# ------------------------------------------------------------- recycle bin
def recycle_root(reg, share):
    return share_dir(reg, share) + "/.recycle"


def op_recycle_list(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    root = recycle_root(reg, share)
    out = []
    if os.path.isdir(root):
        for dp, dn, fn in os.walk(root):
            for n in fn:
                full = os.path.join(dp, n)
                st = os.stat(full)
                rel = os.path.relpath(full, root)
                user = rel.split("/", 1)[0]
                out.append({"path": full, "recyclePath": rel, "user": user, "originalPath": rel.split("/", 1)[1] if "/" in rel else n, "sizeBytes": st.st_size, "deletedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))})
    return {"entries": out}


def op_recycle_restore(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    root = recycle_root(reg, share)
    rp = v_rel(p["recyclePath"])
    src = real_within(root, root + "/" + rp)
    if not os.path.isfile(src):
        raise AgentError("Recycle entry not found.", "NOT_FOUND")
    user, _, orig = rp.partition("/")
    orig = re.sub(r"^Copy #\d+ of ", "", orig)
    base = share_dir(reg, share)
    dst = real_within(base, base + "/" + orig)
    if os.path.exists(dst) and not p.get("overwrite"):
        raise AgentError("A file already exists at the original location.", "EXISTS")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.move(src, dst)
    return {"restoredTo": orig}


def op_recycle_purge(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    root = recycle_root(reg, share)
    removed = 0
    if p.get("recyclePath"):
        src = real_within(root, root + "/" + v_rel(p["recyclePath"]))
        if os.path.isfile(src):
            os.remove(src)
            removed = 1
    else:
        cutoff = time.time() - float(p.get("olderThanDays", 30)) * 86400
        if os.path.isdir(root):
            for dp, dn, fn in os.walk(root):
                for n in fn:
                    full = os.path.join(dp, n)
                    if os.stat(full).st_mtime < cutoff:
                        os.remove(full)
                        removed += 1
    return {"removed": removed}


# -------------------------------------------------------- locks / sessions
def op_locks_list(p):
    r = run(["smbstatus", "--json", "-L"], check=False)
    try:
        j = json.loads(r.stdout)
    except ValueError:
        return {"locks": []}
    locks = []
    for _, f in (j.get("open_files") or {}).items():
        opens = f.get("opens", {})
        for _, o in opens.items():
            locks.append({"path": f.get("service_path", "") + "/" + f.get("filename", ""), "user": (o.get("server_id") or {}).get("pid"), "uid": o.get("uid"), "accessMask": (o.get("access_mask") or {}).get("text"), "sharemode": (o.get("sharemode") or {}).get("text"), "oplock": (o.get("oplock") or {}).get("text"), "leaseText": (o.get("lease") or {}).get("lease_type") if isinstance(o.get("lease"), dict) else None})
    return {"locks": locks, "raw": len(locks)}


def op_sessions_list(p):
    r = run(["smbstatus", "--json", "-p"], check=False)
    try:
        j = json.loads(r.stdout)
    except ValueError:
        return {"sessions": []}
    out = []
    for sid, s in (j.get("sessions") or {}).items():
        out.append({"sessionId": sid, "username": s.get("username"), "remoteMachine": s.get("remote_machine"), "protocol": s.get("session_dialect")})
    return {"sessions": out}


def op_share_close_connections(p):
    """Drop every client connection to one share (used by lockdown so open
    write handles cannot outlive the read-only switch)."""
    name = v_name(p["share"], "share")
    r = run(["smbcontrol", "smbd", "close-share", name], check=False)
    return {"closed": r.returncode == 0}


def op_session_close(p):
    u = v_user(p["username"])
    r = run(["smbstatus", "--json", "-p"], check=False)
    closed = 0
    try:
        j = json.loads(r.stdout)
        for sid, s in (j.get("sessions") or {}).items():
            if s.get("username") == u and (s.get("server_id") or {}).get("pid"):
                run(["kill", "-TERM", str(int(s["server_id"]["pid"]))], check=False)
                closed += 1
    except ValueError:
        pass
    return {"closed": closed}


# ----------------------------------------------------------- ransomware scan
SUSPICIOUS_EXT = {"locked", "encrypted", "crypt", "crypto", "enc", "lock", "locky", "cerber", "wncry", "wcry", "ryuk", "akira", "conti", "royal", "hive", "blackcat", "zepto", "ecc", "xxx", "zzz", "aaa", "abc", "micro", "vvv", "ccc", "ttt", "id-decrypt"}
RANSOM_NOTE_RE = re.compile(r"(how[_ -]?to[_ -]?(decrypt|recover)|read[_ -]?me[_ -]?(to[_ -]?)?(decrypt|restore)|decrypt[_ -]?(instructions|files)|restore[_ -]?files)", re.I)


def entropy_of(path, limit=32768):
    try:
        with open(path, "rb") as f:
            b = f.read(limit)
    except OSError:
        return None
    if len(b) < 512:
        return None
    c = collections.Counter(b)
    n = len(b)
    return -sum((v / n) * math.log2(v / n) for v in c.values())


def scan_tree(base, max_files=20000):
    files = {}
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if not (dp == base and d in (".recycle", ".restored"))]
        for n in fn:
            full = os.path.join(dp, n)
            if os.path.islink(full):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, base)
            ent = entropy_of(full)
            files[rel] = [st.st_size, st.st_mtime, round(ent, 3) if ent is not None else None]
            if len(files) >= max_files:
                return files, True
    return files, False


def op_scan_baseline(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    files, trunc = scan_tree(base)
    os.makedirs(SCAN_DIR, exist_ok=True)
    with open("%s/%s.json" % (SCAN_DIR, share), "w", encoding="utf8") as f:
        json.dump({"takenAt": time.time(), "files": files, "truncated": trunc}, f)
    return {"files": len(files), "truncated": trunc}


def op_scan(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    try:
        with open("%s/%s.json" % (SCAN_DIR, share), "r", encoding="utf8") as f:
            baseline = json.load(f)
    except (OSError, ValueError):
        return {"baseline": False}
    old = baseline["files"]
    new, trunc = scan_tree(base)
    added = [r for r in new if r not in old]
    deleted = [r for r in old if r not in new]
    modified = [r for r in new if r in old and (new[r][0] != old[r][0] or abs(new[r][1] - old[r][1]) > 1)]
    stems_old = collections.defaultdict(set)
    for r in old:
        stems_old[os.path.splitext(r)[0]].add(os.path.splitext(r)[1].lower().lstrip("."))
    ext_changed = []
    for r in added:
        stem, ext = os.path.splitext(r)
        e = ext.lower().lstrip(".")
        if e in SUSPICIOUS_EXT or (stem in stems_old and e not in stems_old[stem]) or (os.path.splitext(stem)[1] and os.path.splitext(stem)[0] in old):
            ext_changed.append(r)
    high_entropy = [r for r in modified if new[r][2] is not None and new[r][2] >= 7.5 and (old[r][2] is None or new[r][2] - old[r][2] >= 1.0)]
    notes = [r for r in added if RANSOM_NOTE_RE.search(os.path.basename(r))]
    return {"baseline": True, "baselineAt": baseline["takenAt"], "scannedFiles": len(new), "baselineFiles": len(old), "added": len(added), "deleted": len(deleted), "modified": len(modified), "extensionChanges": len(ext_changed), "highEntropyRewrites": len(high_entropy), "ransomNotes": len(notes), "truncated": trunc, "samples": {"extensionChanges": ext_changed[:10], "highEntropyRewrites": high_entropy[:10], "deleted": deleted[:10], "ransomNotes": notes[:10]}, "measurement": "MEASURED"}


# ------------------------------------------------------------- replication
def op_replicate(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    target = v_name(p["targetName"], "replica")
    if p.get("snapshot"):
        src = snap_dir(reg, share) + "/" + v_snap(p["snapshot"])
    else:
        src = share_dir(reg, share)
    if not os.path.isdir(src):
        raise AgentError("Source not found.", "NOT_FOUND")
    dst = "%s/%s" % (REPLICA_ROOT, target)
    os.makedirs(dst, exist_ok=True)
    started = time.time()
    args = ["rsync", "-aH", "--partial", "--exclude=.recycle", "--exclude=.restored", "--info=stats2"]
    if p.get("delete", True):
        args.append("--delete")
    r = run(args + [src + "/", dst + "/"], timeout=int(p.get("timeoutSec", 900)))
    m = re.search(r"Total transferred file size:\s*([\d,]+)", r.stdout)
    xfer = int(m.group(1).replace(",", "")) if m else None
    f = re.search(r"Number of regular files transferred:\s*([\d,]+)", r.stdout)
    files_xfer = int(f.group(1).replace(",", "")) if f else None
    out = {"targetPath": dst, "bytesTransferred": xfer, "filesTransferred": files_xfer, "seconds": round(time.time() - started, 2)}
    if p.get("verify", True):
        ms = dir_manifest(src)
        mt = dir_manifest(dst)
        out["sourceManifestHash"] = ms["manifestHash"]
        out["targetManifestHash"] = mt["manifestHash"]
        out["verified"] = ms["manifestHash"] == mt["manifestHash"]
        out["fileCount"] = ms["fileCount"]
        out["totalBytes"] = ms["totalBytes"]
    return out


def op_replica_manifest(p):
    target = v_name(p["targetName"], "replica")
    dst = "%s/%s" % (REPLICA_ROOT, target)
    if not os.path.isdir(dst):
        raise AgentError("Replica not found.", "NOT_FOUND")
    m = dir_manifest(dst)
    m.pop("lines")
    return m


def op_replica_delete(p):
    target = v_name(p["targetName"], "replica")
    dst = "%s/%s" % (REPLICA_ROOT, target)
    if os.path.isdir(dst) and within(REPLICA_ROOT, dst):
        shutil.rmtree(dst)
    return {"deleted": True}


def op_replica_tamper(p):
    """Recovery-test helper: corrupt one file in a replica the way bit-rot or
    an attacker would, so tests can prove the manifest check notices."""
    target = v_name(p["targetName"], "replica")
    dst = "%s/%s" % (REPLICA_ROOT, target)
    for dp, dn, fn in os.walk(dst):
        if fn:
            with open(os.path.join(dp, fn[0]), "ab") as f:
                f.write(b"tampered")
            return {"tampered": os.path.relpath(os.path.join(dp, fn[0]), dst)}
    return {"tampered": None}


# ------------------------------------------------------- tiering candidates
def op_tier_candidates(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    base = share_dir(reg, share)
    older = float(p.get("olderThanDays", 90)) * 86400
    min_size = int(p.get("minSizeBytes", 0))
    now = time.time()
    out = []
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if not (dp == base and d in (".recycle", ".restored"))]
        for n in fn:
            full = os.path.join(dp, n)
            if os.path.islink(full):
                continue
            st = os.stat(full)
            age = now - st.st_mtime
            if age >= older and st.st_size >= min_size:
                out.append({"relativePath": os.path.relpath(full, base), "sizeBytes": st.st_size, "ageDays": round(age / 86400, 1), "lastModified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime))})
            if len(out) >= int(p.get("limit", 1000)):
                return {"candidates": out, "truncated": True, "basis": "mtime (DERIVED: relatime makes access time unreliable)"}
    return {"candidates": out, "truncated": False, "basis": "mtime (DERIVED: relatime makes access time unreliable)"}


# ----------------------------------------------------- network / discovery
def op_network_info(p):
    r = run(["ip", "-j", "addr"], check=False)
    ifs = []
    try:
        for i in json.loads(r.stdout):
            if i["ifname"] == "lo":
                continue
            ifs.append({"name": i["ifname"], "addresses": [{"family": a["family"], "address": a["local"], "prefix": a["prefixlen"]} for a in i.get("addr_info", [])]})
    except ValueError:
        pass
    host = run(["hostname"], check=False).stdout.strip()
    return {"hostname": host, "interfaces": ifs, "measurement": "MEASURED"}


def op_set_hostname(p):
    h = p["hostname"]
    if not isinstance(h, str) or not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9-]{0,30}[a-zA-Z0-9])?$", h):
        raise AgentError("Invalid hostname.", "BAD_INPUT")
    run(["hostname", h])
    with open("/etc/hostname", "w", encoding="utf8") as f:
        f.write(h + "\n")
    return {"hostname": h}


def op_mdns_apply(p):
    """Advertise the NAS over mDNS/DNS-SD (avahi) as <hostname>.local."""
    if not have("avahi-daemon"):
        return {"supported": False, "reason": "avahi-daemon is not installed."}
    h = run(["hostname"], check=False).stdout.strip()
    svc = '<?xml version="1.0" standalone="no"?>\n<!DOCTYPE service-group SYSTEM "avahi-service.dtd">\n<service-group>\n <name replace-wildcards="yes">Inaya NAS on %h</name>\n <service><type>_smb._tcp</type><port>445</port></service>\n <service><type>_nfs._tcp</type><port>2049</port></service>\n</service-group>\n'
    os.makedirs("/etc/avahi/services", exist_ok=True)
    with open("/etc/avahi/services/inaya-nas.service", "w", encoding="utf8") as f:
        f.write(svc)
    if p.get("enabled", True):
        run(["service", "avahi-daemon", "restart"], check=False)
    else:
        run(["service", "avahi-daemon", "stop"], check=False)
    active = svc_active("avahi-daemon")
    resolved = None
    if active and have("avahi-resolve"):
        time.sleep(1.5)
        r = run(["avahi-resolve", "-n", h + ".local"], check=False, timeout=10)
        resolved = r.stdout.strip() or None
    return {"supported": True, "active": active, "hostname": h + ".local", "resolvedInsideAppliance": resolved}


# ----------------------------------------------------------- remote access
def op_remote_access_apply(p):
    """Restrict which networks may reach SMB. Only private/loopback/link-local
    networks are accepted -- raw SMB is never exposed to the public Internet."""
    mode = p.get("mode")
    if mode not in ("LOCAL_ONLY", "PRIVATE_NETWORK", "GATEWAY"):
        raise AgentError("mode must be LOCAL_ONLY, PRIVATE_NETWORK or GATEWAY.", "BAD_INPUT")
    nets = [v_client(c) for c in p.get("allowedNetworks", [])]
    for c in nets:
        if not is_private_net(c):
            raise AgentError("%s is not a private network; SMB is never exposed publicly." % c, "PUBLIC_EXPOSURE")
    if mode == "LOCAL_ONLY":
        allowed = ["127.0.0.1", "::1"] + nets
    elif mode == "PRIVATE_NETWORK":
        allowed = nets or ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.1"]
    else:
        allowed = ["127.0.0.1", "::1"]  # gateway access comes through the Inaya gateway process on the box
    with open(SMB_GLOBAL_INCLUDE, "w", encoding="utf8") as f:
        f.write("# managed by inaya-nas-agent (remote access mode: %s)\n   log level = 1 auth:2\n   hosts allow = %s\n   hosts deny = ALL\n" % (mode, " ".join(allowed)))
    ok, err = testparm_ok()
    if not ok:
        with open(SMB_GLOBAL_INCLUDE, "w", encoding="utf8") as f:
            f.write(GLOBAL_DEFAULT)
        raise AgentError("Samba rejected the access policy: %s" % err, "BAD_CONFIG")
    samba_reload()
    reg = load_reg()
    reg["settings"]["remoteAccess"] = {"mode": mode, "allowed": allowed}
    save_reg(reg)
    return {"mode": mode, "allowed": allowed}


def op_remote_access_clear(p):
    with open(SMB_GLOBAL_INCLUDE, "w", encoding="utf8") as f:
        f.write(GLOBAL_DEFAULT)
    samba_reload()
    return {"cleared": True}


# ---------------------------------------------------------------- iSCSI
def op_iscsi_probe(p):
    """Evaluate (not enable) iSCSI target support on this appliance."""
    mods = run(["lsmod"], check=False).stdout
    r = run(["modprobe", "iscsi_target_mod"], check=False)
    mods2 = run(["lsmod"], check=False).stdout
    return {"targetCoreLoaded": "target_core_mod" in mods2, "iscsiTargetLoadable": r.returncode == 0 and "iscsi_target_mod" in mods2, "configfs": is_mounted("/sys/kernel/config"), "targetcliInstalled": have("targetcli"), "note": "Kernel LIO target modules are present; a supported target stack (targetcli-fb) is not installed by default."}


# ------------------------------------------------------------- WORM share
# A WORM dataset is real write-once storage on the appliance filesystem:
# directories become append-only (chattr +a: files can be created but never
# deleted or renamed) and files older than the settle window become immutable
# (chattr +i: no modify, delete, rename or link) until their retention
# expires. This is governance-grade: root on the appliance can still lift the
# flags, so it stops users, ransomware running as a user, and compromised
# share credentials -- not a rogue appliance root.
def worm_path(share):
    return "%s/%s.json" % (WORM_DIR, share)


def worm_load(share):
    try:
        with open(worm_path(share), "r", encoding="utf8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def worm_save(share, st):
    os.makedirs(WORM_DIR, exist_ok=True)
    with open(worm_path(share), "w", encoding="utf8") as f:
        json.dump(st, f)


def op_worm_enable(p):
    share = v_name(p["share"], "share")
    settle = int(p.get("settleMinutes", 1))
    days = float(p.get("retentionDays", 30))
    if not 0 <= settle <= 10080 or not 0.0001 <= days <= 36500:
        raise AgentError("settleMinutes 0..10080, retentionDays > 0.", "BAD_INPUT")
    st = worm_load(share) or {"sealed": {}}
    st.update({"enabled": True, "settleMinutes": settle, "retentionDays": days})
    worm_save(share, st)
    return op_worm_seal({"share": share})


def op_worm_seal(p):
    reg = load_reg()
    share = v_name(p["share"], "share")
    st = worm_load(share)
    if not st or not st.get("enabled"):
        raise AgentError("WORM is not enabled on this share.", "BAD_INPUT")
    base = share_dir(reg, share)
    now = time.time()
    until = now + st["retentionDays"] * 86400
    sealed_now = 0
    dirs = 0
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if not (dp == base and d in (".recycle", ".restored"))]
        run(["chattr", "+a", dp], check=False)
        dirs += 1
        for n in fn:
            full = os.path.join(dp, n)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, base)
            if rel in st["sealed"]:
                continue
            try:
                if now - os.stat(full).st_mtime < st["settleMinutes"] * 60:
                    continue
            except OSError:
                continue
            if run(["chattr", "+i", full], check=False).returncode == 0:
                st["sealed"][rel] = until
                sealed_now += 1
    worm_save(share, st)
    return {"sealedNow": sealed_now, "sealedTotal": len(st["sealed"]), "directoriesProtected": dirs, "retentionUntil": until, "mode": "governance", "measurement": "MEASURED"}


def op_worm_release_expired(p):
    reg = load_reg()
    released = 0
    if not os.path.isdir(WORM_DIR):
        return {"released": 0}
    for fn in os.listdir(WORM_DIR):
        if not fn.endswith(".json"):
            continue
        share = fn[:-5]
        st = worm_load(share)
        if not st:
            continue
        base = share_dir(reg, share)
        for rel, until in list(st["sealed"].items()):
            if until <= time.time():
                target = base + "/" + rel
                if os.path.lexists(target):
                    run(["chattr", "-i", target], check=False)
                del st["sealed"][rel]
                released += 1
        worm_save(share, st)
    return {"released": released}


def op_worm_status(p):
    share = v_name(p["share"], "share")
    st = worm_load(share)
    if not st:
        return {"enabled": False}
    return {"enabled": bool(st.get("enabled")), "settleMinutes": st.get("settleMinutes"), "retentionDays": st.get("retentionDays"), "sealedFiles": len(st.get("sealed", {})), "earliestExpiry": min(st["sealed"].values()) if st.get("sealed") else None, "mode": "governance"}


def op_worm_disable(p):
    share = v_name(p["share"], "share")
    st = worm_load(share)
    if not st:
        return {"disabled": True}
    live = [r for r, u in st.get("sealed", {}).items() if u > time.time()]
    if live and not p.get("override"):
        raise AgentError("%d file(s) are still under retention; disabling WORM needs an explicit override." % len(live), "LOCKED")
    reg = load_reg()
    base = share_dir(reg, share)
    for rel in st.get("sealed", {}):
        target = base + "/" + rel
        if os.path.lexists(target):
            run(["chattr", "-i", target], check=False)
    for dp, dn, fn in os.walk(base):
        run(["chattr", "-a", dp], check=False)
    st["enabled"] = False
    st["sealed"] = {}
    worm_save(share, st)
    return {"disabled": True}


def op_worm_try_tamper(p):
    """Security-test hook: attempt to delete and rewrite a sealed file the way
    a compromised process would, and report what the filesystem prevented."""
    reg = load_reg()
    share = v_name(p["share"], "share")
    st = worm_load(share) or {"sealed": {}}
    base = share_dir(reg, share)
    if not st["sealed"]:
        return {"tested": False}
    rel = sorted(st["sealed"].keys())[0]
    victim = base + "/" + rel
    res = {"file": rel}
    before = sha256_file(victim)
    r = run(["sh", "-c", "echo tamper >> \"$1\"", "sh", victim], check=False)
    res["modify"] = "blocked" if (r.returncode != 0 and sha256_file(victim) == before) else "SUCCEEDED"
    run(["rm", "-f", victim], check=False)
    res["delete"] = "blocked" if os.path.exists(victim) else "SUCCEEDED"
    run(["mv", victim, victim + ".renamed"], check=False)
    res["rename"] = "blocked" if os.path.exists(victim) else "SUCCEEDED"
    return res


# ------------------------------------------------------ rename / failover
def op_share_rename(p):
    old = v_name(p["name"], "share name")
    new = v_name(p["newName"], "new share name")
    reg = load_reg()
    s = reg["shares"].get(old)
    if not s:
        raise AgentError("Share not registered with the agent.", "NOT_FOUND")
    if new in reg["shares"] or os.path.exists("%s/%s.conf" % (SMB_DIR, new)):
        raise AgentError("A share with that name already exists.", "EXISTS")
    spec = dict(s.get("spec") or {})
    spec["name"] = new
    res = op_share_apply({"spec": spec, "backend": s["backend"], "pool": s.get("pool"), "_path": s["path"]})
    reg = load_reg()
    reg["shares"][new] = dict(reg["shares"].get(new, {}), path=s["path"], backend=s["backend"], pool=s.get("pool"), spec=spec)
    reg["shares"].pop(old, None)
    save_reg(reg)
    conf = "%s/%s.conf" % (SMB_DIR, old)
    if os.path.exists(conf):
        os.remove(conf)
    write_shares_include()
    samba_reload()
    return {"renamed": True, "dataPath": s["path"], "newName": new}


def op_replica_promote(p):
    """Serve a replica as a normal share (failover / test failover)."""
    target = v_name(p["targetName"], "replica")
    name = v_name(p["shareName"], "share name")
    owner = v_user(p["owner"])
    src = "%s/%s" % (REPLICA_ROOT, target)
    if not os.path.isdir(src):
        raise AgentError("Replica not found.", "NOT_FOUND")
    reg = load_reg()
    if name in reg["shares"]:
        raise AgentError("A share with that name already exists.", "EXISTS")
    run(["chown", "-R", owner + ":nogroup", src], check=False)
    spec = {"name": name, "owner": owner, "readOnly": bool(p.get("readOnly")), "recycle": {"enabled": True}}
    ensure_samba_layout()
    conf_path = "%s/%s.conf" % (SMB_DIR, name)
    with open(conf_path, "w", encoding="utf8") as f:
        f.write(render_conf(spec, src))
    write_shares_include()
    ok, err = testparm_ok()
    if not ok:
        os.remove(conf_path)
        write_shares_include()
        raise AgentError("Samba rejected the failover share: %s" % err, "BAD_CONFIG")
    samba_reload()
    reg["shares"][name] = {"backend": "dir", "pool": None, "path": src, "spec": spec, "updatedAt": int(time.time()), "promotedFrom": target}
    save_reg(reg)
    return {"dataPath": src, "shareName": name, "readOnly": bool(p.get("readOnly"))}


# ------------------------------------------------------ auth / connectivity
def op_auth_failures(p):
    """Count failed SMB logons in the Samba logs within a window -- the
    'repeated failed access' threat signal (MEASURED from log lines)."""
    minutes = int(p.get("sinceMinutes", 15))
    cutoff = time.time() - minutes * 60
    pat = re.compile(r"\[(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})[.,]\d+.*?authentication for user \[([^\]]*)\].*?(NT_STATUS_[A-Z_]+)")
    pat2 = re.compile(r"\[(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})[.,]\d+.*?Denied connection from|.*?(NT_STATUS_WRONG_PASSWORD|NT_STATUS_ACCOUNT_LOCKED_OUT|NT_STATUS_LOGON_FAILURE)")
    failures = collections.Counter()
    total = 0
    logdir = "/var/log/samba"
    if os.path.isdir(logdir):
        for n in os.listdir(logdir):
            if not n.startswith("log."):
                continue
            try:
                with open(logdir + "/" + n, "r", encoding="utf8", errors="replace") as f:
                    for line in f.readlines()[-4000:]:
                        m = pat.search(line)
                        if not m or "FAILED" not in line.upper() and "NT_STATUS_OK" in line:
                            continue
                        if m.group(3) == "NT_STATUS_OK":
                            continue
                        try:
                            ts = time.mktime(time.strptime(m.group(1), "%Y/%m/%d %H:%M:%S"))
                        except ValueError:
                            continue
                        if ts >= cutoff:
                            failures[m.group(2) or "unknown"] += 1
                            total += 1
            except OSError:
                continue
    return {"windowMinutes": minutes, "failedLogons": total, "byUser": dict(failures), "measurement": "MEASURED"}


def op_net_probe(p):
    """Can this appliance reach a host:port? (control-plane connectivity)"""
    import socket
    host = p["host"]
    port = int(p.get("port", 443))
    if not isinstance(host, str) or not HOST_RE.match(host) or not 1 <= port <= 65535:
        raise AgentError("Invalid probe target.", "BAD_INPUT")
    t0 = time.time()
    try:
        with socket.create_connection((host, port), timeout=float(p.get("timeoutSec", 4))):
            return {"reachable": True, "latencyMs": int((time.time() - t0) * 1000), "measurement": "MEASURED"}
    except OSError as e:
        return {"reachable": False, "error": type(e).__name__, "measurement": "MEASURED"}


# --------------------------------------------------------------- self
def op_version(p):
    try:
        me = sha256_file(os.path.realpath(__file__))
    except OSError:
        me = None
    caps = {t: have(t) for t in ("mdadm", "mkfs.btrfs", "btrfs", "setfacl", "chattr", "setquota", "smartctl", "avahi-daemon", "rsync", "pdbedit", "smbstatus", "exportfs", "targetcli")}
    kernel = run(["uname", "-r"], check=False).stdout.strip()
    return {"agentVersion": AGENT_VERSION, "agentSha256": me, "python": sys.version.split()[0], "kernel": kernel, "capabilities": caps}


def op_disk_usage(p):
    reg = load_reg()
    share = p.get("share")
    path = share_dir(reg, v_name(share, "share")) if share else NAS_ROOT
    u = shutil.disk_usage(path)
    return {"totalBytes": u.total, "usedBytes": u.used, "availBytes": u.free, "measurement": "MEASURED"}


def op_registry(p):
    reg = load_reg()
    return {"pools": reg["pools"], "shares": {k: {kk: vv for kk, vv in v.items() if kk != "spec"} for k, v in reg["shares"].items()}, "volumes": reg["volumes"], "settings": reg["settings"]}


def op_config_backup(p):
    """Snapshot of the appliance's own configuration (Workstream Z)."""
    reg = load_reg()
    files = {}
    for path in (SMB_CONF, SMB_SHARES_INCLUDE, SMB_GLOBAL_INCLUDE):
        if os.path.exists(path):
            with open(path, "r", encoding="utf8") as f:
                files[path] = f.read()
    if os.path.isdir(SMB_DIR):
        for n in sorted(os.listdir(SMB_DIR)):
            with open(SMB_DIR + "/" + n, "r", encoding="utf8") as f:
                files[SMB_DIR + "/" + n] = f.read()
    if os.path.isdir(EXPORTS_DIR):
        for n in sorted(os.listdir(EXPORTS_DIR)):
            with open(EXPORTS_DIR + "/" + n, "r", encoding="utf8") as f:
                files[EXPORTS_DIR + "/" + n] = f.read()
    blob = json.dumps({"registry": reg, "files": files}, sort_keys=True)
    dest = STATE_DIR + "/config-backups"
    os.makedirs(dest, exist_ok=True)
    name = "config-%d.json" % int(time.time())
    with open(dest + "/" + name, "w", encoding="utf8") as f:
        f.write(blob)
    return {"backup": name, "sha256": hashlib.sha256(blob.encode()).hexdigest(), "bytes": len(blob)}


def op_config_fingerprint(p):
    reg = load_reg()
    shares = {}
    for name, s in sorted(reg["shares"].items()):
        shares[name] = {"backend": s["backend"], "pool": s.get("pool"), "spec": s.get("spec")}
    payload = {"pools": {k: {"level": v["level"], "memberSizeMb": v.get("memberSizeMb")} for k, v in sorted(reg["pools"].items())}, "shares": shares, "volumes": {k: v["sizeMb"] for k, v in sorted(reg["volumes"].items())}, "remoteAccess": reg["settings"].get("remoteAccess")}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return {"fingerprint": hashlib.sha256(blob.encode()).hexdigest(), "shareCount": len(shares), "poolCount": len(reg["pools"])}


OPS = {k[3:]: v for k, v in globals().items() if k.startswith("op_") and callable(v)}

BOOT_MARKER = "/run/inaya-nas.online"


def boot_ensure():
    """After an appliance (re)start, loop devices, md arrays and mounts are
    gone. The first agent call of a boot brings the appliance back to its
    configured state (pools mounted, quota volumes mounted, Samba/NFS up)
    before doing anything else, and reports that it did."""
    if os.path.exists(BOOT_MARKER):
        return None
    try:
        res = op_ensure_online({})
    except Exception as e:  # never block the requested op on a recovery hiccup
        res = {"error": type(e).__name__}
    try:
        with open(BOOT_MARKER, "w", encoding="utf8") as f:
            f.write(str(time.time()))
    except OSError:
        pass
    return res


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: inaya-nas-agent.py <request.json>", "code": "USAGE"}))
        return 2
    req_path = sys.argv[1]
    if not TEMP_RE.match(req_path) and not req_path.startswith(STATE_DIR + "/"):
        print(json.dumps({"ok": False, "error": "request file must be an approved Inaya temp file", "code": "BAD_INPUT"}))
        return 2
    try:
        with open(req_path, "r", encoding="utf8") as f:
            req = json.load(f)
        op = req.get("op")
        if op not in OPS:
            raise AgentError("Unknown operation %r." % (op,), "UNKNOWN_OP")
        boot = boot_ensure() if op not in ("version", "ensure_online") else None
        result = OPS[op](req.get("params") or {})
        out = {"ok": True, "result": result}
        if boot is not None:
            out["bootRecovery"] = boot
        print(json.dumps(out))
        return 0
    except AgentError as e:
        print(json.dumps({"ok": False, "error": str(e), "code": e.code}))
        return 1
    except (KeyError, TypeError, ValueError) as e:
        print(json.dumps({"ok": False, "error": "Bad request: %s" % e, "code": "BAD_INPUT"}))
        return 1
    except OSError as e:
        print(json.dumps({"ok": False, "error": "Filesystem refused the operation: %s" % (e.strerror or type(e).__name__), "code": "FS_ERROR", "errno": e.errno}))
        return 1
    except Exception as e:  # never leak a traceback with paths/secrets
        print(json.dumps({"ok": False, "error": "Agent error: %s" % type(e).__name__, "code": "INTERNAL"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
