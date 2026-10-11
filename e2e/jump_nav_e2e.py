# -*- coding: utf-8 -*-
"""
E2E：代码窗口来回跳转扒业务逻辑（markdown-reader 点击跳转 + 跳转历史）

模拟真实 debug/梳理业务场景：打开大 Java 文件 → Ctrl+点击方法调用逐层追踪
（Controller→Service→Impl→Facade→DTO），随时 Alt+←/→ 返回前进、再继续下一层，
穿插变量跳转 / Lombok getter / 方法引用 / 接口→实现 / 多仓库同名类。

运行方式（依赖 browser-harness 的预导入 helpers：js/cdp/goto_url/ensure_real_tab/
wait_for_load；页面 http://127.0.0.1:8765）：
  1) 启动 server:  cd tools/markdown-reader && python server.py
  2) 在本仓库 Hermes 会话中通过 browser_exec 执行：
       exec(open(r"<绝对路径>/e2e/jump_nav_e2e.py", encoding="utf-8").read())
     （或 browser-harness < e2e/jump_nav_e2e.py，需 daemon 连通）
退出码：0=全部通过，1=存在失败。结束时清理 localStorage（7 个键）还原默认。

测试不改任何源码；跳转目标行号以服务端解析为准（含 Lombok/方法引用等扩展）。
"""

import json
import time
import sys

BASE_URL = "http://127.0.0.1:8765/"
WS = None  # 工作区根：优先 MDREADER_WS 环境变量，否则取 server.py 的默认 ROOT（工具目录上两级）
import sys as _sys
import os as _os
try:
    _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
    import server as _srv
    WS = _os.environ.get("MDREADER_WS") or _srv.ROOT
except Exception:
    WS = _os.environ.get("MDREADER_WS") or r"C:\Users\1\Desktop\work\tasks\20260917-微服务"

# ---------------- 真实业务跳转链数据（已用服务端解析逐一核对） ----------------
P = "gits/promotion/src/main/java/com/pvh/promotion/service/impl/CouponCustomerServiceImpl.java"
PF = "gits/promotion/src/main/java/com/pvh/promotion/facade/CustomerFacade.java"
PFI = "gits/promotion/src/main/java/com/pvh/promotion/facade/impl/CustomerFacadeImpl.java"
PDTO = "gits/promotion/src/main/java/com/pvh/promotion/model/dto/CouponCustomerDTO.java"
CC = "gits/customer/src/main/java/com/pvh/customer/controller/AccountConfigCustomerController.java"
CS = "gits/customer/src/main/java/com/pvh/customer/service/AccountConfigCustomerService.java"
CSI = "gits/customer/src/main/java/com/pvh/customer/service/impl/AccountConfigCustomerServiceImpl.java"
UF = "gits/user/src/main/java/com/pvh/user/facade/CustomerFacade.java"
UFI = "gits/user/src/main/java/com/pvh/user/facade/impl/CustomerFacadeImpl.java"
RF = "gits/report/src/main/java/com/pvh/report/facade/CustomerFacade.java"
RFI = "gits/report/src/main/java/com/pvh/report/facade/impl/CustomerFacadeImpl.java"
CM = "gits/customer/src/main/java/com/pvh/customer/mapper/CustomerMapper.java"
CMX = "gits/customer/src/main/resources/mapper/CustomerMapper.xml"

# ---------------- 断言收集 ----------------
CHECKS = []
PERF = []

def check(ok, msg, detail=""):
    CHECKS.append(ok)
    tag = "PASS" if ok else "FAIL"
    print(f"  [{tag}] {msg}" + (f"  ({detail})" if detail else ""))
    return ok

# ---------------- 浏览器辅助（真实事件） ----------------
def open_file(path, line=None, settle=2.2):
    js("openTab({}, {})".format(json.dumps(path), json.dumps({"focus": True})))
    t0 = time.monotonic()
    while time.monotonic() - t0 < 8:
        t = js("(() => { const t = curActiveTab(); return t ? t.path : null; })()")
        if t == path:
            break
        time.sleep(0.25)
    time.sleep(settle)
    if line:
        js("(() => { const ct = document.querySelector('#ct-scroll'); ct.scrollTop = Math.max(0, (arguments[0]-1) * (document.querySelector('.cl-line')?.offsetHeight || 20) - ct.clientHeight/2); return 1; })()".replace("arguments[0]", str(line)))
        time.sleep(0.8)

