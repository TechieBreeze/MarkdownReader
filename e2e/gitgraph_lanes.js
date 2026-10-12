/* 各轨道提交分布诊断：回答「为什么有轨道看起来是空的」 */
const http = require('http');
function get(u) {
  return new Promise((ok, bad) => {
    http.get('http://127.0.0.1:8765' + u, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { bad(e); } });
    }).on('error', bad);
  });
}
const check = require('./gitgraph_check_lib.js');
(async () => {
  const d = await get('/api/git/graph?path=' + encodeURIComponent('20260917-\u5fae\u670d\u52a1/gits/customer'));
  const R = check.computeLanes(d);
  console.log(`\u603b\u63d0\u4ea4 ${d.commits.length} \u00b7 \u5206\u652f ${d.branches.length} \u00b7 \u8f68\u9053 ${R.laneCount}`);
  const per = new Array(R.laneCount).fill(0);
  for (const ln of R.cl.values()) per[ln]++;
  const names = []; for (let i = 0; i < R.laneCount; i++) names.push([]);
  for (const b of R.liveBranches) names[R.laneOf.get(b.name) || 0].push(b.name);
  console.log('\n\u5404\u8f68\u9053:');
  for (let i = 0; i < R.laneCount; i++) {
    const bar = '#'.repeat(Math.round(per[i] / 8));
    console.log(`  lane ${i}: ${String(per[i]).padStart(3)} \u63d0\u4ea4  ${bar}  [${names[i].join(', ')}]`);
  }
  console.log(`\u7a7a\u8f68\u9053: ${per.filter(x=>x===0).length} / ${R.laneCount}`);
  console.log(`\u60ac\u7a7a\u5f15\u7528: ${R.dangling} \u4e2a`);
  if (per.filter(x=>x===0).length > 0) process.exitCode = 1;
})().catch(e => { console.error('ERR', e); process.exit(1); });
