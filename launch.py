#!/usr/bin/env python3
"""Markdown Reader 一键启动（支持多开 / 自定义工作区 / 工具目录移动后使用）

用法：
  python launch.py                       # 默认：工作区=工具目录上两级，端口 8765，自动开浏览器
  python launch.py --root D:/proj        # 指定工作区根
  python launch.py --port 8766           # 换端口（多开：每个实例用不同端口）
  python launch.py --roots D:/projA,D:/projB   # 多项目聚合：单实例同时浏览多个工作区根
  python launch.py --root D:/proj --port 8766 --no-open
  python launch.py --reuse               # 端口已被占用时直接打开浏览器（假定是已运行的实例）

说明：
  - 工具目录可移到任意位置（无任何路径绑定）；工作区根用 --root/--roots 指定，默认取工具目录上两级
  - 多项目聚合（--roots 或多个 --root）：单实例文件树顶层显示各项目目录（按根目录名），
    可同时浏览/搜索/代码跳转多个项目的文件；同一项目可再开不同端口的独立实例
  - server 在独立控制台窗口运行，关闭本窗口不影响已启动的 server
"""
import argparse
import os
import socket
import subprocess
import sys
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server.py")
DEFAULT_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    ap = argparse.ArgumentParser(description="Markdown Reader 一键启动（支持多开/多项目聚合）")
    ap.add_argument("--root", action="append", default=[], help="工作区根（可多次指定；默认：工具目录上两级）")
    ap.add_argument("--roots", default="", help="逗号分隔的多个工作区根（多项目聚合，等价于多次 --root）")
    ap.add_argument("--port", type=int, default=8765, help="端口（多开时每个实例用不同端口）")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--reuse", action="store_true", help="端口已被占用时直接打开浏览器（假定是已运行的 Reader 实例）")
    args = ap.parse_args()

    roots = list(args.root)
    if args.roots:
        roots += [r.strip() for r in args.roots.split(",") if r.strip()]
    if not roots:
        roots = [DEFAULT_ROOT]
    root = os.path.abspath(roots[0])
    for r in roots:
        if not os.path.isdir(os.path.abspath(r)):
            print(f"[启动] 工作区根不存在: {r}")
            sys.exit(1)
    if port_in_use(args.port):
        if args.reuse:
            print(f"[启动] 端口 {args.port} 已被占用，直接打开浏览器（假定是已运行的 Reader 实例）")
        else:
            print(f"[启动] 端口 {args.port} 已被占用。多开请用不同端口，例如：")
            print(f"        python launch.py --root <工作区> --port {args.port + 1}")
            sys.exit(1)

    url = f"http://127.0.0.1:{args.port}/"
    if len(roots) > 1:
        print(f"[启动] 工作区根（{len(roots)} 个聚合）:")
        for r in roots:
            print(f"        - {os.path.abspath(r)}")
    else:
        print(f"[启动] 工作区: {root}")
    print(f"[启动] 地址:   {url}")
    flags = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0
    cmd = [sys.executable, SERVER, "--port", str(args.port)]
    for r in roots:
        cmd += ["--root", os.path.abspath(r)]
    proc = subprocess.Popen(cmd, creationflags=flags)
    ok = False
    for _ in range(50):
        if port_in_use(args.port):
            ok = True
            break
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    if not ok:
        print(f"[启动] server 进程异常退出（exit code {proc.returncode}），见 server 窗口输出")
        sys.exit(1)
    if not args.no_open:
        webbrowser.open(url)
    print(f"[启动] 完成（server PID {proc.pid}，独立窗口，关闭本窗口不影响）")


if __name__ == "__main__":
    main()