def token_pos(line, token, retry=8):
    """在行内找 token span 的视口中心；虚拟滚动未渲染时重试（每 150ms）"""
    for _ in range(retry):
        pos = js("""(() => {
          const l = document.querySelector('#ct-scroll .cl-line[data-line="%d"]');
          if (!l) return null;
          const code = l.querySelector('.cl-code');
          const toks = Array.from(code.querySelectorAll('span')).filter(s => s.textContent === %s);
          if (!toks.length) return null;
          const r = toks[0].getBoundingClientRect();
          return {x: r.x + r.width/2, y: r.y + r.height/2};
        })()""" % (line, json.dumps(token)))
        if pos:
            return pos
        time.sleep(0.15)
    return None

def path_matches(actual, expect):
    """路径匹配：单项目全等；多项目时服务端返回带 vtop 前缀（如 <项目名>/gits/...），
    因此期望路径既接受全等，也接受「以期望路径结尾」的前缀形式。"""
    if not actual or not expect:
        return False
    a, e = actual.replace("\\", "/"), expect.replace("\\", "/")
    return a == e or a.endswith("/" + e)

def active_tab():
    return js("(() => { const t = curActiveTab(); return t ? {path: t.path, line: t.jumpLine || null} : null; })()")

def wait_tab(expect, timeout=7, line=None):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        t = active_tab()
        if t and path_matches(t["path"], expect) and (line is None or t["line"] == line):
            return t
        time.sleep(0.2)
    return active_tab()

