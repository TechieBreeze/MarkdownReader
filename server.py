#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Markdown Reader 本地服务
========================
简易 markdown 阅读辅助工具后端：
  - /api/list     目录列表（文件树）
  - /api/markdown 读取 markdown 内容
  - /api/code     读取任意代码文件（前端按行号高亮）
  - /api/raw      读取任意文件（图片等资源代理）
  - /api/save     POST 保存文件（代码编辑）
  - /             前端页面 index.html（含 vendor/ 静态资源）

启动：  python server.py [--port 8765]
打开：  http://127.0.0.1:8765/
"""
import functools
import hashlib
import itertools
import json
import threading
import mimetypes
import os
import re
import subprocess
import sys
import time as _time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote

# javalang AST 解析（0.13.0 vendored 在 vendor_py/；Hermes 自带 python 无 pip 时走 sys.path）
try:
    from javalang.parse import parse as _java_parse_fn
    from javalang import tree as _jt
except ImportError:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor_py"))
    from javalang.parse import parse as _java_parse_fn
    from javalang import tree as _jt

# 外部/框架包前缀：类型或父类落到这些包 → 无本地定义（fastjson / MyBatis-Plus / Spring / java.* 等）
JAVA_EXT_PKG_PREFIXES = (
    "java.", "javax.", "jdk.", "sun.", "com.baomidou", "com.alibaba", "org.", "com.github",
    "lombok", "io.", "cn.", "com.fasterxml", "org.mybatis",
)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import web_defs  # noqa: E402  （JS/TS/Vue 定义跳转解析，与本模块同目录）
# 工作区根目录 = 本文件上两级（tools/markdown-reader -> 工作区根）
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
# 多根支持（"项目"层）：ROOTS 可含多个工作区根，浏览器端用 vtop（根目录名）作
# 虚拟顶层前缀区分：<vtop>/gits/...。单根时 vtop 前缀省略（保持旧路径兼容）。
ROOTS = [ROOT]
_VTOP = {}          # vtop 名 -> 绝对路径（同名根自动追加 _2/_3）
_VTOP_SEQ = {}      # 根路径 -> 分配名
_CURRENT = None     # 前端"当前项目"（vtop 名）；None = 顶层聚合展示全部项目
PROJECTS_FILE = os.path.join(HERE, "projects.json")   # 项目管理持久化（add/remove 落盘）
# 同步配置（内置默认值 + 可被 sync.json 覆盖）。解决「我在服务器上开发、你在公司电脑上手动同步」：
# 服务器 push 到远端后，公司电脑上点「检查更新」→ git pull 拿到最新代码。
# 地址写死在代码里当默认值（换机器不用配），真要改就写 sync.json（已 gitignore）。
# 默认用 SSH 地址而不是 HTTPS：HTTPS 在没配凭据的机器上会直接
# "could not read Username for 'https://github.com'"，而 SSH 只需一把
# 部署密钥（github 的 Settings → SSH keys）。Windows 建议用 Git Bash 自带的
# ssh 或 Git for Windows 的 bundled OpenSSH；没配 SSH 的机器写 sync.json
# 覆盖成 HTTPS + Personal Access Token 也行。
DEFAULT_SYNC_REPO = "git@github.com:TechieBreeze/MarkdownReader.git"
DEFAULT_SYNC_BRANCH = "master"
SYNC_FILE = os.path.join(HERE, "sync.json")
# 项目增删切的互斥锁：ThreadingHTTPServer 多线程下，ROOTS/_VTOP/_CURRENT 是
# 模块级可变状态，读-改-写必须串行，否则并发 add/remove 会丢失更新。
_PROJECTS_LOCK = threading.RLock()
PORT = 8765

# mermaid 服务端渲染：SVG 缓存目录 + 批量渲染脚本（浏览器内跑 mermaid 会吃满 CPU）
MMD_CACHE_DIR = os.path.join(HERE, ".mmd-cache")
MMD_BATCH_SCRIPT = os.path.join(HERE, "render-mermaid-batch.js")
_MMD_LOCK = None  # 渲染锁（进程内），避免并发重复渲染

CODE_EXTS = {
    ".java", ".xml", ".py", ".js", ".ts", ".jsx", ".tsx", ".sql", ".yml", ".yaml",
    ".json", ".properties", ".sh", ".bat", ".cmd", ".gradle", ".html", ".css",
    ".txt", ".md", ".kt", ".go", ".c", ".cpp", ".h", ".vue", ".ini", ".cfg",
}

# 快速打开 / 文件树可打开的资源类文件扩展名
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"}

# 搜索用：项目根 → 可搜索文本文件数。_api_search 按项目规模给扫描预算
# （各项目规模差一个量级：微服务 ~3900 / baseline ~18800，固定上限会让大项目
# 永远扫不到结果）。项目增删时随 _invalidate_gits_cache 一并清空。
_SCAN_COUNT_CACHE = {}


def _invalidate_gits_cache():
    """清空 gits 仓库扫描缓存与搜索文件数缓存。

    必须由 _setup_roots 调用：_all_git_repos 把结果缓存在模块级 _GITS_REPOS、
    _scan_budget 把文件数缓存在 _SCAN_COUNT_CACHE，而项目可以在运行期增删
    （/api/projects add|remove），不失效的话新增项目的仓库永远搜不到、
    被删项目的仓库还会继续命中，搜索预算也会按旧规模算错。
    """
    _SCAN_COUNT_CACHE.clear()
    global _GITS_REPOS
    _GITS_REPOS = None
    for fn in (_git_tree_files,):
        fn.cache_clear()


def _setup_roots(roots):
    """根据根目录列表构建多根路由：_VTOP 分配（同名加 _2/_3 序号）。"""
    global ROOTS, ROOT
    ROOTS = [os.path.abspath(r) for r in roots]
    if not ROOTS:
        ROOTS = [ROOT]
    ROOT = ROOTS[0]
    _VTOP.clear()
    _VTOP_SEQ.clear()
    used = set()
    for r in ROOTS:
        name = os.path.basename(os.path.normpath(r)) or "workspace"
        base = name
        n = 2
        while base in used:
            base = f"{name}_{n}"
            n += 1
        used.add(base)
        _VTOP[base] = r
        _VTOP_SEQ[r] = base
    if _CURRENT and _CURRENT not in _VTOP:
        globals()["_CURRENT"] = None   # 当前项目已被移除/失效 → 回聚合
    # 根列表变了 → gits 仓库扫描缓存必须失效，否则新项目搜不到 / 已删项目仍命中
    _invalidate_gits_cache()


def _load_project_roots(cli_roots):
    """启动根列表 = CLI --roots 参数 ∪ projects.json 持久化列表（去重，保留顺序）。"""
    roots = list(cli_roots)
    if os.path.isfile(PROJECTS_FILE):
        try:
            with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            # 不静默：projects.json 坏掉时用户会以为项目全没了，必须能看出原因。
            # 同时备份坏文件，避免下一次保存把现场覆盖掉。
            print("[projects] 读取失败（已忽略该文件中的项目列表）: %s" % e)
            try:
                bak = PROJECTS_FILE + ".broken"
                if not os.path.exists(bak):
                    os.replace(PROJECTS_FILE, bak)
                    print("[projects] 原文件已备份为 %s" % os.path.basename(bak))
            except OSError:
                pass
            data = {}
        for r in ((data or {}).get("roots") or []):
            rp = os.path.abspath(r)
            if rp not in [os.path.abspath(x) for x in roots]:
                roots.append(rp)
        cur = (data or {}).get("current")
        if cur:
            globals()["_CURRENT"] = cur
    return roots


def _save_project_roots():
    """把当前 ROOTS + 当前项目写回 projects.json（项目管理 add/remove 落盘）。

    先写临时文件再原子替换：直接写目标文件时，进程中途崩溃/磁盘满会留下
    半截 JSON，下次启动 _load_project_roots 读失败被 except 吞掉 →
    用户全部项目静默消失。原子替换保证 projects.json 要么是旧的完整内容、
    要么是新的完整内容，不会出现「被截断的半份」。
    """
    data = {"roots": list(ROOTS), "current": _CURRENT}
    tmp = PROJECTS_FILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, PROJECTS_FILE)      # 同目录内原子替换
        return True
    except Exception as e:
        print("[projects] 保存失败（项目列表可能未持久化）: %s" % e)
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False


def _scan_budget(search_roots):
    """按被搜项目的可搜索文件数给扫描预算：1.3 倍，留余量。

    文件数统计本身要遍历目录，故按根缓存；项目目录树变动不频繁，
    进程重启后自然刷新（与 _GITS_REPOS 缓存同一策略）。
    """
    total = 0
    for r in search_roots:
        if r not in _SCAN_COUNT_CACHE:
            n = 0
            stack = [r]
            while stack:
                d = stack.pop()
                try:
                    entries = os.scandir(d)
                except OSError:
                    continue
                for e in entries:
                    try:
                        isd = e.is_dir(follow_symlinks=False)
                    except OSError:
                        continue
                    if isd:
                        if not is_ignored(e.name):
                            stack.append(e.path)
                        continue
                    if is_searchable_text(e.name):
                        n += 1
            _SCAN_COUNT_CACHE[r] = n
        total += _SCAN_COUNT_CACHE[r]
    return max(6000, int(total * 1.3))


def _roots_for_project_arg(qs, default_all=False):
    """按 project 参数选根：__all__ 全给，指定 vtop 给那个，缺省给当前项目。

    搜索 / Git 仓库列表 共用，保证「项目隔离」语义一致
    （都缺省当前项目、都只在显式 __all__ 时跨项目）。"""
    project = (qs.get("project") or [""])[0].strip()
    if project == "__all__":
        return list(ROOTS)
    if project and project in _VTOP:
        return [_VTOP[project]]
    if default_all:
        return list(ROOTS)
    cur = _current_project_name()
    return [_VTOP[cur]] if cur in _VTOP else list(ROOTS[:1])


def _current_project_name():
    """projects.json 里标记的当前项目 vtop 名；读不到返回 None。"""
    if not os.path.isfile(PROJECTS_FILE):
        return None
    try:
        with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
            cur = json.load(f).get("current")
        return cur if cur in _VTOP else None
    except Exception:
        return None


def _root_for(rel: str):
    """rel 带 vtop 前缀 → 对应根绝对路径；无前缀/找不到 → ROOTS[0]。"""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    first = rel.split("/", 1)[0]
    if first in _VTOP:
        return _VTOP[first]
    return ROOTS[0]


def _vtop_of(abs_root: str):
    return _VTOP_SEQ.get(os.path.abspath(abs_root)) or _VTOP_SEQ.get(ROOTS[0], "")


def _root_real(root_or_vtop: str):
    """根目录的真实路径（接受 vtop 名或路径本身）。

    比较一律用 realpath 归一：Windows 下根路径本身可能是 junction/大小写/短路径，
    不归一会让 startswith 判断误判为越界（或漏判真实越界）。
    """
    return os.path.realpath(_VTOP.get(root_or_vtop) or root_or_vtop)


def _within(path: str, root: str) -> bool:
    """path 是否等于 root 或位于 root 之下（realpath 已归一、大小写不敏感）。

    两侧都 realpath：junction/symlink 指向根外时 realpath 会暴露真实目标，
    这样才能拦住「根内的软链指向根外」的越界读取。
    """
    if not path or not root:
        return False
    p = os.path.normcase(os.path.realpath(path))
    r = os.path.normcase(os.path.realpath(root))
    return p == r or p.startswith(r + os.sep)


def safe_path(rel: str):
    """把相对根目录的路径规范化为绝对路径；越界/不存在返回 None。
    多根：rel 以 <vtop>/ 开头时路由到对应根；否则逐根尝试（兼容旧无前缀路径）。"""
    if not rel:
        return None
    rel = rel.replace("\\", "/").lstrip("/")
    if not rel:
        return None
    first = rel.split("/", 1)[0]
    if first in _VTOP:
        p = os.path.realpath(os.path.join(_VTOP[first], rel[len(first) + 1:] if "/" in rel else ""))
        root = _root_real(first)
        if not _within(p, root):
            return None
        return p
    # 绝对路径：归属包含它的根
    if os.path.isabs(rel):
        p = os.path.realpath(rel)
        for r in ROOTS:
            if _within(p, _root_real(r)):
                return p
        return None
    # 相对路径（无 vtop 前缀，旧文档/单根场景）：逐根尝试，命中第一个存在的
    for r in ROOTS:
        rp = _root_real(r)
        p = os.path.realpath(os.path.join(rp, rel))
        if not _within(p, rp):
            continue
        if os.path.exists(p):
            return p
    return None


def rel_of(abs_path: str):
    """绝对路径 → 带 vtop 前缀的相对路径（多根）；单根且属于默认根时省略前缀（兼容旧路径）。"""
    ap = os.path.abspath(abs_path)
    for r in ROOTS:
        rp = _root_real(r)
        # 用 _within 判定（两侧 realpath + normcase），否则根本身是 junction 时
        # rp 与 ap 前缀对不上，会误判「不属于任何根」而错误地 relpath 到 ROOTS[0]
        if _within(ap, rp):
            if _root_real(ap) == rp:
                return _vtop_of(r) if len(ROOTS) > 1 else ""
            rel = os.path.relpath(_root_real(ap), rp).replace("\\", "/")
            return (_vtop_of(r) + "/" + rel) if len(ROOTS) > 1 else rel
    return os.path.relpath(ap, _root_real(ROOTS[0])).replace("\\", "/")


def is_ignored(name: str):
    return name in (".git", ".idea", "node_modules", "__pycache__", ".mvn", "target") or name.startswith(".")


def is_searchable_text(name: str):
    """全局搜索只扫文本类文件：扩展名在代码/文档白名单内（CODE_EXTS），排除二进制/资源。"""
    ext = os.path.splitext(name)[1].lower()
    return ext in CODE_EXTS


def log_line(msg: str):
    """性能/行为日志 → $LOCALAPPDATA/Temp/mdreader.log（用户跑起来后助手读该文件定位卡顿）"""
    try:
        log_path = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Temp", "mdreader.log")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S.%f")[:-3], msg))
    except Exception:
        pass


# ================= 同步（服务器开发 → 本机拉取） =================
#
# 场景：我在服务器上改代码并 push，用户在公司电脑上跑着这份工具。想把最新版本拿过来，
# 但用户不想学 git 命令，也不想改远程地址。所以：
#   1. 远程地址内置默认值（DEFAULT_SYNC_REPO），可被 sync.json 覆盖；
#   2. 前端「检查更新」先 fetch 看看远端有没有新 commit（有就把提交列出来）；
#   3. 用户点「拉取更新」才真正执行 git pull —— 破坏性操作永远由人点一下确认。

def sync_config():
    """读同步配置：sync.json 覆盖默认值。文件坏了不致命，回落到默认值并说明原因。"""
    cfg = {"repo": DEFAULT_SYNC_REPO, "branch": DEFAULT_SYNC_BRANCH, "source": "default"}
    if os.path.isfile(SYNC_FILE):
        try:
            with open(SYNC_FILE, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            if isinstance(data, dict):
                if data.get("repo"):
                    cfg["repo"] = str(data["repo"]).strip()
                if data.get("branch"):
                    cfg["branch"] = str(data["branch"]).strip()
                cfg["source"] = "sync.json"
        except Exception as e:
            cfg["error"] = "sync.json 读取失败（已用内置默认值）: %s" % e
    err = _validate_sync_cfg(cfg)
    if err:
        cfg["error"] = ((cfg["error"] + "\n") if cfg.get("error") else "") + err
    return cfg


def _validate_sync_cfg(cfg):
    """校验仓库地址/分支，返回错误说明或 None。

    这些值会原样进 git 的 argv（fetch / pull / remote set-url），而 git 会把
    **位置参数里以 - 开头的值当成选项**：实测
    `git pull --ff-only origin --upload-pack=/bin/echo master` 里
    `--upload-pack=...` 被当选项解析、branch 名根本没起作用。
    sync.json 又是用户可编辑的文件，所以这里必须挡一道，不能让配置变成
    给 git 传选项的通道。"""
    repo = (cfg.get("repo") or "").strip()
    branch = (cfg.get("branch") or "").strip()
    if not repo or not branch:
        return "同步配置不完整：repo / branch 不能为空"
    if repo.startswith("-"):
        return "仓库地址不能以 - 开头（会被 git 当成命令行选项）"
    if branch.startswith("-"):
        return "分支名不能以 - 开头（会被 git 当成命令行选项）"
    if re.search(r"\s", repo) or re.search(r"\s", branch):
        return "仓库地址和分支名不能包含空格"
    # ext:: / fd:: 这类 transport 能直接执行本地命令。git 默认禁 ext，
    # 但用户若显式 protocol.ext.allow=always 就会生效 —— 配置层直接禁掉。
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*::", repo):
        return "不支持 ext::/file:// 之类的自定义 transport，只接受 https/http/ssh/git 仓库地址"
    # 允许本地路径（/path/to/repo.git、./rel、~/dir）—— 本地镜像/离线仓库很常见，
    # 上一版校验把它们全拒了，等于把「用本地 bare 仓库当 origin」这种正当用法堵死。
    # 判据：以 ~ 或 / 或 . 开头，且不含空白 → 视为本地路径，放行。
    if repo.startswith(("~", "/", "./", "../")) or repo == "." or repo == "..":
        return None
    if not re.match(r"^(https?|ssh|git)://", repo) and not re.match(r"^[^/]+@[^/]+:", repo):
        return "仓库地址需以 https://、http://、ssh://、git:// 开头，形如 git@host:path，或为本地路径"
    return None


def _sync_repo_state(cfg):
    """当前仓库自身的位置与远端配置。"""
    repo = HERE                      # 工具目录就是 git 仓库根（server.py 与 .git 同级）
    if not os.path.isdir(os.path.join(repo, ".git")):
        return {"error": "当前目录不是 git 仓库（缺少 .git）: " + repo}
    remotes = {}
    rc, out, _ = git_run_ex(repo, "remote")
    if rc == 0:
        for line in out.splitlines():
            line = line.strip()
            if line:
                remotes[line] = True
    return {
        "path": repo,
        "remotes": sorted(remotes.keys()),
        "want": cfg["repo"],
        "branch": cfg["branch"],
        "configError": cfg.get("error"),
    }


def _ensure_remote(cfg, state):
    """让 remote origin 指向配置的地址。

    直接改配置而不动工作区：远端地址换主机（服务器内网 → 公司电脑 / 反过来）时，
    用户的 origin 还指向 clone 时的地址，fetch 会失败或拉错仓库。
    已有 origin 时就地改写；没有则新增。只动 remote 不会丢任何本地修改。

    配置非法时**不改** —— 否则一个手滑写错的 sync.json 会把 .git/config
    改成一个危险地址并留在那里。"""
    want = cfg["repo"]
    if _validate_sync_cfg(cfg):
        return None            # 配置有问题：不动 remote，把错误交给上层显示
    if "origin" in state["remotes"]:
        rc, cur, _ = git_run_ex(state["path"], "remote", "get-url", "origin")
        if rc == 0 and cur.strip() == want:
            return None
        rc, _, err = git_run_ex(state["path"], "remote", "set-url", "origin", want)
        if rc != 0:
            return "设置 origin 失败: %s" % err
        return "origin 已从 %s 改写为 %s" % (cur.strip() or "(空)", want)
    rc, _, err = git_run_ex(state["path"], "remote", "add", "origin", want)
    if rc != 0:
        return "添加 origin 失败: %s" % err
    return "已添加 origin: %s" % want


def _ahead_behind(repo, branch):
    """本地相对远端领先/落后多少个 commit。拿不到就返回 None（首次同步尚无上游）。"""
    rc, out, _ = git_run_ex(repo, "rev-list", "--left-right", "--count", "origin/%s...HEAD" % branch)
    if rc != 0:
        return None
    parts = out.split()
    if len(parts) != 2:
        return None
    try:
        return {"behind": int(parts[0]), "ahead": int(parts[1])}
    except ValueError:
        return None


def _local_head(repo):
    rc, out, _ = git_run_ex(repo, "rev-parse", "--short", "HEAD")
    return out if rc == 0 and out else None


def _dirty_files(repo):
    """未提交改动 —— 只算已跟踪文件的修改。

    `git status --porcelain` 会把未跟踪文件也列成 `?? xxx`，而未跟踪文件
    **不会**让 pull 失败（只要不与远端新增的同名文件撞名）。实测：整个目录全是
    `??` 时 `--ff-only` pull 照样成功。原实现把它们算进 dirty，于是刚装好、
    还没提交任何东西的新机器会被误判成「有未提交修改」而永远拉不了更新。
    返回 (tracked_changes, untracked_count) 以便前端分别提示。"""
    rc, out, _ = git_run_ex(repo, "status", "--porcelain")
    if rc != 0:
        return None, 0
    tracked, untracked = [], 0
    for ln in out.splitlines():
        if not ln.strip():
            continue
        code = ln[:2]
        if code == "??":
            untracked += 1
        else:
            tracked.append(ln)
    return tracked, untracked


# 从 merge/常规提交信息里取短描述，用不上时回落到 "短哈希 说明"
def _commits_since(repo, branch, limit=30):
    """待拉取的提交（远端有、本地没有的那些）。

    `A..B` 的语义是「B 有而 A 没有的」，所以这里必须写 HEAD..origin/<branch>。
    写成 origin/<branch>..HEAD 会列出「本地领先的提交」——正好是反的，
    结果是 behind 显示 1、待更新列表却是空的。"""
    rc, out, err = git_run_ex(repo, "log", "--pretty=format:%h%x09%s", "-n", str(limit),
                              "HEAD..origin/%s" % branch)
    if rc != 0:
        return None, err
    items = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 1)
        items.append({"sha": parts[0], "msg": parts[1] if len(parts) > 1 else ""})
    return items, None


def _sync_git(repo, *args, timeout=120):
    """同步专用的 git 调用：失败时用 HTTP/2 再试一次。

    实测这台机器上 `git fetch` 走 HTTP/1.1 会 GnuTLS recv error (-110)，
    而 `-c http.version=HTTP/2` 同一地址同一时刻能成功。只在失败后重试，
    正常路径不多付代价；用 `-c` 传参而不是改用户的 git 全局配置，
    免得把别人的环境改了（这条路径只在同步功能里用，范围可控）。"""
    rc, out, err = git_run_ex(repo, *args, timeout=timeout)
    if rc == 0:
        return rc, out, err
    looks_network = any(k in (err or "") for k in
                        ("GnuTLS", "TLS", "SSL", "connection was non-properly terminated",
                         "early EOF", "RPC failed", "Could not resolve", "Connection reset",
                         "unable to access", "timed out"))
    if not looks_network:
        return rc, out, err
    rc2, out2, err2 = git_run_ex(repo, "-c", "http.version=HTTP/2", *args, timeout=timeout)
    if rc2 == 0:
        return 0, out2, err2
    # 两次都失败：两次的错误都要给用户看。原来这行写成
    # `((err2 or err2 == "") and err) or err2` 是个恒真表达式 —— 只要第一次
    # 的 err 非空就必然返回它、重试信息被无声丢弃，注释里承诺的
    # 「把重试信息附上」根本没发生。
    parts = [e for e in ((err or "").strip(), (err2 or "").strip()) if e]
    seen, merged = set(), []
    for e in parts:
        if e not in seen:
            seen.add(e)
            merged.append(e)
    return rc2, (out2 or out), ("\n（HTTP/2 重试后仍然失败）\n".join(merged) if merged else "未知错误")


def sync_status(fetch=False):
    """检查更新：返回远端状态 + 待拉取提交列表。不改动工作区（除非显式 fetch）。"""
    cfg = sync_config()
    st = _sync_repo_state(cfg)
    if st.get("error"):
        return {"ok": False, "error": st["error"], "config": cfg}
    repo = st["path"]

    # 只读请求（不 fetch）不改 .git/config —— 「打开面板看状态」这种纯读操作
    # 不该留下持久化的配置改动，那既超出用户预期也违背本函数的文档承诺。
    # 需要纠正 origin 的只有真正联网的那次（fetch=1）与 sync_pull。
    note = _ensure_remote(cfg, st) if fetch else None
    fetched = False
    fetch_error = None
    if fetch:
        # 必须 fetch 远端**名**而不是 URL：`git fetch <url>` 只写 FETCH_HEAD，
        # 不更新 refs/remotes/origin/master，于是后面 _ahead_behind 永远读到 clone
        # 时的旧值，behind 恒为 0 —— 用户点了「检查更新」永远显示「已是最新」。
        rc, _, err = _sync_git(repo, "fetch", "--prune", "origin", timeout=120)
        fetched = rc == 0
        if rc != 0:
            fetch_error = err or "fetch 失败（返回码 %d）" % rc

    head = _local_head(repo)
    branch = cfg["branch"]
    cur_branch = None
    rc, out, _ = git_run_ex(repo, "rev-parse", "--abbrev-ref", "HEAD")
    if rc == 0 and out:
        cur_branch = out

    ab = _ahead_behind(repo, branch) if fetched else None
    pending, perr = (None, None)
    if fetched and not fetch_error:
        pending, perr = _commits_since(repo, branch)
    tracked, untracked = _dirty_files(repo)

    # behind/ahead 在没联网时是「未知」，不是 0。返回 0 会让前端据此显示
    # 「已是最新」—— 那是编造的结论。没数据就给 null。
    result = {
        "ok": fetch_error is None,
        "config": cfg,
        "repo": repo,
        "branch": branch,
        "currentBranch": cur_branch,
        "head": head,
        "remotes": st["remotes"],
        "fetched": fetched,
        "fetchError": fetch_error,
        "aheadBehind": ab,
        "behind": (ab or {}).get("behind"),
        "ahead": (ab or {}).get("ahead"),
        "pending": pending,
        "pendingError": perr,
        "dirty": tracked,
        "untracked": untracked,
        "note": note,
        "configError": cfg.get("error") or st.get("configError"),
    }
    return result


def sync_pull():
    """真正执行拉取。这是破坏性操作（会改工作区文件），只由前端按钮显式触发。

    先检查脏文件：有未提交修改时 git pull 可能直接失败或产生难解的冲突，
    这里明确拦下来告诉用户，而不是让 git 自己报错。"""
    cfg = sync_config()
    st = _sync_repo_state(cfg)
    if st.get("error"):
        return {"ok": False, "error": st["error"]}
    repo = st["path"]

    note = _ensure_remote(cfg, st)
    dirty, _untracked = _dirty_files(repo)
    if dirty is None:
        # git status 自己失败了 → 状态未知。绝不能当成「干净」直接放行 pull：
        # 这正好是「有未提交修改时拦截」要防的情况，宁可拦住也不能瞎拉。
        return {"ok": False, "error": "无法读取 git 工作区状态（git status 失败），已中止拉取。"
                                  "请在工具目录手动执行 git status 确认。"}
    if dirty:
        return {"ok": False, "needCommit": True, "dirty": dirty[:50],
                "error": "有 %d 处未提交的本地修改，直接拉取可能冲突。请先处理后再试。" % len(dirty)}

    # 拉取前记下当前 HEAD，出问题可以据此告诉你退回到哪个版本
    before = _local_head(repo)
    rc, _, err = _sync_git(repo, "fetch", "--prune", "origin", timeout=120)
    if rc != 0:
        return {"ok": False, "error": "获取远端失败: %s" % (err or "未知错误")}

    ab = _ahead_behind(repo, cfg["branch"])
    if ab is None:
        # 拿不到领先/落后（分支在远端不存在、或还没有上游）→ 直接拉会报
        # 难懂的 "couldn't find remote ref"。这里提前说清楚。
        return {"ok": False, "head": before,
                "error": "无法比较本地与远端：远端可能没有分支「%s」。"
                         "请确认 sync.json 里的 branch 写对了。" % cfg["branch"]}
    if ab["behind"] == 0:
        return {"ok": True, "changed": False, "head": before, "headBefore": before,
                "note": note, "message": "已经是最新，无需更新。"}

    rc, out, err = _sync_git(repo, "pull", "--ff-only", "origin", cfg["branch"], timeout=120)
    if rc != 0:
        msg = (err or out or "未知错误")
        # 分叉（本地有提交 + 远端也有新提交）时，--ff-only 会拒绝，
        # 直接把 git 的英文 hint 甩给用户等于没解释。这里换成人话 + 给出选择。
        diverged = ("Not possible to fast-forward" in msg
                    or "Diverging branches" in msg
                    or "non-fast-forward" in msg)
        if diverged:
            return {"ok": False, "diverged": True, "behind": ab.get("behind", 0),
                    "ahead": ab.get("ahead", 0), "head": before,
                    "error": "本地有 %d 个自己的提交，远端也有 %d 个新提交，双方历史分叉了，"
                             "无法自动合并。\n\n"
                             "你的本地提交不会丢。请在工具目录下用命令二选一处理：\n"
                             "  · 保留本地提交（推到远端）：git push -u origin %s\n"
                             "  · 放弃本地提交（以远端为准）：git reset --hard origin/%s\n"
                             "处理完再点一次「拉取更新」。"
                             % (ab.get("ahead", 0), ab.get("behind", 0),
                                cfg["branch"], cfg["branch"])}
        return {"ok": False, "error": "拉取失败: %s" % msg, "head": before}

    after = _local_head(repo)
    if after != before:
        _invalidate_gits_cache()
        try:
            _SCAN_COUNT_CACHE.clear()
        except Exception:
            pass
    return {"ok": True, "changed": after != before, "headBefore": before, "head": after,
            "note": note, "message": "已更新到 %s。" % after if after != before else "已是最新。"}


# ================= git 辅助 =================

def git_run(repo, *args):
    """在 repo 目录执行 git 命令，返回 stdout 字符串；失败返回 None。"""
    try:
        r = subprocess.run(["git", "-C", repo] + list(args),
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=20)
        if r.returncode != 0:
            return None
        return r.stdout
    except Exception:
        return None


def git_run_ex(repo, *args, timeout=60):
    """同 git_run，但失败时把 stderr 带回来 —— 同步功能要把「为什么拉不了」告诉用户，
    只返回 None 的话前端只能说「检查失败」，用户没法自己解决（代理/鉴权/分支不存在）。"""
    try:
        r = subprocess.run(["git", "-C", repo] + list(args),
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return 124, "", "git %s 超时（%ds）" % (" ".join(args), timeout)
    except FileNotFoundError:
        return 127, "", "找不到 git 命令，请确认已安装并加入 PATH"
    except Exception as e:
        return 1, "", str(e)


# 从 merge 提交信息里提取「被合并进来的分支名」。
# 临时分支早已删除，ref 里查不到，但 Git 把名字写进了合并提交的信息里：
#   Merge branch 'hotfix20260910-th' into 'test2.0_merge20240312'
#   Merge remote-tracking branch 'origin/xxx' into yyy
#   merge:[PVH]:合并 ck_test2.0 到 hotfix20260910-ck
#   Merge pull request #12 from feature/x into main
# 实测 core 195/198、customer 97/98 个 merge 能提取到 —— 这正是
# 「临时分支也有名字和颜色」的依据，不能因为 ref 不在就当无名线处理。
_MERGE_NAME_PATS = (
    re.compile(r"^Merge branch '(.+?)' into '(.+?)'"),
    re.compile(r"^Merge remote-tracking branch 'origin/(.+?)' into (.+)$"),
    re.compile(r"^Merge branch \u0027(.+?)\u0027 into (.+)$"),
    re.compile(r"^Merge pull request #\d+ from (.+?)/(.+?) into (.+)$"),
    re.compile(r"^merge:\[.*?\]:\s*\u5408\u5e76\s*\S+\s*\u5230\s*(\S+)"),
    re.compile(r"^Merge tag '(.+?)'"),
)


def merge_branch_name(msg):
    """从 merge 提交信息里取被合并的分支名；取不到返回 None。"""
    m = (msg or "").strip()
    for pat in _MERGE_NAME_PATS:
        mm = pat.match(m)
        if mm:
            g = mm.groups()
            # pull request 形式的第 2 组才是分支名
            if pat.pattern.startswith("^Merge pull request"):
                return g[1]
            return g[0]
    return None


def find_git_root(abs_path):
    """从文件所在目录向上找 .git 目录，返回仓库绝对路径或 None。"""
    d = abs_path if os.path.isdir(abs_path) else os.path.dirname(abs_path)
    while True:
        if os.path.isdir(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def git_branches(repo):
    out = git_run(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    if out is None:
        return []
    return [b for b in out.splitlines() if b]


def git_current_branch(repo):
    out = git_run(repo, "rev-parse", "--abbrev-ref", "HEAD")
    return out.strip() if out else ""


_REV_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/\-]*$")


def _valid_rev(s):
    """分支名/提交 hash 校验：仅允许字母数字开头 + [字母数字._/-]（含 feature/x、短 hash）。
    防止以 '-' 开头的值被 git 当作选项注入（如 git log --output=...）。"""
    return bool(s) and bool(_REV_RE.match(s))


def git_log(repo, branch, limit=30):
    """最近提交列表：[{hash, short, author, date, subject}]"""
    out = git_run(repo, "log", branch, "-n", str(limit),
                  "--pretty=format:%H|%an|%ad|%s", "--date=format:%Y-%m-%d %H:%M")
    if not out:
        return []
    commits = []
    for line in out.splitlines():
        parts = line.split("|", 3)
        if len(parts) < 4:
            continue
        h, author, date, subject = parts
        commits.append({"hash": h, "short": h[:7], "author": author,
                        "date": date, "subject": subject})
    return commits


_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")

def git_file_diff(repo, commit, rel_path):
    """某次提交对单个文件的 diff：解析 hunks，返回 [{old_start, new_start, lines:[{type,text,old_no,new_no}]}]
    type: ' ' 上下文 / '+' 新增 / '-' 删除；old_no/new_no 为该行在旧/新文件中的行号（删除行无 new_no，新增行无 old_no）。"""
    out = git_run(repo, "show", commit, "--", rel_path)
    if out is None:
        return None
    hunks = []
    cur = None
    old_no = new_no = 0
    for raw in out.splitlines():
        if raw.startswith("diff ") or raw.startswith("index ") or raw.startswith("--- ") \
                or raw.startswith("+++ ") or raw.startswith("\\ No newline"):
            continue
        m = _HUNK_RE.match(raw)
        if m:
            old_no = int(m.group(1))
            new_no = int(m.group(3))
            cur = {"old_start": old_no, "new_start": new_no, "lines": []}
            hunks.append(cur)
            continue
        if cur is None:
            continue
        if raw[:1] == " ":
            cur["lines"].append({"type": " ", "text": raw[1:], "old_no": old_no, "new_no": new_no})
            old_no += 1
            new_no += 1
        elif raw[:1] == "+":
            cur["lines"].append({"type": "+", "text": raw[1:], "old_no": None, "new_no": new_no})
            new_no += 1
        elif raw[:1] == "-":
            cur["lines"].append({"type": "-", "text": raw[1:], "old_no": old_no, "new_no": None})
            old_no += 1
    return hunks


def git_commit_meta(repo, commit):
    out = git_run(repo, "show", "-s", "--pretty=format:%H|%an|%ad|%s", "--date=format:%Y-%m-%d %H:%M", commit)
    if not out:
        return None
    parts = out.split("|", 3)
    if len(parts) < 4:
        return None
    return {"hash": parts[0], "short": parts[0][:7], "author": parts[1],
            "date": parts[2], "subject": parts[3]}


@functools.lru_cache(maxsize=128)
def _git_show_cached(repo, commit, rel_path):
    """git show <commit>:<path> 的进程内 LRU 缓存（git 版本内容不可变，跨线程只读复用安全）。"""
    out = git_run(repo, "show", "%s:%s" % (commit, rel_path))
    if out is None:
        return None
    return out.rstrip("\n")


def git_show_file(repo, commit, rel_path):
    """取某提交版本的文件内容（git show <commit>:<path>）；文件在该提交不存在返回 None。"""
    return _git_show_cached(repo, commit, rel_path)


def _join_web_path(vtop, cand):
    """给 web_defs 产出的「项目内相对路径」补上 vtop 前缀，并规范化 . / ..。
    web_defs 收到的是去掉 vtop 的项目内路径，产出的候选同样是项目内相对路径
    （可能带 ../ 回到上层），这里拼上 vtop 后规范化即可。"""
    stack = [vtop]
    for p in (cand or "").split("/"):
        if not p or p == ".":
            continue
        if p == "..":
            if len(stack) > 1:
                stack.pop()
            continue
        stack.append(p)
    return "/".join(stack)


# ================= javalang 定义解析辅助 =================

_PARSE_CACHE = {}
_PARSE_CACHE_LOCK = threading.Lock()
_PARSE_CACHE_MAX = 256


def _java_parse(src):
    """javalang 解析源码（按内容 sha1 进程内缓存，避免同一内容反复全量解析）；
    失败返回 (None, 错误消息)。线程安全（锁保护）。"""
    if not src or not src.strip():
        return None, "解析失败"
    key = hashlib.sha1(src.encode("utf-8", errors="replace")).hexdigest()
    with _PARSE_CACHE_LOCK:
        hit = _PARSE_CACHE.get(key)
        if hit is not None:
            return hit
    try:
        result = (_java_parse_fn(src), None)
    except Exception:
        result = (None, "解析失败")
    with _PARSE_CACHE_LOCK:
        if len(_PARSE_CACHE) >= _PARSE_CACHE_MAX:
            _PARSE_CACHE.clear()
        _PARSE_CACHE[key] = result
    return result


def _getter_field_name(name):
    """Lombok getter/setter/isXxx 方法名 → 字段名；非 getter/setter 返回 None。
    getCustomerIds→customerIds、getURL→URL、isDeleted→deleted、setName→name。"""
    for pfx in ("get", "set"):
        if name.startswith(pfx) and len(name) > 3 and name[3].isupper():
            f = name[3:]
            return f if (len(f) > 1 and f[1].isupper()) else (f[:1].lower() + f[1:])
    if name.startswith("is") and len(name) > 2 and name[2].isupper():
        f = name[2:]
        return f if (len(f) > 1 and f[1].isupper()) else (f[:1].lower() + f[1:])
    return None


def _has_lombok(node):
    """节点（类型声明/字段）是否有 @Getter/@Setter/@Data 注解。"""
    anns = getattr(node, "annotations", None) or []
    return any(getattr(a, "name", "") in ("Getter", "Setter", "Data") for a in anns)


def _find_field_line(tree, field_name, with_lombok=True):
    """AST 中字段声明行（可要求所在类/字段带 Lombok 注解）。返回行号或 None。"""
    for _path, node in tree:
        if isinstance(node, _jt.FieldDeclaration) and node.position:
            if not any(d.name == field_name for d in (node.declarators or [])):
                continue
            if with_lombok:
                for anc in reversed(_path):
                    if isinstance(anc, (_jt.ClassDeclaration, _jt.InterfaceDeclaration, _jt.EnumDeclaration)):
                        if _has_lombok(anc) or _has_lombok(node):
                            return node.position.line
                        break
                else:
                    if _has_lombok(node):
                        return node.position.line
                continue
            return node.position.line
    return None


def _find_method_decl(tree, name):
    """AST 中名为 name 的方法声明（按行号取最早）。"""
    best = None
    for _path, node in tree:
        if isinstance(node, _jt.MethodDeclaration) and node.name == name and node.position:
            if best is None or node.position.line < best.position.line:
                best = node
    return best


def _find_type_decl(tree, name):
    """AST 中名为 name 的类/接口/枚举声明节点。"""
    for _path, node in tree:
        if isinstance(node, (_jt.ClassDeclaration, _jt.InterfaceDeclaration, _jt.EnumDeclaration)) \
                and node.name == name:
            return node
    return None


def _var_decls(tree, name):
    """变量声明候选 [(行号, 类型名), ...]：字段 / 局部变量 / 方法参数（按 AST 遍历顺序）。"""
    out = []
    for _path, node in tree:
        if isinstance(node, _jt.FieldDeclaration):
            if any(d.name == name for d in node.declarators) and node.position:
                out.append((node.position.line, node.type.name))
        elif isinstance(node, _jt.LocalVariableDeclaration):
            if any(d.name == name for d in node.declarators) and node.position:
                out.append((node.position.line, node.type.name))
        elif isinstance(node, _jt.MethodDeclaration) and node.position:
            for prm in node.parameters:
                if prm.name == name:
                    out.append((node.position.line, getattr(prm.type, "name", None)))
                    break
    return out


def _receiver_type(tree, qualifier):
    """方法调用的接收者类型：静态 Type.method → Type；变量.method → 该变量声明类型。"""
    if not qualifier or not isinstance(qualifier, str):
        return None
    segs = qualifier.split(".")
    first = segs[0]
    if not first:
        return None
    if first[0].isupper():
        return first
    if first in ("this", "super"):
        return None
    decls = _var_decls(tree, first)
    return decls[0][1] if decls else None


# java.lang 隐式导入（无 import 语句）的核心类型白名单
_JAVA_LANG_TYPES = frozenset({
    "Object", "String", "StringBuilder", "StringBuffer", "CharSequence",
    "Integer", "Long", "Short", "Byte", "Double", "Float", "Boolean",
    "Character", "Void", "Number", "Enum", "Class", "ClassLoader",
    "Thread", "Runnable", "ThreadLocal", "System", "Math", "Process",
    "ProcessBuilder", "Runtime", "Package", "Compiler", "InheritableThreadLocal",
    "Throwable", "Exception", "RuntimeException", "Error",
    "ArithmeticException", "ArrayIndexOutOfBoundsException", "ArrayStoreException",
    "ClassCastException", "ClassNotFoundException", "CloneNotSupportedException",
    "IllegalArgumentException", "IllegalStateException", "IndexOutOfBoundsException",
    "NegativeArraySizeException", "NullPointerException", "NumberFormatException",
    "SecurityException", "UnsupportedOperationException",
    "StringIndexOutOfBoundsException", "StackOverflowError", "OutOfMemoryError",
    "Iterable", "Comparable", "Cloneable", "AutoCloseable", "Appendable",
    "StackTraceElement", "Deprecated",
})

def _type_src_exists(fqn, prefer_root=None):
    """仓库内是否存在 <fqn>.java（任意 gits 仓库 src/main|test/java 下），
    用于区分通配符导入类型是项目内还是 JDK/框架。多项目时优先查来源文件所属根。"""
    rel = fqn.replace(".", "/") + ".java"
    for repo_dir in _all_git_repos(prefer_root):
        for sub in ("main", "test"):
            if os.path.isfile(os.path.join(repo_dir, "src", sub, "java", rel)):
                return True
    return False

def _type_fqn_in_tree(tree, type_name, pkg):
    """类型名 → 全限定名：
    1. 显式 import 优先；
    2. 通配符 import：仓库内该包下确有 <type>.java → 项目内类型；
    3. java.lang 隐式类型白名单；
    4. 通配符 import 兜底（无本地文件 → 按 JDK/框架/项目包顺序取首个）；
    5. 同包兜底最后。
    imp.path 带/不带 .* 都处理（javalang wildcard 的 path 通常不带）。"""
    # 1. 显式 import（含 static 单导入，路径以 .<type_name> 结尾）
    for imp in tree.imports:
        if not imp.wildcard and imp.path.endswith("." + type_name):
            return imp.path
    # 2/4. 通配符 import
    jdk_hit = ext_hit = proj_hit = None
    for imp in tree.imports:
        if not (imp.wildcard and imp.path and not imp.static):
            continue
        base = imp.path.rstrip(".*")
        if not base:
            continue
        fqn = base + "." + type_name
        if _type_src_exists(fqn):
            return fqn  # 仓库内确有该类型 → 项目内，权威
        if base.startswith(("java.", "javax.")):
            if jdk_hit is None:
                jdk_hit = fqn
        elif _is_external_fqn(base + "."):
            if ext_hit is None:
                ext_hit = fqn
        elif proj_hit is None:
            proj_hit = fqn
    # 3. java.lang 隐式导入白名单（优先于通配符兜底：String 是 java.lang.String 而非 java.util.String）
    if type_name in _JAVA_LANG_TYPES:
        return "java.lang." + type_name
    if jdk_hit:
        return jdk_hit
    if ext_hit:
        return ext_hit
    if proj_hit:
        return proj_hit
    # 5. 同包兜底（以上都未命中才用）
    if pkg:
        return pkg + "." + type_name
    return None


def _is_external_fqn(fqn):
    return bool(fqn) and any(fqn.startswith(p) for p in JAVA_EXT_PKG_PREFIXES)


def _type_framework_parent(tree, tdecl):
    """类/接口的 extends/implements 父类型里是否有外部框架类型（IService/ServiceImpl 等）。"""
    parents = []
    ext = getattr(tdecl, "extends", None)
    if isinstance(ext, list):
        parents.extend(ext)
    elif ext is not None:
        parents.append(ext)
    impls = getattr(tdecl, "implements", None)
    if impls:
        parents.extend(impls)
    pkg = tree.package.name if tree.package else None
    for p in parents:
        pname = getattr(p, "name", None)
        if not pname:
            continue
        fqn = _type_fqn_in_tree(tree, pname, pkg)
        if fqn and _is_external_fqn(fqn):
            return True
    return False


def _inv_span(node):
    """MethodInvocation 覆盖区间（1-based 列）：qualifier 起始 .. member 结束。"""
    pos = node.position
    if pos is None:
        return None
    start = pos.column
    q = node.qualifier or ""
    end = start + len(q) + (1 if q else 0) + len(node.member)
    return start, end


def _find_invocation(tree, line, col1, name):
    """点击位置所在的方法调用节点（member 匹配 + 列在调用跨度内）。"""
    for _path, node in tree:
        if not isinstance(node, _jt.MethodInvocation) or node.member != name:
            continue
        pos = node.position
        if pos is None or pos.line != line:
            continue
        span = _inv_span(node)
        if span and span[0] <= col1 <= span[1]:
            return node
    return None


def _find_method_ref_text(line_text, col1, name):
    """基于行文本的方法引用定位（javalang 0.13 的 MethodReference 节点无 position，AST 定位不可行）。
    匹配 X::method，返回方法名与点击列命中的 qualifier（类型名/变量名），否则 None。"""
    for m in re.finditer(r"([A-Za-z_$][\w$]*)\s*::\s*([A-Za-z_$][\w$]*)", line_text or ""):
        if m.group(2) != name:
            continue
        start = m.start(2) + 1  # 1-based 方法名起始列
        end = m.end(2)
        if start <= col1 <= end:
            return m.group(1)
    return None


def _chain_head_ident(line_text, member_col1):
    """从调用行文本中提取成员名之前最近链的链头标识符。
    'svc.getUser().getName()' 点 getName → 'svc'；'obj.a().b()' 点 b → 'obj'。
    单层调用（getName()）/ this 调用（this.getName()）等无链场景返回 None。"""
    prefix = line_text[:member_col1 - 1].rstrip()
    if not prefix.endswith("."):
        return None
    i = len(prefix) - 1  # 尾部的 '.'
    head = None
    while True:
        j = i - 1
        while j >= 0 and prefix[j] in " \t":
            j -= 1
        if j < 0:
            return head
        if prefix[j] == ")":
            # 剥可选的 ident(...)：括号按深度匹配，容忍嵌套参数
            depth = 0
            k = j
            while k >= 0:
                if prefix[k] == ")":
                    depth += 1
                elif prefix[k] == "(":
                    depth -= 1
                    if depth == 0:
                        break
                k -= 1
            if depth != 0 or k < 0:
                return head  # 括号不平衡：放弃
            j = k - 1
            while j >= 0 and prefix[j] in " \t":
                j -= 1
        s = j
        while s >= 0 and (prefix[s].isalnum() or prefix[s] in "_$"):
            s -= 1
        if s == j:
            return head
        ident = prefix[s + 1:j + 1]
        head = ident
        k = s
        while k >= 0 and prefix[k] in " \t":
            k -= 1
        if k < 0 or prefix[k] != ".":
            return head
        i = k


_GITS_REPOS = None


def _all_git_repos(prefer_root=None):
    """所有根 gits/ 下的 git 仓库根（惰性扫描一次，之后进程内复用）。
    prefer_root 指定时只返回该根下的仓库（不跨项目），其排在最前。"""
    global _GITS_REPOS
    if _GITS_REPOS is None:
        repos = []
        for root in ROOTS:
            gits_dir = os.path.join(root, "gits")
            if os.path.isdir(gits_dir):
                for name in sorted(os.listdir(gits_dir)):
                    cand = os.path.join(gits_dir, name)
                    if os.path.isdir(os.path.join(cand, ".git")):
                        repos.append(cand)
        _GITS_REPOS = tuple(repos)
    if prefer_root and os.path.isdir(prefer_root):
        # 只在本项目内找（不跨项目），本项目仓库排最前。
        # 用 _within（realpath+normcase）而非 startswith：后者会把同名兄弟目录
        # （C:\proj2 对 C:\proj）误判为在根内，导致跨项目命中同名类。
        inside = [r for r in _GITS_REPOS if _within(r, prefer_root)]
        if inside:
            return tuple(inside)
    return _GITS_REPOS


@functools.lru_cache(maxsize=64)
def _git_tree_files(repo, commit):
    """仓库某提交的完整文件列表（ls-tree -r），供 git 侧按文件名搜索。"""
    out = git_run(repo, "ls-tree", "-r", "--name-only", commit)
    if out is None:
        return ()
    return tuple(l for l in out.splitlines() if l)


def _git_find_file(repo, view_commit, base):
    """在仓库某提交的树中按文件名找相对路径；找不到返回 None。"""
    for rel in _git_tree_files(repo, view_commit):
        if os.path.basename(rel) == base:
            return rel
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "MDReader/1.0"

    # ---------- helpers ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _serve_file(self, abs_path):
        if not abs_path or not os.path.isfile(abs_path):
            self._json({"error": "not found"}, 404)
            return
        mime = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        with open(abs_path, "rb") as f:
            self._send(200, f.read(), mime)

    def _read_query(self):
        return parse_qs(urlparse(self.path).query)

    MAX_BODY_LEN = 10 * 1024 * 1024   # POST body 上限 10MB
    MAX_TEXT_LEN = 5 * 1024 * 1024    # /api/java/def text 字段上限 5MB

    def _read_body(self):
        """读 POST body：Content-Length 缺失/非法/为负 → 400；超上限 → 413。失败已发响应，返回 None。"""
        raw = self.headers.get("Content-Length")
        try:
            length = int(raw or 0)
        except (TypeError, ValueError):
            self._json({"error": "invalid Content-Length"}, 400)
            return None
        if length < 0:
            self._json({"error": "invalid Content-Length"}, 400)
            return None
        if length > self.MAX_BODY_LEN:
            self._json({"error": "payload too large"}, 413)
            return None
        return self.rfile.read(length)

    # ---------- API ----------
    def _api_list(self, qs):
        rel = (qs.get("path") or [""])[0].replace("\\", "/").lstrip("/")
        # 多根且未指定当前项目：顶层返回各工作区根（"项目"层聚合目录）
        if not rel and len(ROOTS) > 1 and not _CURRENT:
            entries = []
            for name, r in sorted(_VTOP.items()):
                entries.append({"name": name, "type": "dir", "path": name, "virtual": 1,
                                "label": os.path.basename(os.path.normpath(r))})
            self._json({"path": "", "entries": entries})
            return
        # 多根且指定了当前项目：顶层直接列当前项目根目录内容
        if not rel and _CURRENT and _CURRENT in _VTOP:
            abs_path = _VTOP[_CURRENT]
        else:
            abs_path = safe_path(rel) if rel else ROOTS[0]
        if not abs_path or not os.path.isdir(abs_path):
            self._json({"error": "dir not found", "path": rel}, 404)
            return
        entries = []
        for name in sorted(os.listdir(abs_path), key=lambda n: (not os.path.isdir(os.path.join(abs_path, n)), n.lower())):
            if is_ignored(name):
                continue
            full = os.path.join(abs_path, name)
            if os.path.isdir(full):
                entries.append({"name": name, "type": "dir", "path": rel_of(full)})
            else:
                ext = os.path.splitext(name)[1].lower()
                entries.append({"name": name, "type": "file", "path": rel_of(full), "ext": ext})
        self._json({"path": rel_of(abs_path), "entries": entries})

    def _api_projects(self, qs):
        """项目管理：GET 列表 / POST add|remove|switch（见 do_POST）。"""
        self._json({"current": _CURRENT, "single": len(ROOTS) == 1,
                    "projects": [{"name": n, "path": r} for n, r in sorted(_VTOP.items())]})

    def _api_meta(self, qs):
        """多根元数据：前端用 vtop 列表处理根绝对链接归属（/gits/xx → 当前文档所在根）。"""
        self._json({"roots": [{"name": n, "path": r} for n, r in sorted(_VTOP.items())],
                    "single": len(ROOTS) == 1})

    # ---------- 快速打开（Ctrl+P）：全量可打开文件清单，TTL 缓存 ----------
    _files_cache = {"ts": 0, "files": []}

    def _api_files(self, qs):
        now = _time.time()
        if now - self._files_cache["ts"] > 60:
            files = []
            for _root in ROOTS:
                for dirpath, dirnames, filenames in os.walk(_root):
                    dirnames[:] = [d for d in dirnames if not is_ignored(d)]
                    for fn in filenames:
                        ext = os.path.splitext(fn)[1].lower()
                        if not (ext in CODE_EXTS or ext in IMAGE_EXTS):
                            continue
                        full = os.path.join(dirpath, fn)
                        if os.path.getsize(full) > 8 * 1024 * 1024:
                            continue
                        files.append(rel_of(full))
            files.sort()
            self._files_cache["ts"] = now
            self._files_cache["files"] = files
        self._json({"files": self._files_cache["files"], "total": len(self._files_cache["files"])})

    def _resolve_read_path(self, rel):
        """读文件接口（code/raw/markdown）的路径解析：safe_path 直取；取不到时按
        basename 在项目内兜底搜索（老文档里的链接常写着已改名的目录，如
        gits/employee_ck_test2.0/... 而磁盘上是 gits/employee/...）。
        返回绝对路径或 None。"""
        abs_path = safe_path(rel)
        if abs_path and os.path.isfile(abs_path):
            return abs_path
        base = os.path.basename((rel or "").replace("\\", "/"))
        if not base:
            return None
        found = self._search_file(base, prefer_repo=self._repo_for_rel(rel)[0],
                                  prefer_root=_root_for(rel))
        if found:
            ap = safe_path(found)
            if ap and os.path.isfile(ap):
                return ap
        return None

    def _api_markdown(self, qs):
        rel = (qs.get("path") or [""])[0]
        abs_path = self._resolve_read_path(rel)
        if not abs_path:
            self._json({"error": "file not found", "path": rel}, 404)
            return
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        self._json({"path": rel_of(abs_path), "name": os.path.basename(abs_path), "content": content,
                    "lines": content.count("\n") + 1})

    def _api_code(self, qs):
        rel = (qs.get("path") or [""])[0]
        abs_path = self._resolve_read_path(rel)
        if not abs_path:
            self._json({"error": "file not found", "path": rel}, 404)
            return
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        self._json({"path": rel_of(abs_path), "name": os.path.basename(abs_path), "content": content,
                    "lines": content.count("\n") + 1, "size": os.path.getsize(abs_path)})

    def _api_raw(self, qs):
        rel = (qs.get("path") or [""])[0]
        abs_path = self._resolve_read_path(rel)
        if not abs_path:
            self._json({"error": "not found"}, 404)
            return
        mime = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        with open(abs_path, "rb") as f:
            self._send(200, f.read(), mime)

    def _api_html(self, qs):
        """HTML 预览：返回文档文本并注入 <base href="file-like 路径">。

        不用 iframe srcdoc 的原因：srcdoc 文档的 URL 是 about:srcdoc，
        <a href="#锚点"> 会被当作顶层导航，跳到 reader 的 http://127.0.0.1:8765/#锚点，
        表现为「点左侧导航后嵌套了一层 markdown reader 页面」。
        走 /api/html?path= 后页面有真实 URL，锚点在 iframe 内滚动。

        注入 <base> 让文档里的相对 src/href 解析到 /api/raw 代理，
        这样自包含 HTML（内联 echarts 等）无需重写也能正常渲染。
        """
        rel = (qs.get("path") or [""])[0]
        abs_path = self._resolve_read_path(rel)
        if not abs_path or not os.path.isfile(abs_path):
            self._json({"error": "not found"}, 404)
            return
        if not abs_path.lower().endswith((".html", ".htm")):
            self._json({"error": "not an html file"}, 415)
            return
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                html = f.read()
        except OSError:
            self._json({"error": "read failed"}, 500)
            return
        # <base> 指向 /api/raw 代理：文档内相对资源（img/ css /字体）都能取到
        base_url = "/api/raw?path=" + quote(rel, safe="")
        base_tag = '<base href="%s">' % base_url
        if re.search(r"<head[^>]*>", html, re.I):
            html = re.sub(r"(<head[^>]*>)", r"\1\n" + base_tag, html, count=1, flags=re.I)
        else:
            html = base_tag + "\n" + html
        self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

    def _api_git_repos(self, qs):
        """枚举 git 仓库，供 Git 版本树选择仓库。

        默认只返回当前项目下的仓库（project=<vtop> 可指定，project=__all__ 才跨项目）——
        与 /api/search 同一套语义。之前的实现遍历全部 ROOTS，
        下拉里会混入另外两个项目的仓库（实测 39 个仓库来自 3 个项目），
        选错项目后画的版本树根本不是当前项目的历史。"""
        roots = _roots_for_project_arg(qs)
        repos = []
        for root in roots:
            for dirpath, dirnames, filenames in os.walk(root):
                if ".git" in dirnames:
                    repos.append(rel_of(dirpath))
                dirnames[:] = [d for d in dirnames if not is_ignored(d)]
        repos.sort()
        cur = _current_project_name()
        self._json({
            "repos": repos,
            "scope": "__all__" if len(roots) > 1 else cur,
        })

    def _api_git_graph(self, qs):
        """Git 版本树数据：仓库所有分支/标签引用 + 全量提交（id/parents/作者/日期/消息）。

        前端用 gitgraph.js 渲染。path 用于定位仓库；commit 数限制 800 防超大仓库卡死。
        """
        rel = (qs.get("path") or [""])[0]
        abs_path = safe_path(rel) if rel else ROOTS[0]
        if not abs_path or not os.path.exists(abs_path):
            self._json({"error": "not found"}, 404)
            return
        repo = find_git_root(abs_path)
        if not repo:
            self._json({"repo": None, "error": "not a git repo"}, 400)
            return
        # 提交：--all 含所有分支/标签；--date-order 拓扑接近真实。
        # 数量由前端按需请求：offset=0&limit=N 分页拉取，前端滚到底再要下一批。
        # 之前固定 -n 250（或 800）会静默截断 —— 用户看到「就这些提交」，
        # 实际是服务端取的条数上限，且完全没有「还有更多」的提示。
        try:
            offset = max(0, int((qs.get("offset") or ["0"])[0] or 0))
        except ValueError:
            offset = 0
        try:
            limit = int((qs.get("limit") or ["300"])[0] or 300)
        except ValueError:
            limit = 300
        limit = min(max(limit, 1), 2000)        # 单次上限，防超大响应
        total_out = git_run(repo, "rev-list", "--all", "--count")
        try:
            total = int((total_out or "0").strip() or 0)
        except ValueError:
            total = 0
        # 多取 offset+limit 条再切片：--skip 在 --date-order 下同样稳定
        out = git_run(repo, "log", "--all", "--date-order",
                      "--skip", str(offset), "-n", str(limit + 1),
                      "--pretty=format:%H%x09%P%x09%an%x09%ad%x09%s", "--date=short")
        # =====================================================================
        # 一次 `git log --graph` 解析出全部绘制数据，前端只负责画。
        # 不在前端自研轨道分配 / 连线走向 —— 那等于重新实现 git log --graph，
        # 而它内置 lane swapping（一条线合并回主干后它的列立即释放给下一个
        # 分叉复用），这是「拉临时分支 → 合并 → 删除」能画紧凑的唯一前提。
        # 实测 core 147 个 merge 只占 5~6 列，前端按分支名静态分配要 8 列还画不下。
        #
        # 一次调用同时拿到：
        #   · lane     每个提交所在的列号
        #   · parents/author/date/msg
        # =====================================================================
        SEP = "\x01"
        try:
            g = git_run(repo, "log", "--all", "--graph", "--date-order",
                        "-n", str(limit + 1),
                        "--pretty=format:" + SEP + "%H" + SEP + "%P" + SEP +
                        "%an" + SEP + "%ad" + SEP + "%s", "--date=short")
        except Exception:
            g = ""

        total_out = git_run(repo, "rev-list", "--all", "--count")
        try:
            total = int((total_out or "0").strip() or 0)
        except ValueError:
            total = 0

        refs = git_run(repo, "for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads", "refs/tags")
        branches, tags = [], []
        if refs:
            for ln in refs.splitlines():
                parts = ln.split("\t")
                if len(parts) != 2:
                    continue
                name, oid = parts[0], parts[1]
                if name.startswith("tags/"):
                    tags.append({"name": name[5:], "head": oid})
                else:
                    branches.append({"name": name, "head": oid})
        head = git_run(repo, "rev-parse", "HEAD")
        commits = []
        row_index = -1
        for raw in (g or "").splitlines():
            if SEP not in raw:
                continue                     # 纯 ASCII 连线行，不需要（连线由 parents 决定）
            pre, rest = raw.split(SEP, 1)
            f = rest.split(SEP)
            if len(f) < 5:
                continue
            cid, parents, author, date, msg = f[0], f[1], f[2], f[3], f[4]
            star = pre.find("*")
            if star < 0:
                continue
            row_index += 1
            commits.append({
                "id": cid, "parents": [x for x in parents.split() if x],
                "author": author, "date": date, "msg": msg,
                "lane": star // 2,             # Git 每列 2 字符宽（含 lane swapping）
                "row": row_index,
                # merge 提交带出被合并的分支名（临时分支 ref 已删时唯一来源）
                "laneBranch": merge_branch_name(msg) if len(f[1].split()) > 1 else None,
            })

        
        # 每个提交属于哪些分支：用 `git rev-list <branch>` 精确求解。
        # 前端做这个要跑 O(提交数 × 分支数 × 链长)，300 提交 × 9 分支就是几万步；
        # 服务端一次 rev-list 拿全量，浏览器只做查表。
        # 之前只在「分支 head 正好是该提交」时才算有分支，结果详情里大片空白。
        branch_of = {}
        for b in branches:
            rv = git_run(repo, "rev-list", b["head"])
            if not rv:
                continue
            for cid2 in rv.split():
                if cid2 not in branch_of:
                    branch_of[cid2] = []
                if len(branch_of[cid2]) < 4:      # 一个提交可能属于多个分支，标 4 个封顶
                    branch_of[cid2].append(b["name"])
        for c in commits:
            c["branches"] = branch_of.get(c["id"], [])

        has_more = len(commits) > limit
        if has_more:
            commits = commits[:limit]
        lanes = max([c["lane"] for c in commits], default=0) + 1

        # 分支 / 标签引用 → 头提交
        head_branch = git_run(repo, "symbolic-ref", "--short", "HEAD")

        self._json({
            "repo": os.path.basename(repo), "repo_root": rel_of(repo),
            "branches": branches, "tags": tags,
            "head": (head or "").strip(), "headBranch": (head_branch or "").strip(),
            "total": total, "offset": offset, "limit": limit, "hasMore": has_more,
            "commits": commits, "lanes": lanes,
        })

    def _api_git_meta(self, qs):
        """返回文件所属仓库：当前分支、分支列表、最近提交。path 可为文件或目录。"""
        rel = (qs.get("path") or [""])[0]
        abs_path = safe_path(rel)
        if not abs_path or not os.path.exists(abs_path):
            self._json({"error": "not found"}, 404)
            return
        repo = find_git_root(abs_path)
        if not repo:
            self._json({"repo": None, "branches": [], "commits": [], "current": "",
                        "rel_to_repo": None})
            return
        branch = (qs.get("branch") or [""])[0] or git_current_branch(repo)
        if (qs.get("branch") or [""])[0] and not _valid_rev(branch):
            self._json({"error": "invalid branch"}, 400)
            return
        branches = git_branches(repo)
        commits = git_log(repo, branch, 30)
        rel_to_repo = rel_of(abs_path)
        repo_rel = rel_of(repo)
        if rel_to_repo.startswith(repo_rel + "/"):
            rel_to_repo = rel_to_repo[len(repo_rel) + 1:]
        elif rel_to_repo == repo_rel:
            rel_to_repo = "."
        self._json({"repo": os.path.basename(repo), "repo_root": repo,
                    "branches": branches, "current": branch, "commits": commits,
                    "rel_to_repo": rel_to_repo, "branch": branch})

    def _api_git_diff(self, qs):
        """某提交对某文件的改动：作者 + hunks。commit 需是 hash 或 ref。"""
        rel = (qs.get("path") or [""])[0]
        commit = (qs.get("commit") or [""])[0]
        abs_path = safe_path(rel)
        if not abs_path or not os.path.isfile(abs_path) or not _valid_rev(commit):
            self._json({"error": "invalid params"}, 400)
            return
        repo = find_git_root(abs_path)
        if not repo:
            self._json({"error": "not a git repo"}, 400)
            return
        repo_rel = rel_of(repo)
        file_rel = rel_of(abs_path)
        if file_rel.startswith(repo_rel + "/"):
            file_rel = file_rel[len(repo_rel) + 1:]
        else:
            file_rel = os.path.basename(file_rel)
        meta = git_commit_meta(repo, commit)
        if not meta:
            self._json({"error": "commit not found"}, 404)
            return
        hunks = git_file_diff(repo, commit, file_rel)
        self._json({"meta": meta, "hunks": hunks or [], "file": file_rel})

    def _api_git_file(self, qs):
        """某提交版本的完整文件内容（用于在提交 Diff 与完整文件间切换）。
        分支/提交视图下目标文件可能只在 git 侧存在（工作区已删/改名）→ 存在性放宽为 git 侧。"""
        rel = (qs.get("path") or [""])[0]
        commit = (qs.get("commit") or [""])[0]
        abs_path = safe_path(rel)
        if not abs_path or not _valid_rev(commit):
            self._json({"error": "invalid params"}, 400)
            return
        if os.path.isfile(abs_path):
            repo = find_git_root(abs_path)
            file_rel = rel_of(abs_path)
            if repo:
                repo_root_rel = rel_of(repo)
                if file_rel.startswith(repo_root_rel + "/"):
                    file_rel = file_rel[len(repo_root_rel) + 1:]
        else:
            repo, file_rel = self._repo_for_rel(rel)
        if not repo:
            self._json({"error": "not a git repo"}, 400)
            return
        meta = git_commit_meta(repo, commit)
        if not meta:
            self._json({"error": "commit not found"}, 404)
            return
        content = git_show_file(repo, commit, file_rel)
        if content is None:
            self._json({"error": "file not in this commit", "meta": meta}, 404)
            return
        self._json({"meta": meta, "content": content, "file": file_rel,
                    "lines": content.count("\n") + 1})

    def _api_exists(self, qs):
        """批量解析路径：先按相对根解析，不存在则按文件名在常见目录搜索。返回 {input: {abs, exists}}。"""
        paths = qs.get("path") or []
        result = {}
        for rel in paths:
            abs_path = safe_path(rel)
            resolved = None
            if abs_path and os.path.exists(abs_path):
                resolved = rel_of(abs_path)
            else:
                # 兜底：按 basename 在候选目录搜索（覆盖未带 gits/ 前缀的仓库相对路径）
                base = os.path.basename(rel.replace("\\", "/"))
                if base:
                    found = self._search_file(base, prefer_repo=self._repo_for_rel(rel)[0],
                                              prefer_root=_root_for(rel))
                    if found:
                        resolved = found
            result[rel] = {"abs": resolved, "exists": bool(resolved)}
        self._json({"exists": result})

    def _search_file(self, base, view_commit=None, prefer_repo=None, prefer_root=None):
        """在工作区常见目录中按文件名搜索（限定深度，避免全盘遍历）。
        gits 仓库按服务/分支分子目录后深了一层（gits/<svc>/<ck|th>/src/main/java/...），
        单独给它更大深度；其他目录（docs/tools 等）仍限 3 层，防打开文档时全盘遍历卡顿。
        搜索边界：只在本项目内查找，不跨项目。
        项目内以 git 仓库为基本单位排序，避免同名类跳错仓库：
        1. 来源文件所在 git 仓库（prefer_repo）；
        2. 本项目下其它 gits 仓库（sorted 保证结果稳定）；
        3. 本项目的非 git 目录（docs/tools 等，浅层）。
        本项目内找不到即返回 None（宁可不跳，也不跳到别的项目/仓库的同名类）。"""
        roots = [("docs", 3), ("gits/ckdocs", 3), ("gits", 12),
                 ("tools", 3), ("pvh", 3), ("pvhth", 3)]

        def _find_under(abs_dir, max_depth):
            """在 abs_dir 下按深度 BFS 找同名文件，返回绝对路径或 None。"""
            if not abs_dir or not os.path.isdir(abs_dir):
                return None
            queue = [(abs_dir, 0)]
            while queue:
                d, depth = queue.pop(0)
                try:
                    entries = os.scandir(d)
                except OSError:
                    continue
                for e in entries:
                    try:
                        if e.name in (".git", ".idea", "node_modules", "__pycache__", ".mvn", "target"):
                            continue
                        if e.is_dir():
                            if depth < max_depth:
                                queue.append((e.path, depth + 1))
                        elif e.name == base:
                            return e.path
                    except OSError:
                        continue
            return None

        # ---- 搜索根 = 来源文件所属项目（绝不跨项目） ----
        if prefer_root and os.path.isdir(prefer_root):
            search_root = prefer_root
        elif len(ROOTS) == 1:
            search_root = ROOTS[0]
        else:
            # 未指定来源根且多项目在跑：只在当前项目内找，无当前项目则不猜。
            # _CURRENT 存的是 vtop 名（不是路径），必须经 _VTOP 映射成绝对路径。
            cur_abs = _VTOP.get(_CURRENT or "")
            search_root = cur_abs if (cur_abs and os.path.isdir(cur_abs)) else None
        if not search_root:
            return None

        # ---- 1) 来源 git 仓库内 ----
        # 用 _within（realpath+normcase）而非 startswith：后者会把
        # search_root 的「同名兄弟目录」（C:\proj2 对 C:\proj）误判为在根内，导致跨项目命中
        if prefer_repo and _within(prefer_repo, search_root):
            hit = _find_under(prefer_repo, 12)
            if hit:
                return rel_of(hit)

        # ---- 2) 本项目下其它 gits 仓库 ----
        gits_dir = os.path.join(search_root, "gits")
        if os.path.isdir(gits_dir):
            try:
                names = sorted(os.listdir(gits_dir))
            except OSError:
                names = []
            for name in names:
                cand = os.path.join(gits_dir, name)
                if not os.path.isdir(cand):
                    continue
                if prefer_repo and _root_real(cand) == _root_real(prefer_repo):
                    continue  # 第 1 步已扫过
                hit = _find_under(cand, 12)
                if hit:
                    return rel_of(hit)

        # ---- 3) 本项目的非 git 目录（docs/tools 等，浅层） ----
        for r, max_depth in roots:
            if r.startswith("gits"):
                continue   # gits 已按仓库粒度扫完
            hit = _find_under(os.path.join(search_root, r), max_depth)
            if hit:
                return rel_of(hit)

        # ---- 4) git 侧（分支/提交视图，磁盘已删但分支里有） ----
        if view_commit:
            for repo_dir in _all_git_repos(search_root):
                if not _within(repo_dir, search_root):
                    continue   # 跨项目仓库不查
                hit = _git_find_file(repo_dir, view_commit, base)
                if hit:
                    return rel_of(os.path.join(repo_dir, hit))
        return None

    def _api_save(self, qs):
        rel = (qs.get("path") or [""])[0]
        abs_path = safe_path(rel)
        if not abs_path:
            self._json({"error": "invalid path"}, 400)
            return
        body = self._read_body()
        if body is None:
            return
        body = body.decode("utf-8", errors="replace")
        with open(abs_path, "w", encoding="utf-8") as f:
            f.write(body)
        self._json({"ok": True, "path": rel_of(abs_path), "lines": body.count("\n") + 1})

    # ---------- mermaid 服务端渲染 ----------
    def _api_perf_log(self):
        """POST /api/perf-log  body: {"lines": [".."]}  前端性能日志 → mdreader.log"""
        body = self._read_body()
        if body is None:
            return
        try:
            body = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:
            self._json({"error": "bad json"}, 400)
            return
        for line in (body.get("lines") or []):
            log_line("FE: " + str(line))
        self._json({"ok": True})

    def _api_mermaid_render(self):
        """POST /api/mermaid/render  body: {"items": [{"id": "..", "src": ".."}]}
        按 src 哈希缓存 SVG（.mmd-cache/），未命中的异步排队渲染（不阻塞请求）：
        本请求先返回已缓存结果 + pending 列表；渲染线程完成后缓存落盘，
        前端轮询本接口即可拿到（第二次请求命中）。
        返回 {"results": {...}, "pending": [id...]}"""
        global _MMD_LOCK
        body = self._read_body()
        if body is None:
            return
        try:
            body = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:
            self._json({"error": "bad json"}, 400)
            return
        items = body.get("items") or []
        if not items:
            self._json({"error": "empty items"}, 400)
            return

        os.makedirs(MMD_CACHE_DIR, exist_ok=True)
        t_start = _time.time()
        results = {}
        pending_ids = []
        missing = []  # [(id, src_hash, src)]
        for it in items:
            src = (it.get("src") or "").strip()
            if not src:
                results[it.get("id", "?")] = {"error": "empty src"}
                continue
            h = hashlib.sha256(src.encode("utf-8")).hexdigest()[:16]
            svg_path = os.path.join(MMD_CACHE_DIR, h + ".svg")
            err_path = os.path.join(MMD_CACHE_DIR, h + ".err.txt")
            if os.path.exists(svg_path):
                with open(svg_path, "r", encoding="utf-8") as f:
                    results[it.get("id", "?")] = {"svg": f.read()}
            elif os.path.exists(err_path):
                # 之前渲染失败过：直接返回错误，不重试（避免每次请求都重跑坏图+启动浏览器）
                with open(err_path, "r", encoding="utf-8") as f:
                    results[it.get("id", "?")] = {"error": f.read().strip()}
            else:
                missing.append((it.get("id", "?"), h, src))
                pending_ids.append(it.get("id", "?"))

        if missing:
            import threading
            # 进程内锁：并发请求共享同一渲染线程，避免重复启动浏览器
            if _MMD_LOCK is not None and _MMD_LOCK.is_alive():
                pass  # 已有渲染在跑，本请求的缺失图会由它或下一轮处理
            else:
                _MMD_LOCK = threading.Thread(target=self._render_missing, args=(missing,), daemon=True)
                _MMD_LOCK.start()
            log_line("mermaid render: %d items, %d hit, %d queued (async)" % (
                len(items), len(results), len(missing)))
        else:
            log_line("mermaid render: %d items all cached, %.0fms" % (len(items), (_time.time() - t_start) * 1000))

        # 返回已缓存结果 + 待渲染列表（前端轮询；不阻塞等待渲染）
        self._json({"results": results, "pending": pending_ids})

    def _render_missing(self, missing):
        """把缺失的图写临时文件，调批量渲染脚本（脚本按文件序号写 <idx>.svg / <idx>.err.txt）。"""
        import tempfile
        os.makedirs(MMD_CACHE_DIR, exist_ok=True)
        log_line("mermaid render: starting node batch, %d missing" % len(missing))
        t0 = _time.time()
        with tempfile.TemporaryDirectory(prefix="mmd_req_") as tmp:
            src_file = os.path.join(tmp, "sources.txt")
            out_dir = os.path.join(tmp, "out")
            os.makedirs(out_dir, exist_ok=True)
            with open(src_file, "w", encoding="utf-8") as f:
                f.write("\n---MMD---\n".join(src for _, _, src in missing))
            try:
                subprocess.run(
                    ["node", MMD_BATCH_SCRIPT, src_file, out_dir, str(len(missing))],
                    capture_output=True, text=True, timeout=600,
                    cwd=HERE,
                )
                log_line("mermaid render: node batch done in %.0fms" % ((_time.time() - t0) * 1000))
            except Exception as e:
                log_line("mermaid render: node batch FAILED: %s" % str(e)[:200])
                return
            # 回填缓存
            for idx, (_, h, _src) in enumerate(missing):
                svg_path = os.path.join(out_dir, "%d.svg" % idx)
                err_path = os.path.join(out_dir, "%d.err.txt" % idx)
                if os.path.exists(svg_path):
                    with open(svg_path, "r", encoding="utf-8") as f:
                        svg = f.read()
                    with open(os.path.join(MMD_CACHE_DIR, h + ".svg"), "w", encoding="utf-8") as f:
                        f.write(svg)
                elif os.path.exists(err_path):
                    with open(err_path, "r", encoding="utf-8") as f:
                        err = f.read()
                    with open(os.path.join(MMD_CACHE_DIR, h + ".err.txt"), "w", encoding="utf-8") as f:
                        f.write(err)

    # ---------- javalang 定义跳转 ----------
    def _repo_for_rel(self, rel_path):
        """按相对路径向上找含 .git 的仓库根（文件可能已从磁盘删除/改名，不能依赖磁盘存在性）。
        返回 (repo_root, repo_rel)；无仓库返回 (None, None)。"""
        rel = (rel_path or "").replace("\\", "/").lstrip("/")
        root = _root_for(rel)
        first = rel.split("/", 1)[0]
        if first in _VTOP and "/" in rel:
            rel = rel[len(first) + 1:]
        parts = rel.split("/")
        for i in range(len(parts), 0, -1):
            cand = os.path.join(root, *parts[:i])
            if os.path.isdir(os.path.join(cand, ".git")):
                return cand, "/".join(parts[i:])
        return None, None

    def _path_in_view(self, rel, view_commit):
        """候选文件在分支/提交视图的 git 侧是否存在（配合磁盘存在性，保持分支一致解析）。"""
        if not view_commit:
            return False
        repo, repo_rel = self._repo_for_rel(rel)
        if not repo:
            return False
        return git_show_file(repo, view_commit, repo_rel) is not None

    def _load_file_content(self, rel_path, view_commit):
        """读取目标文件内容；view_commit（分支或提交 hash）时取对应 git 版本，
        此时文件可能仅在 git 侧存在（磁盘已删/改名）。文件都不存在返回 None。"""
        abs_path = safe_path(rel_path)
        if not abs_path:
            return None
        if view_commit:
            repo, repo_rel = self._repo_for_rel(rel_path)
            if repo:
                content = git_show_file(repo, view_commit, repo_rel)
                if content is not None:
                    return content
                return None  # 该分支/提交无此文件
            # 非仓库内路径：退回磁盘读取
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception:
            return None

    def _resolve_type_file(self, tree, type_name, src_path, view_commit=None):
        """类型名 → 仓库内类文件相对路径。显式 import / 全限定 / 同包 / 通配符 import / basename 搜索；
        外部框架类型返回 None（不搜库）。view_commit 非空时候选存在性同时查 git 侧（分支一致）。"""
        pkg = tree.package.name if tree.package else None
        m = re.match(r"^(.*/src/(?:main|test)/java/)", src_path)
        root = m.group(1) if m else None
        fqn = type_name if "." in type_name else _type_fqn_in_tree(tree, type_name, pkg)
        cands = []
        if fqn:
            cands.append(fqn.replace(".", "/") + ".java")
            if root and "." in fqn:
                # 显式/通配符 import 的 FQN：优先在同仓库 src 根下精确定位。
                # 多仓库存在同名类（如各仓库的 CustomerFacade）时，basename 全局搜索会搜错仓库，必须按 FQN 定位。
                cands.insert(0, root + fqn.replace(".", "/") + ".java")
        if root:
            if pkg:
                cands.append(root + pkg.replace(".", "/") + "/" + type_name + ".java")
            for imp in tree.imports:
                if imp.wildcard and imp.path:
                    cands.append(root + imp.path.replace(".", "/") + "/" + type_name + ".java")
        for c in cands:
            ap = safe_path(c)
            if ap and (os.path.isfile(ap) or self._path_in_view(c, view_commit)):
                return rel_of(ap)
        if fqn and _is_external_fqn(fqn):
            return None
        return self._search_file(type_name + ".java", view_commit,
                                 prefer_repo=self._repo_for_rel(src_path)[0],
                                 prefer_root=_root_for(src_path))

    def _resolve_impl(self, target_rel, type_name, method_name, view_commit):
        """接口 → 实现类入口：<Type>Impl.java。候选：接口同目录 / 接口包 .impl 子包 / basename 全库搜索。
        method_name 存在时找方法定义行，否则找实现类声明行。"""
        abs_path = safe_path(target_rel)
        if not abs_path:
            return None
        cands = []
        cands.append(os.path.join(os.path.dirname(abs_path), type_name + "Impl.java"))
        m = re.match(r"^(.*/src/(?:main|test)/java/)", target_rel)
        if m:
            root = m.group(1)
            rel_java = target_rel[m.end():]
            pkg_dir = rel_java.rsplit("/", 1)[0]
            if pkg_dir:
                cands.append(root + pkg_dir + "/impl/" + type_name + "Impl.java")
        impl_rel = None
        for c in cands:
            ap = safe_path(c)
            if ap and (os.path.isfile(ap) or self._path_in_view(rel_of(ap), view_commit)):
                impl_rel = rel_of(ap)
                break
        if not impl_rel:
            found = self._search_file(type_name + "Impl.java", view_commit,
                                      prefer_repo=self._repo_for_rel(target_rel)[0],
                                      prefer_root=_root_for(target_rel))
            if not found:
                return None
            impl_rel = found
        content = self._load_file_content(impl_rel, view_commit)
        if content is None:
            return None
        itree, _err = _java_parse(content)
        if itree is None:
            return None
        if method_name:
            mnode = _find_method_decl(itree, method_name)
            if not mnode:
                return None
            line = mnode.position.line
        else:
            tnode = _find_type_decl(itree, type_name + "Impl")
            if not tnode or not tnode.position:
                return None
            line = tnode.position.line
        return {"file": impl_rel, "line": line}

    def _resolve_mapper_xml(self, base, java_rel, view_commit):
        """Mapper.java → 同名 Mapper.xml + 每条 SQL 语句的行号。
        候选：同仓库 src/main|test/resources 下递归（mybatis 惯例），
        未命中再按文件名全局搜索。语句 = <select|insert|update|delete id="方法名">。"""
        xml_name = base + ".xml"
        xml_rel = None
        m = re.match(r"^(.*?/src/(?:main|test)/)", java_rel)
        if m:
            root = m.group(1)                       # .../src/main/ 或 .../src/test/（可能带 vtop 前缀）
            first = java_rel.split("/", 1)[0]
            if first in _VTOP and "/" in java_rel:
                root = root[len(first) + 1:]
            res_root = os.path.join(_root_for(java_rel), root + "resources")
            if os.path.isdir(res_root):
                for dirpath, dirnames, filenames in os.walk(res_root):
                    dirnames[:] = [d for d in dirnames if d not in (".git", "target")]
                    if xml_name in filenames:
                        xml_rel = rel_of(os.path.join(dirpath, xml_name))
                        break
        if not xml_rel:
            found = self._search_file(xml_name, view_commit,
                                      prefer_repo=self._repo_for_rel(java_rel)[0],
                                      prefer_root=_root_for(java_rel))
            if not found:
                return None
            xml_rel = found
        content = self._load_file_content(xml_rel, view_commit)
        if content is None:
            return None
        statements = []
        for i, ln in enumerate(content.split("\n"), 1):
            mm = re.search(r"<(select|insert|update|delete)\b[^>]*\bid=\"([^\"]+)\"", ln)
            if mm:
                statements.append({"method": mm.group(2), "line": i})
        return {"file": xml_rel, "statements": statements}

    def _resolve_iface_method(self, src_path, iface_name, method_name, view_commit):
        """接口方法声明被点击（ctrl+click）→ 跳到实现：
        Mapper 接口 → 同名 Mapper.xml 中该方法的 SQL 语句行；
        其他接口（Service 等）→ 实现类中该方法的定义行。
        找不到对应实现返回 None（调用方维持「本文件定义」原行为）。"""
        if iface_name.lower().endswith("mapper"):
            xml = self._resolve_mapper_xml(iface_name, src_path, view_commit)
            if xml:
                for s in xml["statements"]:
                    if s["method"] == method_name:
                        return {"file": xml["file"], "line": s["line"], "impl": None,
                                "kind": "xml", "defName": method_name}
            return None
        impl = self._resolve_impl(src_path, iface_name, method_name, view_commit)
        if impl:
            return {"file": impl["file"], "line": impl["line"], "impl": None,
                    "kind": "method", "defName": method_name}
        return None

    def _api_search(self, qs):
        """项目内搜索：扫文本文件，返回包含目标字符串的文件 + 匹配行。
        支持 re=1（正则，忽略大小写）、ext=扩展名（类型过滤）、project=<vtop>。
        搜索范围 = 当前项目（project 参数指定，缺省用 projects.json 的 current），
        不跨项目：各项目文件数差异极大（微服务 ~3900 / baseline ~18800），
        跨项目遍历既慢又会返回别的项目的同名文件，与「查询以项目为边界」冲突。
        project=__all__ 显式请求时才搜全部项目。
        限制：最多扫描 MAX_SCAN 个文件、每文件最多 40 行、最多返回 120 个文件（防单线程阻塞）。"""
        q = (qs.get("q") or [""])[0]
        if not q or len(q) > 200:
            self._json({"error": "query required"}, 400)
            return
        use_re = (qs.get("re") or [""])[0] in ("1", "true", "yes")
        ext_filter = (qs.get("ext") or [""])[0].lower().lstrip(".").strip()
        if use_re:
            try:
                re_obj = re.compile(q, re.IGNORECASE)
            except re.error as e:
                self._json({"error": "正则表达式错误: " + str(e)}, 400)
                return
        MAX_LINES = 5000         # 单文件最多读的行数
        MAX_LINES_PER_FILE = 40  # 单文件最多返回的匹配行
        MAX_FILES = 120          # 最多返回的文件数
        q_lower = q.lower()
        results = []
        scanned = 0
        # 搜索根：project=<vtop> 优先，缺省当前项目，__all__ 才跨项目
        search_roots = _roots_for_project_arg(qs)
        # 扫描上限按「被搜项目的文件数」自适应，不再固定 6000：
        # 各项目规模差一个量级（微服务 ~3900 / baseline ~18800），固定值会让大项目
        # 永远扫不到结果（DFS 是 LIFO，尾部目录先被扫，配额先耗尽）。
        # 上浮 1.3 倍留余量；超长项目仍靠 MAX_FILES 提前短路。
        MAX_SCAN = _scan_budget(search_roots)
        stack = list(search_roots)
        while stack and len(results) < MAX_FILES and scanned < MAX_SCAN:
            d = stack.pop()
            try:
                entries = os.scandir(d)
            except OSError:
                continue
            for e in entries:
                try:
                    is_dir = e.is_dir(follow_symlinks=False)
                except OSError:
                    continue
                if is_dir:
                    if not is_ignored(e.name):
                        stack.append(e.path)
                    continue
                if not is_searchable_text(e.name):
                    continue
                if ext_filter:
                    _ext = os.path.splitext(e.name)[1].lower().lstrip(".")
                    if _ext != ext_filter:
                        continue
                try:
                    if e.stat(follow_symlinks=False).st_size > 4 * 1024 * 1024:
                        continue   # 跳过 >4MB（多为生成物/数据文件）
                except OSError:
                    continue
                scanned += 1
                if scanned > MAX_SCAN:
                    break
                try:
                    with open(e.path, "r", encoding="utf-8", errors="replace") as fh:
                        # 不能用 fh.readlines(MAX_LINES)：
                        # 它的 hint 是「字符数」而非行数（实测 readlines(5001) 只回 139 行、
                        # readlines(200) 只回 5 行），Windows 文本流尤其明显。
                        # 后果是 30% 的文件被截到前 ~8KB，全项目 76 万行只搜到 32 万行 ——
                        # 代码里明明有，关键字却搜不到（如 HytCustomerServiceImpl 的
                        # recalculateTier 在 L185/L337，文件只读到 139 行）。
                        # islice 按真实行数截断。
                        lines = list(itertools.islice(fh, MAX_LINES))
                except OSError:
                    continue
                matches = []
                for i, ln in enumerate(lines, 1):
                    hit = bool(re_obj.search(ln)) if use_re else (q_lower in ln.lower())
                    if hit:
                        matches.append({"line": i, "text": ln.rstrip("\r\n")[:300]})
                        if len(matches) >= MAX_LINES_PER_FILE:
                            break
                if matches:
                    results.append({"file": rel_of(e.path), "matches": matches})
        self._json({"q": q, "results": results, "truncated": scanned >= MAX_SCAN or len(results) >= MAX_FILES,
                    "scanned": scanned,
                    "scope": "__all__" if len(search_roots) > 1 else _vtop_of(search_roots[0])})

    def _resolve_chain_tail(self, tree, src_path, line, member_col1, name, view_commit, src_text):
        """链式调用末尾成员（qualifier=None）按链头接收者解析：
        取调用行成员名之前最近链（a.b().c() → a）→ 声明类型 → 跨文件找方法定义。
        解析不到返回 None（由调用方维持原行为）。"""
        if not src_text:
            return None
        line_texts = src_text.split("\n")
        if line < 1 or line > len(line_texts):
            return None
        line_text = line_texts[line - 1]
        # javalang 0.13 链尾节点 position 列不可靠（qualifier=None 时列落在成员名 0-based 起点），
        # 从点击列向前找成员名起点（1-based）再回溯链头。
        idx = line_text.rfind(name)
        while idx > member_col1 - 1:
            idx = line_text.rfind(name, 0, idx)
        if idx < 0:
            return None
        head = _chain_head_ident(line_text, idx + 1)
        if not head:
            return None
        recv_type = _receiver_type(tree, head)
        if not recv_type:
            return None
        target = self._resolve_type_file(tree, recv_type, src_path, view_commit)
        if not target:
            pkg = tree.package.name if tree.package else None
            fqn = _type_fqn_in_tree(tree, recv_type, pkg)
            return {"error": "外部/框架方法，无本地定义"} if _is_external_fqn(fqn) else None
        content = self._load_file_content(target, view_commit)
        if content is None:
            return None
        ttree, _err = _java_parse(content)
        if ttree is None:
            return None
        tnode = _find_type_decl(ttree, recv_type)
        if not tnode:
            return None
        mnode = _find_method_decl(ttree, name)
        if not mnode:
            if _type_framework_parent(ttree, tnode):
                return {"error": "外部/框架方法，无本地定义"}
            return None
        impl = None
        if isinstance(tnode, _jt.InterfaceDeclaration):
            impl = self._resolve_impl(target, recv_type, name, view_commit)
        return {"file": target, "line": mnode.position.line, "impl": impl, "kind": "method", "defName": name}

    def _lombok_field_line(self, tree, method_name, src_path, view_commit, depth=0):
        """Lombok getter/setter → 字段声明行（目标类型自身 → extends 父类，最多 2 层）。
        返回行号或 None。"""
        if depth > 2 or not _getter_field_name(method_name):
            return None
        line = _find_field_line(tree, _getter_field_name(method_name) or "", with_lombok=True)
        if line:
            return line
        # 沿继承链找父类字段（如 BasePO 的 id/remark/createTime 等）
        parent = None
        for _path, node in tree:
            if isinstance(node, _jt.ClassDeclaration) and node.position:
                parent = getattr(node, "extends", None)
                break
        if parent is None:
            return None
        pname = getattr(parent, "name", None)
        if not pname:
            return None
        ptarget = self._resolve_type_file(tree, pname, src_path, view_commit)
        if not ptarget:
            return None
        content = self._load_file_content(ptarget, view_commit)
        if content is None:
            return None
        ptree, _err = _java_parse(content)
        if ptree is None:
            return None
        return self._lombok_field_line(ptree, method_name, ptarget, view_commit, depth + 1)

    def _resolve_java_def(self, tree, src_path, line, col1, name, kind, view_commit, src_text=None):
        """核心解析：定位点击 token 的定义。返回 {file,line,impl,kind,defName} 或 {error}。
        src_text 用于链式调用末尾成员（qualifier=None）沿行文本回溯链头。"""
        pkg = tree.package.name if tree.package else None

        if kind == "variable":
            # hljs 把方法引用 ::method 的 token 标成 variable → 按 method 解析（走下方 method 分支）
            _is_mref = False
            if src_text:
                _lt = src_text.split("\n")
                if 1 <= line <= len(_lt):
                    _is_mref = _find_method_ref_text(_lt[line - 1], col1, name) is not None
            if not _is_mref:
                # 字段引用 obj.field：点击列前是 '.obj' 形式 → 接收者类型文件里找字段声明
                fqual = None
                if src_text:
                    _lt2 = src_text.split("\n")
                    if 1 <= line <= len(_lt2):
                        _fm = re.search(r"([A-Za-z_$][\w$]*)\s*\.\s*$", _lt2[line - 1][:col1 - 1].rstrip())
                        if _fm and _fm.group(1) not in ("this", "super"):
                            fqual = _fm.group(1)
                if fqual:
                    frec = _receiver_type(tree, fqual)
                    if frec:
                        ftarget = self._resolve_type_file(tree, frec, src_path, view_commit)
                        if ftarget:
                            fcontent = self._load_file_content(ftarget, view_commit)
                            if fcontent is not None:
                                ftree, _fe = _java_parse(fcontent)
                                if ftree is not None:
                                    fline = _find_field_line(ftree, name, with_lombok=False)
                                    if fline:
                                        return {"file": ftarget, "line": fline, "impl": None, "kind": "field", "defName": name}
                decls = [d for d in _var_decls(tree, name) if d[0]]
                if not decls:
                    return {"error": "未找到定义"}
                decls.sort(key=lambda d: d[0])
                return {"file": src_path, "line": decls[0][0], "impl": None, "kind": "variable", "defName": name}

        if kind == "type":
            tnode = _find_type_decl(tree, name)
            if tnode and tnode.position:
                return {"file": src_path, "line": tnode.position.line, "impl": None, "kind": "type", "defName": name}
            target = self._resolve_type_file(tree, name, src_path, view_commit)
            if not target:
                fqn = _type_fqn_in_tree(tree, name, pkg)
                return {"error": "外部/框架方法，无本地定义" if _is_external_fqn(fqn) else "未找到定义"}
            content = self._load_file_content(target, view_commit)
            if content is None:
                return {"error": "未找到定义"}
            ttree, _err = _java_parse(content)
            if ttree is None:
                return {"error": "未找到定义"}
            tnode = _find_type_decl(ttree, name)
            if not tnode or not tnode.position:
                return {"error": "未找到定义"}
            impl = None
            if isinstance(tnode, _jt.InterfaceDeclaration):
                impl = self._resolve_impl(target, name, None, view_commit)
            return {"file": target, "line": tnode.position.line, "impl": impl, "kind": "type", "defName": name}

        # ---- method ----
        inv = _find_invocation(tree, line, col1, name)
        if inv is None:
            # 方法引用 X::method（非括号调用，javalang MethodReference 无 position → 行文本定位）
            if src_text:
                _lt = src_text.split("\n")
                if 1 <= line <= len(_lt):
                    mqual = _find_method_ref_text(_lt[line - 1], col1, name)
                    if mqual:
                        recv_type = _receiver_type(tree, mqual)
                        if recv_type:
                            return self._resolve_recv_method(tree, src_path, recv_type, name, pkg, view_commit)
                        return {"error": "未找到定义"}
            # 点的是声明本身：接口方法声明 ctrl+click → 跳到实现
            # （Service→Impl 方法行 / Mapper→XML 语句行）；找不到实现维持本文件定义。
            for _path, node in tree:
                if isinstance(node, _jt.MethodDeclaration) and node.name == name and node.position \
                        and node.position.line == line:
                    iface = None
                    for anc in _path:
                        if isinstance(anc, _jt.InterfaceDeclaration):
                            iface = anc
                            break
                    if iface and getattr(iface, "name", None):
                        r = self._resolve_iface_method(src_path, iface.name, name, view_commit)
                        if r is not None:
                            return r
                    return {"file": src_path, "line": line, "impl": None, "kind": "method", "defName": name}
            local = _find_method_decl(tree, name)
            if local:
                return {"file": src_path, "line": local.position.line, "impl": None, "kind": "method", "defName": name}
            return {"error": "未找到定义"}

        qualifier = inv.qualifier
        if not qualifier or qualifier in ("this", "super"):
            local = _find_method_decl(tree, name)
            if local:
                return {"file": src_path, "line": local.position.line, "impl": None, "kind": "method", "defName": name}
            fld = self._lombok_field_line(tree, name, src_path, view_commit)
            if fld:
                return {"file": src_path, "line": fld, "impl": None, "kind": "method", "defName": name}
            # 无 receiver 调用（this/super/裸调用）：本文件无定义时
            # ① 框架父类判定（优先，保持原行为）② 沿本文件类型继承链找父类/接口方法
            # ③ 链式尾部回溯（_resolve_chain_tail）。继承链未命中（error）不能拦截 chain_tail。
            cls = None
            for _path, node in tree:
                if isinstance(node, (_jt.ClassDeclaration, _jt.InterfaceDeclaration)) and node.position:
                    cls = node
                    break
            if cls and _type_framework_parent(tree, cls):
                return {"error": "外部/框架方法，无本地定义"}
            if cls:
                r = self._resolve_recv_chain(tree, src_path, cls.name, name, pkg, view_commit, 0, set())
                if r is not None and "error" not in r:
                    return r
            # W1: javalang 0.13 链式调用末尾成员（a.b().c() 的 c）qualifier=None，
            # 本文件无同名定义时沿调用行文本回溯链头接收者，再走跨文件解析。
            r = self._resolve_chain_tail(tree, src_path, line, col1, name, view_commit, src_text)
            if r is not None:
                return r
            return {"error": "未找到定义"}

        recv_type = _receiver_type(tree, qualifier)
        if not recv_type:
            local = _find_method_decl(tree, name)
            if local:
                return {"file": src_path, "line": local.position.line, "impl": None, "kind": "method", "defName": name}
            return {"error": "未找到定义"}

        r = self._resolve_recv_method(tree, src_path, recv_type, name, pkg, view_commit)
        return r

    def _resolve_recv_method(self, tree, src_path, recv_type, name, pkg, view_commit):
        """接收者类型上的方法解析（跨文件）：类型文件 → 方法声明 / Lombok 字段 / 框架判定。
        方法未命中时沿继承链（extends 父类 / implements 接口）递归，最多 3 层。
        返回结果 dict 或 None（未找到）。"""
        return self._resolve_recv_chain(tree, src_path, recv_type, name, pkg, view_commit, 0, set())

    def _resolve_recv_chain(self, tree, src_path, recv_type, name, pkg, view_commit, depth, visited):
        if depth > 3 or recv_type in visited:
            # 深度超限/继承环：返回 error dict（保持 _resolve_java_def 的 dict 契约，
            # 避免调用方拿到 None 直传 _json）。无 receiver 分支靠 "error" in r 判断跳过链尾逻辑。
            return {"error": "未找到定义"}
        visited.add(recv_type)
        target = self._resolve_type_file(tree, recv_type, src_path, view_commit)
        if not target:
            fqn = _type_fqn_in_tree(tree, recv_type, pkg)
            return {"error": "外部/框架方法，无本地定义" if _is_external_fqn(fqn) else "未找到定义"}
        content = self._load_file_content(target, view_commit)
        if content is None:
            return {"error": "未找到定义"}
        ttree, _err = _java_parse(content)
        if ttree is None:
            return {"error": "未找到定义"}
        tnode = _find_type_decl(ttree, recv_type)
        if not tnode:
            return {"error": "未找到定义"}
        mnode = _find_method_decl(ttree, name)
        if mnode:
            impl = None
            if isinstance(tnode, _jt.InterfaceDeclaration):
                impl = self._resolve_impl(target, recv_type, name, view_commit)
            return {"file": target, "line": mnode.position.line, "impl": impl, "kind": "method", "defName": name}
        fld = self._lombok_field_line(ttree, name, target, view_commit)
        if fld:
            return {"file": target, "line": fld, "impl": None, "kind": "method", "defName": name}
        if _type_framework_parent(ttree, tnode):
            return {"error": "外部/框架方法，无本地定义"}
        # 沿继承链：类 extends 父类 / implements 接口；接口 extends 父接口
        parents = []
        if isinstance(tnode, _jt.InterfaceDeclaration):
            for it in (getattr(tnode, "extends", None) or []):
                nm = getattr(it, "name", None)
                if nm and nm not in parents:
                    parents.append(nm)
        else:
            ext = getattr(tnode, "extends", None)
            if ext and getattr(ext, "name", None):
                parents.append(ext.name)
            for it in (getattr(tnode, "implements", None) or []):
                nm = getattr(it, "name", None)
                if nm and nm not in parents:
                    parents.append(nm)
        for pname in parents:
            if pname in visited:
                continue
            r = self._resolve_recv_chain(tree, src_path, pname, name, pkg, view_commit, depth + 1, visited)
            if r is not None:
                return r
        return {"error": "未找到定义"}

    def _api_java_def(self):
        """POST /api/java/def  body: {path,line,col,text,branch,commit,name,kind}
        用 javalang AST 定位方法/类型/变量定义；跨文件按 import/通配符/同包解析，branch/commit 时取对应版本。"""
        body = self._read_body()
        if body is None:
            return
        try:
            body = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:
            self._json({"error": "bad json"}, 400)
            return
        path = body.get("path")
        text = body.get("text")
        try:
            line = int(body.get("line"))
            col = int(body.get("col"))
        except (TypeError, ValueError):
            line = col = None
        if not path or not path.lower().endswith(".java") or not text or line is None or col is None:
            self._json({"error": "invalid params"}, 400)
            return
        if not isinstance(text, str) or len(text) > self.MAX_TEXT_LEN:
            self._json({"error": "text too large"}, 400)
            return
        branch = body.get("branch") or None
        commit = body.get("commit") or None
        if (branch and not _valid_rev(branch)) or (commit and not _valid_rev(commit)):
            self._json({"error": "invalid branch/commit"}, 400)
            return
        view_commit = commit or branch
        # 路径解析用兜底（老链接常写着已改名的目录，如 gits/employee_ck_test2.0/...），
        # 与读文件接口 /api/code|/api/raw|/api/markdown 保持一致，否则老链接里打开的
        # 文件做 ctrl+点击跳转会误报 invalid params。
        abs_path = self._resolve_read_path(path)
        if not abs_path and not self._path_in_view(path, view_commit):
            self._json({"error": "invalid params"}, 400)
            return
        # 命中兜底时把 path 规范化为磁盘上的真实相对路径（含 vtop 前缀），
        # 下游 _repo_for_rel / _resolve_type_file / _load_file_content 都依赖它定位仓库与兄弟文件
        if abs_path:
            path = rel_of(abs_path)
        name = body.get("name")
        kind = body.get("kind")
        tree, err = _java_parse(text)
        if tree is None:
            self._json({"error": err or "解析失败"})
            return
        if not name:
            lines_txt = text.split("\n")
            if line < 1 or line > len(lines_txt):
                self._json({"error": "未找到定义"})
                return
            ln = lines_txt[line - 1]
            i = min(col, len(ln))
            s = i
            while s > 0 and re.match(r"[A-Za-z0-9_$]", ln[s - 1]):
                s -= 1
            e = i
            while e < len(ln) and re.match(r"[A-Za-z0-9_$]", ln[e]):
                e += 1
            name = ln[s:e]
            if not name:
                self._json({"error": "未找到定义"})
                return
        col1 = col + 1
        if not kind:
            # S1: 自动探测按 method→type→variable 依次尝试，保留第一个 error（更可解释），
            # 避免最后一个 variable 的“未找到定义”覆盖更早的“外部/框架方法”。
            first_err = None
            for k in ("method", "type", "variable"):
                r = self._resolve_java_def(tree, path, line, col1, name, k, view_commit, text)
                if "error" not in r:
                    self._json(r)
                    return
                if first_err is None:
                    first_err = r
            self._json(first_err)
        else:
            self._json(self._resolve_java_def(tree, path, line, col1, name, kind, view_commit, text))

    # ---------- JS / TS / Vue 定义跳转 ----------
    def _api_web_def(self):
        """POST /api/web/def  body: {path, line, col, text, name, kind}
        与 /api/java/def 同契约（file/line/impl?/kind/defName），供前端统一处理。
        覆盖：import/require/dynamic-import 的模块与具名符号、Vue 组件标签 <FooBar/>、
        本文件内的顶层声明。找不到一律 {"error": "未找到定义"}。"""
        body = self._read_body()
        if body is None:
            return
        try:
            body = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:
            self._json({"error": "bad json"}, 400)
            return
        path = body.get("path")
        text = body.get("text")
        try:
            line = int(body.get("line"))
            col = int(body.get("col"))
        except (TypeError, ValueError):
            line = col = None
        if not path or not text or line is None or col is None or not web_defs.is_web_file(path):
            self._json({"error": "invalid params"}, 400)
            return
        if not isinstance(text, str) or len(text) > self.MAX_TEXT_LEN:
            self._json({"error": "text too large"}, 400)
            return
        abs_path = self._resolve_read_path(path)
        if not abs_path:
            self._json({"error": "invalid params"}, 400)
            return
        rel = rel_of(abs_path)
        # web_defs 内部按「项目内相对路径」做目录运算（去掉 vtop 前缀），
        # vtop 由 _web_prefix 在拼回候选时补上。
        first = rel.split("/", 1)[0]
        rel_in_root = rel.split("/", 1)[1] if first in _VTOP and "/" in rel else rel
        name = (body.get("name") or "").strip()
        kind = body.get("kind") or ""
        self._json(self._resolve_web_def(rel, rel_in_root, text, line, col, name, kind))

    def _web_prefix(self, rel_candidate, src_rel):
        """把 web_defs 产出的「项目内相对路径」补成带 vtop 前缀的完整相对路径。
        web_defs 收到的是去掉 vtop 的项目内路径（见 _api_web_def），候选同理。"""
        cand = (rel_candidate or "").replace("\\", "/")
        if not cand:
            return None
        first = src_rel.split("/", 1)[0]
        if first not in _VTOP:
            return cand
        return _join_web_path(first, cand)

    def _web_exists(self, rel):
        """候选相对路径是否存在（走项目内路由，含 vtop 前缀）。"""
        ap = safe_path(rel)
        return bool(ap) and os.path.isfile(ap)

    def _web_load(self, rel):
        ap = safe_path(rel)
        if not ap or not os.path.isfile(ap):
            return None
        try:
            with open(ap, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return None

    def _resolve_web_def(self, rel, rel_in_root, text, line, col, name, kind):
        """核心解析：先按 import/组件标签跨文件，再看本文件内声明。
        rel：带 vtop 的完整相对路径（对外返回用）；rel_in_root：去掉 vtop 的项目内路径（目录运算用）。"""
        # 1) 点击位置落在 import/require 语句上 → 跳模块目标文件（+ 具名符号）
        lines_txt = text.split("\n")
        if 1 <= line <= len(lines_txt):
            for mod, m_line, clause in web_defs._iter_module_specs(text):
                if m_line != line:
                    continue
                mod_cands = web_defs.resolve_module(mod, rel_in_root, text)
                target = None
                for c in mod_cands:
                    full = self._web_prefix(c, rel)
                    if full and self._web_exists(full):
                        target = full
                        break
                if not target:
                    continue      # 外部依赖（vue/axios 等）或路径不存在 → 试下一个
                ttext = self._web_load(target) or ""
                sym = name
                tline = web_defs.find_decl_line(ttext, sym) if sym else None
                if tline is None and sym == "default":
                    tline = web_defs.find_default_export_line(ttext)
                if tline is None:
                    tline = web_defs.find_default_export_line(ttext) or 1
                return {"file": target, "line": tline, "impl": None,
                        "kind": kind or "type", "defName": sym or target.rsplit("/", 1)[-1]}
            # 2) Vue 模板里的组件标签 <FooBar />
            if web_defs.is_vue_file(rel):
                ln_txt = web_defs._strip_comments_line(lines_txt[line - 1])
                for m in web_defs._RE_VUE_TAG.finditer(ln_txt):
                    tag = m.group(1)
                    tag_col = m.start(1) + 1
                    if col < tag_col or col > tag_col + len(tag):
                        continue
                    if tag.lower() in web_defs._VUE_BUILTIN:
                        continue
                    for cand in web_defs.vue_component_candidates(tag, rel_in_root):
                        full = self._web_prefix(cand, rel)
                        if full and self._web_exists(full):
                            ctext = self._web_load(full) or ""
                            dl = web_defs.find_decl_line(ctext, web_defs.pascal_from_tag(tag))
                            return {"file": full, "line": dl or 1, "impl": None,
                                    "kind": "type", "defName": web_defs.pascal_from_tag(tag)}
        # 3) 本文件内的声明（const/function/class/interface/type/enum）
        if name:
            dl = web_defs.find_decl_line(text, name)
            if dl:
                return {"file": rel, "line": dl, "impl": None, "kind": kind or "variable",
                        "defName": name}
            # 3b) 本文件 import 进来的符号 → 跳到来源模块里的声明
            #     （const money = formatMoney(1) 里点 formatMoney，要跳到 ../utils/format 的定义行）
            imp = web_defs.find_imported_symbol(text, name)
            if imp:
                mod, sym = imp
                mod_cands = web_defs.resolve_module(mod, rel_in_root, text)
                for c in mod_cands:
                    full = self._web_prefix(c, rel)
                    if full and self._web_exists(full):
                        ttext = self._web_load(full) or ""
                        # sym 是 _NAMESPACE 哨兵（import * as ns）→ 跳目标文件头
                        if sym is web_defs._NAMESPACE:
                            return {"file": full, "line": 1, "impl": None,
                                    "kind": kind or "type", "defName": name}
                        tline = web_defs.find_decl_line(ttext, sym)
                        if tline is None and sym == "default":
                            tline = web_defs.find_default_export_line(ttext)
                        if tline is None:
                            tline = 1
                        return {"file": full, "line": tline, "impl": None,
                                "kind": kind or "variable", "defName": sym}
        # 4) 点击位置没有可解析的标识符（info.name 为空）→ 从列位置取词
        if not name and 1 <= line <= len(lines_txt):
            ln = web_defs._strip_comments_line(lines_txt[line - 1])
            i = min(col, len(ln))
            s = i
            while s > 0 and re.match(r"[A-Za-z0-9_$]", ln[s - 1]):
                s -= 1
            e = i
            while e < len(ln) and re.match(r"[A-Za-z0-9_$]", ln[e]):
                e += 1
            word = ln[s:e]
            if word:
                dl = web_defs.find_decl_line(text, word)
                if dl:
                    return {"file": rel, "line": dl, "impl": None, "kind": kind or "variable",
                            "defName": word}
        return {"error": "未找到定义"}

    # ---------- dispatch ----------
    def do_GET(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        qs = self._read_query()
        try:
            if path == "/" or path == "/index.html":
                self._serve_file(os.path.join(HERE, "index.html"))
            elif path.startswith("/vendor/"):
                self._serve_file(os.path.join(HERE, path.lstrip("/")))
            elif path == "/api/list":
                self._api_list(qs)
            elif path == "/api/projects":
                self._api_projects(qs)
            elif path == "/api/meta":
                self._api_meta(qs)
            elif path == "/api/files":
                self._api_files(qs)
            elif path == "/api/markdown":
                self._api_markdown(qs)
            elif path == "/api/code":
                self._api_code(qs)
            elif path == "/api/html":
                self._api_html(qs)
            elif path == "/api/raw":
                self._api_raw(qs)
            elif path == "/api/git/meta":
                self._api_git_meta(qs)
            elif path == "/api/git/graph":
                self._api_git_graph(qs)
            elif path == "/api/git/repos":
                self._api_git_repos(qs)
            elif path == "/api/git/diff":
                self._api_git_diff(qs)
            elif path == "/api/git/file":
                self._api_git_file(qs)
            elif path == "/api/sync/status":
                self._api_sync_status(qs)
            elif path == "/api/exists":
                self._api_exists(qs)
            elif path == "/api/search":
                self._api_search(qs)
            else:
                self._json({"error": "not found", "path": path}, 404)
        except Exception as e:  # noqa
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        qs = self._read_query()
        try:
            if path == "/api/save":
                self._api_save(qs)
            elif path == "/api/mermaid/render":
                self._api_mermaid_render()
            elif path == "/api/perf-log":
                self._api_perf_log()
            elif path == "/api/java/def":
                self._api_java_def()
            elif path == "/api/web/def":
                self._api_web_def()
            elif path == "/api/projects":
                self._api_projects_post(qs)
            elif path == "/api/sync/pull":
                self._api_sync_pull()
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa
            self._json({"error": str(e)}, 500)

    def _api_projects_post(self, qs):
        """项目增删切：{action: add|remove|switch, path?, name?}
        add：追加工作区根（持久化到 projects.json）；remove：移除（已开标签由前端关闭）；
        switch：name=项目 vtop 名或 ""（聚合）。

        全程持 _PROJECTS_LOCK：ThreadingHTTPServer 是多线程的，而 ROOTS/_VTOP/_CURRENT
        都是模块级可变状态，两个 add/remove 并发会「读-改-写」丢失更新（同时加两个项目，
        后写的把前一个覆盖掉），甚至切出不一致的根列表。
        """
        global _CURRENT
        try:
            body = json.loads(self._read_body().decode("utf-8", errors="replace") or "{}")
        except Exception:
            self._json({"error": "bad json"}, 400)
            return
        action = body.get("action")
        with _PROJECTS_LOCK:
            if action == "add":
                p = (body.get("path") or "").strip()
                if not p or not os.path.isdir(p):
                    self._json({"error": "目录不存在: " + p}, 400)
                    return
                # realpath 归一后再查重：同一目录用不同写法（尾斜杠/短路径/..）传入
                # 会绕过比较被当成新项目，加出重名 vtop。父子目录也算冲突（会造成嵌套根）。
                p = os.path.realpath(os.path.abspath(p))
                if any(_within(p, r) or _within(r, p) for r in ROOTS):
                    self._json({"error": "项目已存在（或与已有项目存在父子包含关系）"}, 400)
                    return
                _setup_roots(ROOTS + [p])
                if not _save_project_roots():
                    self._json({"error": "项目列表保存失败（见服务端日志）"}, 500)
                    return
                self._json({"ok": True, "name": _VTOP_SEQ.get(p, ""),
                           "projects": self._projects_snapshot()})
            elif action == "remove":
                name = body.get("name")
                if name not in _VTOP:
                    self._json({"error": "项目不存在: " + name}, 400)
                    return
                p = _VTOP[name]
                if len(ROOTS) <= 1:
                    self._json({"error": "至少保留一个项目"}, 400)
                    return
                _setup_roots([r for r in ROOTS
                              if _root_real(r) != _root_real(p)])
                if not _save_project_roots():
                    self._json({"error": "项目列表保存失败（见服务端日志）"}, 500)
                    return
                self._json({"ok": True, "projects": self._projects_snapshot()})
            elif action == "switch":
                name = body.get("name") or ""
                if name and name not in _VTOP:
                    self._json({"error": "项目不存在: " + name}, 400)
                    return
                _CURRENT = name or None
                if not _save_project_roots():
                    self._json({"error": "项目列表保存失败（见服务端日志）"}, 500)
                    return
                self._json({"ok": True, "current": _CURRENT})
            else:
                self._json({"error": "unknown action"}, 400)

    def _projects_snapshot(self):
        return {"current": _CURRENT, "single": len(ROOTS) == 1,
                "projects": [{"name": n, "path": r} for n, r in sorted(_VTOP.items())]}

    # ---------- 同步 ----------
    def _api_sync_status(self, qs):
        """GET /api/sync/status[?fetch=1]

        fetch=1 时会联网取远端（慢，几秒），默认不 fetch —— 面板打开时只想显示
        「当前版本 + 远端地址」，按了「检查更新」才真的联网。"""
        want_fetch = (qs.get("fetch") or ["0"])[0] in ("1", "true", "yes")
        try:
            self._json(sync_status(fetch=want_fetch))
        except Exception as e:  # noqa
            self._json({"ok": False, "error": str(e)}, 500)

    def _api_sync_pull(self):
        """POST /api/sync/pull —— 唯一会改写工作区文件的同步接口。"""
        try:
            r = sync_pull()
            # 脏工作区/拉取失败不是服务器错误，是用户要看的业务结果 → 200 带 ok:false
            self._json(r, 200)
        except Exception as e:  # noqa
            self._json({"ok": False, "error": str(e)}, 500)


def main():
    global PORT, ROOT
    import argparse
    ap = argparse.ArgumentParser(description="Markdown Reader local server")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--root", action="append", default=[], help="工作区根（可多次指定实现多项目聚合；默认：工具目录上两级）")
    ap.add_argument("--roots", default="", help="逗号分隔的多个工作区根（等价于多次 --root）")
    ap.add_argument("--sync-repo", default="", help="同步用的远程仓库地址（覆盖代码内置默认值；也可写 sync.json）")
    ap.add_argument("--sync-branch", default="", help="同步用的分支（默认 master）")
    args = ap.parse_args()
    PORT = args.port
    # CLI 同步参数 > sync.json > 代码内置默认值。CLI 优先级最高：临时用别的远端
    # 试一下时不该为此改文件（改了还得记得改回来）。
    global DEFAULT_SYNC_REPO, DEFAULT_SYNC_BRANCH
    if args.sync_repo:
        DEFAULT_SYNC_REPO = args.sync_repo
    if args.sync_branch:
        DEFAULT_SYNC_BRANCH = args.sync_branch
    roots = list(args.root)
    if args.roots:
        roots += [r.strip() for r in args.roots.split(",") if r.strip()]
    roots = _load_project_roots(roots)   # 合并 projects.json 持久化项目
    if not roots:
        roots = [ROOT]
    _setup_roots(roots)
    # 无效根（被移动/删除）跳过不退出，避免 projects.json 残留路径导致启动失败
    valid = [r for r in ROOTS if os.path.isdir(r)]
    if len(valid) != len(ROOTS):
        dropped = [r for r in ROOTS if not os.path.isdir(r)]
        print("跳过不可用的工作区根（目录不存在）:")
        for r in dropped:
            print("    -", r)
        _setup_roots(valid)
    if not ROOTS:
        print("no valid root")
        sys.exit(1)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("=" * 56)
    print("  Markdown Reader")
    if len(ROOTS) == 1:
        print("  工作区根: %s" % ROOTS[0])
    else:
        print("  工作区根（%d 个，顶层聚合）:" % len(ROOTS))
        for name, r in sorted(_VTOP.items()):
            print("    - %s -> %s" % (name, r))
    if _CURRENT:
        print("  当前项目: %s" % _CURRENT)
    print("  打开: http://127.0.0.1:%d/" % PORT)
    print("  Ctrl+C 退出")
    print("=" * 56)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
