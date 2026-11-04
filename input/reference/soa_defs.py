# -*- coding: utf-8 -*-
"""SOA（远程调用）跳转适配层 —— 可拆卸。

server.py 只在「通用 Java 解析没命中」时调用本模块的两个钩子：

    resolve_type(ctx)   类型名     → 类文件（项目内相对路径）
    resolve_impl(ctx)   接口       → 服务端实现类文件（项目内相对路径）

本模块不 import server，只用 ctx 提供的原语（读文件 / 列仓库 / 按包路径找类 /
按正则 grep / 方法行号），因此：

  * 删掉本文件、或把 ADAPTERS 清空 → 回到纯通用行为，其它功能不受影响；
  * 换一个远程调用框架 = 换掉/追加一个适配器，server.py 一行不用动。

新增框架适配：

    class MyAdapter(SoaAdapter):
        name = "my-soa"
        def resolve_impl(self, ctx):
            ...          # 返回实现类相对路径，或 None（本框架不处理）
    register(MyAdapter())

当前适配器：OdySoaAdapter —— odianyun（ody）SOA 约定
    客户端 SDK：ody.soa.<域>.<Service> 接口，注解
        @SoaServiceClient(name = "<服务池>", interfaceName = "<接口 FQN>")
    服务端实现：另一个 maven 模块里的类，注解
        @SoaServiceRegister(interfaceClass = <接口 FQN>.class)
    并且 implements <接口名>；实现类与 SDK 接口不在同一个模块里，
    所以通用的「<接口>Impl.java 同名搜索」不一定命中，需要按注解/implements 找。
    请求/响应 DTO：ody.soa.<域>.request / .response 包下，常被业务模块通配符导入
    （import ody.soa.product.request.*），类型定义在 soa-sdk-jar 里。
"""

import re
import time

# 适配器注册表（按顺序尝试，第一个给出结果的生效）
ADAPTERS = []


class SoaAdapter(object):
    """框架适配器基类。两个钩子都可以返回 None（表示本框架不处理）。"""

    name = "base"

    def resolve_type(self, ctx):
        """类型名 → 类文件相对路径（项目内相对路径）。"""
        return None

    def resolve_impl(self, ctx):
        """接口 → 服务端实现类文件相对路径（项目内相对路径）。"""
        return None


def register(adapter):
    """注册一个适配器（返回它，方便子类自注册）。"""
    ADAPTERS.append(adapter)
    return adapter


def resolve_type(ctx):
    for ad in ADAPTERS:
        try:
            hit = ad.resolve_type(ctx)
        except Exception:
            hit = None
        if hit:
            return hit
    return None


def resolve_impl(ctx):
    for ad in ADAPTERS:
        try:
            hit = ad.resolve_impl(ctx)
        except Exception:
            hit = None
        if hit:
            return hit
    return None