def ctrl_click(line, token, expect_path, expect_line=None, timeout=8):
    """真实 Ctrl+点击 token → 等待跳转到期望文件（可选行）。返回 (ok, active, ms)"""
    pos = token_pos(line, token)
    if not pos:
        check(False, f"Ctrl+点击 {token}@L{line}: token 未找到")
        return False, None, 0
    t0 = time.monotonic()
    cdp("Input.dispatchMouseEvent", type="mousePressed", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
    cdp("Input.dispatchMouseEvent", type="mouseReleased", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
    t = wait_tab(expect_path, timeout=timeout, line=expect_line)
    ms = round((time.monotonic() - t0) * 1000)
    PERF.append(ms)
    ok = bool(t) and path_matches(t["path"], expect_path) and (expect_line is None or t["line"] == expect_line)
    cur = t["path"].split("/")[-1] + (f":{t['line']}" if t["line"] else "")
    expect = expect_path.split("/")[-1] + (f":{expect_line}" if expect_line else "")
    check(ok, f"Ctrl+点击 {token}@L{line} → {expect}", f"实际 {cur}, {ms}ms")
    return ok, t, ms

def press_nav(direction):
    """真实 Alt+← / Alt+→"""
    key = "ArrowLeft" if direction == "back" else "ArrowRight"
    cdp("Input.dispatchKeyEvent", type="keyDown", key=key, code=key, modifiers=1)
    cdp("Input.dispatchKeyEvent", type="keyUp", key=key, code=key, modifiers=1)
    time.sleep(1.8)

def nav_expect(direction, expect_path, expect_line=None, timeout=7):
    press_nav(direction)
    t = wait_tab(expect_path, timeout=timeout, line=expect_line)
    ok = bool(t) and path_matches(t["path"], expect_path) and (expect_line is None or t["line"] == expect_line)
    cur = t["path"].split("/")[-1] + (f":{t['line']}" if t["line"] else "") if t else "None"
    expect = expect_path.split("/")[-1] + (f":{expect_line}" if expect_line else "")
    check(ok, f"Alt+{'←' if direction=='back' else '→'} → {expect}", f"实际 {cur}")
    return ok, t

def hist_state():
    return js("""(() => JSON.stringify({
      stack: navHist.stack.map(h => h.path.split('/').pop() + ':' + (h.line || '-')),
      idx: navHist.idx,
      back: !document.querySelector('#nav-back').disabled,
      fwd: !document.querySelector('#nav-fwd').disabled,
      len: navHist.stack.length,
    }))()""")

def toast_now():
    return js("(() => { const t = document.querySelector('.toast, #toast'); return t ? t.textContent.trim() : ''; })()")

def jump_flash(line):
    return js("""(() => !!document.querySelector('#ct-scroll .cl-line[data-line="%d"].jump-flash'))()""" % line)

def flash_ov_count(timeout=2.5):
    """落地目标行 flash overlay（.jump-flash-ov，fixed 层，跨文件跳转时目标行可见）"""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        n = js("document.querySelectorAll('.jump-flash-ov').length")
        if n:
            return n
        time.sleep(0.1)
    return 0

# ================= 场景 1：promotion 核心业务链（Lombok/方法引用/变量/接口→impl） =================
def scene1():
    print("\n[场景1] promotion 优惠券业务链逐层追踪 + 全链回退")
    ok = True
    # 起点：大文件 1489 行，滚动到 1155
    open_file(P, 1155)
    ok &= check(path_matches(active_tab()["path"], P), "打开 CouponCustomerServiceImpl.java 滚动到 L1155")
    # 1.1 调用处 → 接口
    ok &= ctrl_click(1155, "queryCouponCustomerBirthdayDTO", PF, 33)[0]
    hs = json.loads(hist_state())
    ok &= check(hs["back"], "返回按钮已可用", str(hs["stack"][-2:]))
    # 1.2 接口声明 → 实现
    ok &= ctrl_click(33, "queryCouponCustomerBirthdayDTO", PFI, 183)[0]
    # 1.3 Lombok setter → 字段声明行
    open_file(P, 90)
    ok &= ctrl_click(90, "setCustomerIds", PDTO, 19)[0]
    # 1.4 链式中间成员 getter → 字段声明行
    open_file(P, 95)
    ok &= ctrl_click(95, "getCustomerIds", PDTO, 19)[0]
    # 1.5 方法引用 ::getUsedOrder
    open_file(P, 130)
    ok &= ctrl_click(130, "getUsedOrder", PDTO, 73)[0]
    # 1.6 全链回退：按真实入栈顺序逐级 Alt+← 验证每步位置
    # 入栈序列：[P:1155, CF:33, CFI:183, P:90, PDTO:19, P:95, PDTO:19, P:130, PDTO:73]
    # back 期望 = 回退后所在位置（不含栈顶本身）：PDTO:73 之后依次回 P:130 → PDTO:19 → ...
    back_seq = [(P, 130), (PDTO, 19), (P, 95), (PDTO, 19), (P, 90), (PFI, 183), (PF, 33), (P, 1155)]
    for i, (bp, bl) in enumerate(back_seq):
        nav_expect("back", bp, bl)
    # 1.7 前进逐级恢复（栈尾反向，不含起点）
    fwd_seq = [(PF, 33), (PFI, 183), (P, 90), (PDTO, 19), (P, 95), (PDTO, 19), (P, 130), (PDTO, 73)]
    for fp, fl in fwd_seq:
        nav_expect("fwd", fp, fl)
    return ok

# ================= 场景 2：变量跳转 + 即时反馈 + 跨仓库 =================
def scene2():
    print("\n[场景2] 变量→声明、jump-flash 即时反馈、customer/user/report 多仓库")
    ok = True
    # MDREADER_S2="b" 只跑 2.3-2.6（分段跑避免单会话交互过多触发 daemon 退化）
    s2part = _os.environ.get("MDREADER_S2", "")
    if s2part != "b":
        # 2.1 变量→声明行（本文件 localJump：1156 行 return couponCustomerBirthdayDTOPage → 声明 1155）
        use_line = 1156
        open_file(P, use_line)
        ok &= ctrl_click(use_line, "couponCustomerBirthdayDTOPage", P, 1155)[0]
        # 同文件跳转也触发 openTab 重渲染（点击行 class 会被重建吞掉）→ 目标行 overlay flash 是反馈载体
        n = flash_ov_count()
        ok &= check(n >= 1, "同文件跳转落地目标行 flash overlay 出现", f"ov={n}")
        # 2.2 跨文件跳转：落地目标行出现 flash overlay（源行 class 被 tab 切换重建吞掉，靠目标行反馈）
        open_file(P, 90)
        pos = token_pos(90, "setCustomerIds")
        if pos:
            cdp("Input.dispatchMouseEvent", type="mousePressed", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
            cdp("Input.dispatchMouseEvent", type="mouseReleased", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
            t = wait_tab(PDTO, 7, 19)
            n = flash_ov_count()
            ok &= check(bool(t) and n >= 1, "跨文件跳转落地目标行 flash overlay 出现", f"ov={n}, tab={'OK' if t else 'NONE'}")
        else:
            check(False, "flash 场景 token 未找到")
    # 2.3 customer Controller → Service 接口
    if s2part in ("b", "c", ""):
        open_file(CC, 50)
        ok &= ctrl_click(50, "queryByPage", CS, 19)[0]
        # 2.4 Service 接口声明 → impl
        ok &= ctrl_click(19, "queryByPage", CSI, 40)[0]
    # 2.5 user 仓库同名 CustomerFacade → user 的 impl
    if s2part in ("c", ""):
        open_file(UF, 13)
        ok &= ctrl_click(13, "matchCustomer", UFI, None)[0]
        # 2.6 report 仓库同名 CustomerFacade → report 的 impl
        open_file(RF, 13)
        ok &= ctrl_click(13, "getUserInfoByMobileList", RFI, None)[0]
    return ok

# ================= 场景 3：历史栈不变式 + 前进分支截断 =================
def scene3():
    print("\n[场景3] 历史栈不变式与前进分支截断")
    ok = True
    # 3.1 连续 3 跳 A→B→C
    open_file(P, 1155)
    ctrl_click(1155, "queryCouponCustomerBirthdayDTO", PF, 33)
    ctrl_click(33, "queryCouponCustomerBirthdayDTO", PFI, 183)
    h = json.loads(hist_state())
    ok &= check(h["idx"] == h["len"] - 1 and h["back"] and not h["fwd"], "栈尾一致 + back 可用 + fwd 不可用", f"len={h['len']} idx={h['idx']}")
    ok &= check(h["stack"][-3:] == ["CouponCustomerServiceImpl.java:1155", "CustomerFacade.java:33", "CustomerFacadeImpl.java:183"],
                "栈内容正确", str(h["stack"][-3:]))
    # 3.2 回退两级到 A（1155）
    nav_expect("back", PF, 33)
    nav_expect("back", P, 1155)
    h = json.loads(hist_state())
    ok &= check(h["fwd"], "回退后 fwd 可用")
    # 3.3 从 A 跳 D（不同目标）→ 前进分支被截断（idx 之后的旧条目移除）
    open_file(P, 90)
    ctrl_click(90, "setCustomerIds", PDTO, 19)
    h = json.loads(hist_state())
    ok &= check(h["stack"][-2:] == ["CouponCustomerServiceImpl.java:90", "CouponCustomerDTO.java:19"],
                "前进分支截断：栈尾=[A', D]（旧 B/C 被移除）", str(h["stack"][-3:]))
    ok &= check(not h["fwd"], "截断后 fwd 不可用")
    # 3.4 相邻去重：同源同目标重复跳转只入栈一次（首次 +2；回退到源位置后重跳，源被去重只 +1）
    open_file(P, 1155)
    ctrl_click(1155, "queryCouponCustomerBirthdayDTO", PF, 33)   # 首次：+源 +目标 = +2
    nav_expect("back", P, 1155)                                   # 回退到源位置（栈顶即 P:1155）
    before = json.loads(hist_state())["len"]
    pos = token_pos(1155, "queryCouponCustomerBirthdayDTO")
    cdp("Input.dispatchMouseEvent", type="mousePressed", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
    cdp("Input.dispatchMouseEvent", type="mouseReleased", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
    wait_tab(PF, 7, 33)
    after = json.loads(hist_state())["len"]
    tail = json.loads(hist_state())["stack"][-2:]
    ok &= check(after == before and tail == ["CouponCustomerServiceImpl.java:1155", "CustomerFacade.java:33"],
                "相同位置重复跳转幂等：源去重 + 目标截断重推，栈内容不变", f"{before}→{after}, tail={tail}")
    return ok

# ================= 场景 4：容量上限 200 =================
def scene4():
    print("\n[场景4] 历史栈容量上限 200")
    n = js("(() => { for (let i = 0; i < 205; i++) pushNav('容量测试_' + i + '.java', i); return navHist.stack.length; })()")
    ok = check(n == 200, "205 次入栈后栈长度截断为 200", f"len={n}")
    head = js("navHist.stack[0].path")
    ok &= check("容量测试_5" in head, "最旧条目被移除", f"head={head}")
    # 清理容量测试产生的历史
    js("(() => { navHist.stack = navHist.stack.filter(h => !h.path.includes('容量测试')); navHist.idx = Math.max(-1, navHist.idx - 1); updateNavButtons(); return navHist.stack.length; })()")
    return ok

# ================= 场景 5：失败提示不误报 =================
def scene5():
    print("\n[场景5] 全部真实跳转无「未找到定义」误报")
    # 场景1-3 的每次点击后若有 toast 会在此时暴露（toast 3s 消失，这里抽查一次核心跳转）
    open_file(P, 1155)
    pos = token_pos(1155, "queryCouponCustomerBirthdayDTO")
    cdp("Input.dispatchMouseEvent", type="mousePressed", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
    cdp("Input.dispatchMouseEvent", type="mouseReleased", x=pos["x"], y=pos["y"], button="left", clickCount=1, modifiers=2)
    time.sleep(0.4)
    t = toast_now()
    ok = check("未找到" not in t, "核心调用跳转无「未找到定义」toast", f"toast={t!r}")
    wait_tab(PF, 7, 33)
    return ok

# ================= 场景 6：性能护栏 =================
def scene6():
    print("\n[场景6] 跳转耗时护栏（P95 < 1000ms）")
    if not PERF:
        return check(True, "无跳转样本")
    PERF.sort()
    p95 = PERF[int(len(PERF) * 0.95) - 1]
    mx = PERF[-1]
    avg = sum(PERF) / len(PERF)
    print(f"  样本 {len(PERF)} 次：avg={avg:.0f}ms  p95={p95}ms  max={mx}ms")
    return check(p95 < 1000, f"P95 {p95}ms < 1000ms", f"max={mx}ms")

# ================= 场景 7：清理还原 =================
def scene7():
    print("\n[场景7] 清理 localStorage 还原默认")
    js("""(() => {
      ['mdreader.tasks.v1','mdreader.tree.v1','mdreader.treeWidth.v1','mdreader.recent.v1','mdreader.bookmarks.v1','mdreader.folds.v1','mdreader.gsearch.v1'].forEach(k => localStorage.removeItem(k));
      return 1;
    })()""")
    goto_url(BASE_URL)
    wait_for_load()
    time.sleep(1.2)
    st = js("(() => JSON.stringify({tasks: state.tasks.map(t => t.name), tabs: curTabs().length, hist: navHist.stack.length}))()")
    ok = check("默认" in st and '"tabs":1' in st.replace(" ", ""), "还原默认状态", st)
    return ok

# ================= 主流程 =================
def main():
    ensure_real_tab()
    goto_url(BASE_URL)
    wait_for_load()
    time.sleep(1.5)
    js("""(() => { try { ['mdreader.tasks.v1','mdreader.tree.v1','mdreader.treeWidth.v1','mdreader.recent.v1','mdreader.bookmarks.v1','mdreader.folds.v1','mdreader.gsearch.v1'].forEach(k => localStorage.removeItem(k)); } catch(e) {} return 1; })()""")
    goto_url(BASE_URL)
    wait_for_load()
    time.sleep(1.5)
    t0 = time.monotonic()
    # MDREADER_SCENES 环境变量可过滤场景（逗号分隔，如 "scene2,scene3"）：
    # 长会话 CDP 断线时按场景分批跑（每个 browser_exec 调用是独立 daemon）
    only = set(s.strip() for s in _os.environ.get("MDREADER_SCENES", "").split(",") if s.strip())
    all_scenes = (scene1, scene2, scene3, scene4, scene5, scene6)
    scenes = [fn for fn in all_scenes if not only or fn.__name__ in only]
    for fn in scenes:
        try:
            fn()
        except Exception as e:
            import traceback
            # 长会话 CDP 断线自愈：重连浏览器 + 重载页面 + 该场景重跑一次
            # （每个场景都从 open_file 重建自身状态，reload 只丢跨场景的 navHist 残留，不丢场景内前提）
            print(f"  [WARN] {fn.__name__} 首次执行异常（可能是 CDP 断线）：{e!r}，重连重试")
            try:
                ensure_real_tab()
                goto_url(BASE_URL)
                wait_for_load()
                time.sleep(1.5)
                fn()
            except Exception as e2:
                check(False, f"{fn.__name__} 重试后仍异常", repr(e2))
                traceback.print_exc()
    elapsed = round(time.monotonic() - t0)
    failed = sum(1 for c in CHECKS if not c)
    print("\n" + "=" * 46)
    print(f"E2E 结果：{len(CHECKS) - failed}/{len(CHECKS)} 通过，{failed} 失败，耗时 {elapsed}s")
    print("=" * 46)
    scene7()
    sys.exit(1 if failed else 0)

# 入口：直接调用（兼容 browser-harness 的 exec(code, globals()) 运行方式，
# 该环境下 __name__ 不是 "__main__"，不能用 if __name__ 守卫）
main()
