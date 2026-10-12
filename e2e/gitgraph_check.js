/* Git 图 lane 分配逻辑测试 —— 纯逻辑，无需浏览器。
   验证 renderGitGraph 里的 lane/commitLane 算法在真实数据上不变量成立。
   用法: node e2e/gitgraph_check.js */
const http = require('http');
const BASE = 'http://127.0.0.1:8765';

function getJSON(u) {
  return new Promise((ok, bad) => {
    http.get(BASE + u, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { bad(e); } });
    }).on('error', bad);
  });
}

let fail = 0;
function ok(cond, msg) { console.log((cond ? '  [PASS] ' : '  [FAIL] ') + msg); if (!cond) fail++; }

/* 复刻 index.html 的 lane 算法（保持同步：改了那边要改这里）*/
function computeLanes(data) {
  const byId = new Map(data.commits.map(c => [c.id, c]));
  const parentsOf = id => { const c = byId.get(id); return (c && c.parents) || []; };

  const trunk = new Set();
  const q = [data.head], seen = new Set();
  while (q.length) {
    const i = q.pop();
    if (!i || seen.has(i) || !byId.has(i)) continue;
    seen.add(i); trunk.add(i);
    for (const p of parentsOf(i)) if (!seen.has(p)) q.push(p);
  }

  const forkPointOf = head => {
    let c = head; const s = new Set();
    while (c && byId.has(c) && !s.has(c)) {
      s.add(c);
      if (trunk.has(c) && c !== head) return c;
      c = parentsOf(c)[0] || null;
    }
    return null;
  };

  const liveBranches = data.branches.filter(b => byId.has(b.head));
  const dangling = data.branches.length - liveBranches.length;

  const laneOf = new Map(); laneOf.set(data.headBranch, 0);
  const laneForks = [null];
  const forkLane = new Map();
  const laneHeads = new Map(); laneHeads.set(0, new Set());
  const sharesAncestry = (a, b) => {
    let c = a; const sa = new Set();
    while (c && byId.has(c) && !sa.has(c)) { sa.add(c); c = parentsOf(c)[0] || null; }
    c = b; const sb = new Set();
    while (c && byId.has(c) && !sb.has(c)) { sb.add(c); if (sa.has(c)) return true; c = parentsOf(c)[0] || null; }
    return false;
  };
  for (const b of liveBranches) {
    if (b.name === data.headBranch) continue;
    if (trunk.has(b.head)) { laneOf.set(b.name, 0); laneHeads.get(0).add(b.head); continue; }
    const f = forkPointOf(b.head);
    if (f && forkLane.has(f)) { const ln = forkLane.get(f); laneOf.set(b.name, ln); laneHeads.get(ln).add(b.head); continue; }
    if (!f) {
      let merged = false;
      for (const [ln, heads] of laneHeads) {
        for (const h of heads) { if (sharesAncestry(b.head, h)) { laneOf.set(b.name, ln); heads.add(b.head); merged = true; break; } }
        if (merged) break;
      }
      if (merged) continue;
      const ln = Math.min(laneForks.length, 7);
      laneForks[ln] = null; laneOf.set(b.name, ln); laneHeads.set(ln, new Set([b.head]));
      if (laneForks.length <= ln) laneForks.push(null);
      continue;
    }
    const ln = Math.min(laneForks.length, 7);
    laneForks[ln] = f; forkLane.set(f, ln); laneOf.set(b.name, ln);
    laneHeads.set(ln, new Set([b.head]));
    if (laneForks.length <= ln) laneForks.push(f);
  }
  const laneCount = Math.max(1, laneForks.length);

  const chainLen = head => {
    let c = head, n = 0; const s = new Set();
    while (c && byId.has(c) && !s.has(c)) { s.add(c); n++; c = parentsOf(c)[0] || null; }
    return n;
  };
  const order = liveBranches.slice().sort((a, b) => chainLen(b.head) - chainLen(a.head));
  const cl = new Map();
  const assign = (i, ln, g) => {
    if (!i || cl.has(i) || !byId.has(i)) return;
    g = g || new Set(); if (g.has(i)) return;
    g.add(i); cl.set(i, ln);
    for (const p of parentsOf(i)) assign(p, ln, g);
  };
  for (const b of order) assign(b.head, laneOf.get(b.name) || 0);
  for (const t of (data.tags || [])) if (byId.has(t.head) && !cl.has(t.head)) assign(t.head, 0);
  if (data.head && !cl.has(data.head)) assign(data.head, 0);
  for (const c of data.commits) if (!cl.has(c.id)) cl.set(c.id, 0);

  return { byId, trunk, forkPointOf, liveBranches, dangling, laneOf, laneCount, cl, laneHeads };
}