class OdySoaAdapter(SoaAdapter):
    """odianyun（ody）SOA 约定。

    客户端：SDK jar（soa-sdk-jar）里的接口 ody.soa.<域>.<Service>，类上带
        @SoaServiceClient(name = "<服务池名>", interfaceName = "<接口 FQN>")
    服务端：实现类在另一个 maven 模块（如 back-product-web-jar/product-api），
        类上带 @SoaServiceRegister(interfaceClass = <接口 FQN>.class)，并 implements <接口名>。
    """

    name = "ody-soa"
    SDK_PKG_PREFIX = "ody.soa."

    _RE_CLIENT = re.compile(r"@SoaServiceClient\s*\(([^)]*)\)", re.S)
    _RE_POOL = re.compile(r"\bname\s*=\s*\"([^\"]+)\"")
    _RE_PKG = re.compile(r"^\s*package\s+([\w.]+)\s*;", re.M)
    _RE_IMPORT = re.compile(r"^\s*import\s+([\w.]+(?:\.\*)?)\s*;", re.M)
    _RE_CLASS_DECL = re.compile(r"\bclass\s+\w+[^{;]*\bimplements\b[^{;]*")
    # 一次点击最多扫多少个仓库（每个仓库一次 git grep ~0.1s，别让点击卡住）
    MAX_REPOS = 12
    # 接口 → 实现类的查找结果缓存（TTL 秒）。
    # 为什么要缓存：一次查找要跑好几次 git grep（每个候选仓库一次），
    # 机器负载高时可能好几秒 —— 而同一个接口会被反复点，缓存后基本是瞬时返回。
    CACHE_TTL = 300.0
    _CACHE = {}          # (接口 FQN) -> (时间戳, 实现类相对路径)

    # ---------------- 类型（SDK 的 request/response DTO） ----------------
    def resolve_type(self, ctx):
        """ody SDK 的 DTO 常在 soa-sdk-jar 里，业务模块用通配符导入
        （import ody.soa.product.request.*）。按包路径在本项目各模块里精确找。"""
        name = ctx.type_name
        if not name:
            return None
        for pkg in self._import_packages(ctx.src_text):
            if not pkg.startswith(self.SDK_PKG_PREFIX):
                continue      # 只管 ody SDK 的包
            hit = ctx.find_by_package(pkg, name + ".java")
            if hit:
                return hit
        return None

    def _import_packages(self, text):
        """来源文件 import 到的包（显式 import 取包部分，通配符 import 取整包）。"""
        pkgs = []
        for m in self._RE_IMPORT.finditer(text or ""):
            fqn = m.group(1)
            if fqn.endswith(".*"):
                pkgs.append(fqn[:-2])
            else:
                pkgs.append(fqn.rsplit(".", 1)[0])
        return pkgs

    # ---------------- 接口 → 服务端实现 ----------------
    def resolve_impl(self, ctx):
        simple = ctx.simple_name
        if not simple:
            return None
        text = ctx.src_text or ""
        if not self._is_client_sdk_interface(text):
            return None
        pkg = self._package_of(text)
        fqn = (pkg + "." + simple) if pkg else simple
        # 缓存命中就直接返回（同一个接口反复点时省掉一串 git grep）
        hit = self._CACHE.get(fqn)
        if hit and (time.time() - hit[0]) < self.CACHE_TTL:
            return hit[1]
        hints = self._repo_hints(text, pkg)
        rx = re.compile(r"implements[^{;]*\b" + re.escape(simple) + r"\b"
                        r"|interfaceClass\s*=\s*" + re.escape(simple) + r"\.class")
        hits = []
        for rel in ctx.grep_java(ctx.repos(hints)[:self.MAX_REPOS], rx):
            body = ctx.load(rel) or ""
            if not self._implements_interface(body, simple, fqn):
                continue
            hits.append(rel)
            if len(hits) >= 8:
                break
        if not hits:
            return None
        # 多个候选时按可信度挑：带 @SoaServiceRegister 的 > 类名遵循 <接口>Impl 的 > 其它
        def _rank(rel):
            body = ctx.load(rel) or ""
            if re.search(r"@SoaServiceRegister\s*\(\s*interfaceClass\s*=\s*" + re.escape(simple) + r"\.class", body):
                return 0
            if re.search(r"\bclass\s+" + re.escape(simple + "Impl") + r"\b", body):
                return 1
            return 2
        hits.sort(key=_rank)
        self._CACHE[fqn] = (time.time(), hits[0])
        return hits[0]

    def _is_client_sdk_interface(self, text):
        """是不是「客户端 SDK 接口」：带 @SoaServiceClient，或包名在 ody.soa. 下。"""
        if self._RE_CLIENT.search(text or ""):
            return True
        pkg = self._package_of(text)
        return bool(pkg) and pkg.startswith(self.SDK_PKG_PREFIX)

    def _implements_interface(self, body, simple, fqn):
        """命中文件是否真的实现了这个接口：
        类声明的 implements 列表里**直接**有它（不是写在泛型参数里 —— SDK 的请求类
        implements SoaSdkRequest<StockReadService, …> 只是把接口当泛型参数，不算实现），
        且文件引用了该接口的 FQN（import 它，或同包）。"""
        if not body:
            return False
        decl = self._RE_CLASS_DECL.search(body)
        if not decl:
            return False
        if simple not in self._implements_names(decl.group(0)):
            return False
        if re.search(r"^\s*import\s+" + re.escape(fqn) + r"\s*;", body, re.M):
            return True
        pkg = self._package_of(body)
        return bool(pkg) and (pkg + "." + simple == fqn)

    def _implements_names(self, decl_text):
        """类声明 implements 列表里的类型名（去掉泛型参数里的名字）。"""
        m = re.search(r"\bimplements\b(.*)$", decl_text, re.S)
        if not m:
            return []
        tail = self._strip_generics(m.group(1))
        names = []
        for part in tail.split(","):
            nm = re.match(r"\s*([\w$.]+)", part)
            if nm:
                names.append(nm.group(1).split(".")[-1])
        return names

    def _strip_generics(self, s):
        """去掉 <...> 里的内容（支持嵌套）。"""
        out = []
        depth = 0
        for ch in s:
            if ch == "<":
                depth += 1
            elif ch == ">":
                if depth:
                    depth -= 1
            elif depth == 0:
                out.append(ch)
        return "".join(out)

    def _repo_hints(self, text, pkg):
        """用服务池名 / 接口包名里的业务词缩小候选仓库 —— 一次点击要扫的仓库越少越好。"""
        hints = []
        m = self._RE_CLIENT.search(text or "")
        if m:
            pm = self._RE_POOL.search(m.group(1))
            if pm:
                pool = pm.group(1)
                hints.append(pool[:-len("-service")] if pool.endswith("-service") else pool)
        if pkg:
            parts = [p for p in pkg.split(".") if p and not p.isdigit()]
            if len(parts) >= 2:
                hints.append(parts[-2])      # ody.soa.product → product
        return [h for h in hints if h and len(h) >= 3]

    def _package_of(self, text):
        m = self._RE_PKG.search(text or "")
        return m.group(1) if m else None


register(OdySoaAdapter())
