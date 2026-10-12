/* computeLanes 的独立实现（gitgraph_check.js 与 gitgraph_lanes.js 共用）*/
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
  const laneForks = [null]; const forkLane = new Map();
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
module.exports = { computeLanes };