(async () => {
  const repos = await getJSON('/api/git/repos');
  if (!repos.repos || !repos.repos.length) { console.log('无仓库，跳过'); return; }
  const repo = repos.repos.find(r => r.endsWith('/customer')) || repos.repos[0];
  console.log('测试仓库:', repo);
  const data = await getJSON('/api/git/graph?path=' + encodeURIComponent(repo));
  console.log(`\u63d0\u4ea4 ${data.commits.length} \u00b7 \u5206\u652f ${data.branches.length} \u00b7 head=${data.headBranch}\n`);

  const R = computeLanes(data);

  let missing = 0;
  for (const c of data.commits) for (const p of (c.parents || [])) if (!R.byId.has(p)) missing++;
  ok(true, `\u7236\u63d0\u4ea4\u88ab\u622a\u65ad: ${missing} \u4e2a`);
  ok(R.trunk.size > data.commits.length * 0.2,
     `\u4e3b\u5e72\u57df\u5360\u6bd4 ${(R.trunk.size / data.commits.length * 100).toFixed(0)}%`);
  ok(R.laneCount >= 1 && R.laneCount <= 8, `laneCount=${R.laneCount}`);
  ok(new Set(R.laneOf.values()).size === R.laneCount, 'laneOf lane \u6570\u4e0e laneCount \u4e00\u81f4');
  ok(R.cl.size === data.commits.length, `commitLane \u65e0\u622a\u65ad\u6c61\u67d3 (${R.cl.size}/${data.commits.length})`);
  ok(Math.max(...R.cl.values()) < R.laneCount, 'commit lane \u4e0d\u8d8a\u754c');
  ok(true, `\u60ac\u7a7a\u5f15\u7528: ${R.dangling} \u4e2a`);

  const per = new Array(R.laneCount).fill(0);
  for (const ln of R.cl.values()) per[ln]++;
  const empty = per.filter(x => x === 0).length;
  ok(empty === 0, `\u65e0\u7a7a\u8f68\u9053 (${empty}/${R.laneCount}) \u2192 ${JSON.stringify(per)}`);

  const alwaysShow = new Set(R.liveBranches.map(b => b.head));
  for (const c of data.commits) if ((c.parents || []).length > 1) alwaysShow.add(c.id);
  const byLane = new Map();
  for (const c of data.commits) { const ln = R.cl.get(c.id) || 0; if (!byLane.has(ln)) byLane.set(ln, []); byLane.get(ln).push(c); }
  let bars = 0, sem = 0;
  for (const [, arr] of byLane) {
    let rs = 0;
    for (let i = 0; i < arr.length; i++) {
      if (alwaysShow.has(arr[i].id)) { if (i - 1 >= rs + 1) bars++; rs = i + 1; sem++; }
    }
    if (arr.length - 1 >= rs + 1) bars++;
  }
  ok(bars + sem < data.commits.length, `\u6982\u89c8\u5143\u7d20 ${bars + sem} < \u5b8c\u6574 ${data.commits.length}`);

  const noLane = R.liveBranches.filter(b => !R.laneOf.has(b.name));
  ok(noLane.length === 0, `\u6240\u6709\u6709\u6548\u5206\u652f\u90fd\u6709 lane (\u65e0: ${noLane.length})`);

  console.log(fail === 0 ? '\n\u5168\u90e8\u901a\u8fc7' : `\n${fail} \u9879\u5931\u8d25`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
