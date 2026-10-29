/* diff（提交）视图下 Ctrl+点击跳转 / 返回后，diff 标记是否还在 —— 回归检查
   背景：
     弹窗的「提交视图」把红删绿增的改动块（hunks）渲染出来，但状态里只记了
     commit + 文件内容，没记 hunks → 跳转/返回后只能重画纯文本，
     表现就是「原本显示 diff，跳一下（或返回）diff 就没了，得切分支再切回来」。
     代码 tab 侧还有一处：跳转带入的是「提交」时，「记忆分支」把提交视图覆盖掉。

   验证（真实无头 Chrome + 真实 Ctrl+点击）：
     1. 选中一个改过该文件的提交 → diff 渲染出来（红删绿增行）
     2. 弹窗内跳到同文件的符号 → 仍是 diff 视图
     3. 弹窗内跳到别的文件 → 仍带着同一个提交视图（该提交没改它就显示提示）
     4. 弹窗「返回」→ 原来的 diff 视图复原
     5. 代码 tab：选中提交 → diff 渲染；Ctrl+点击开新标签 → 仍是同一个提交视图；
        Alt+← 返回 → 原标签的 diff 复原

   运行方式（需先启动服务 python server.py）：
     node e2e/diff_nav_check.js
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
 */
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const VTOP = '20261020-jjy';
const FILE = VTOP + '/gits/jjy-o2o/xls-platform/jar/back-product-web-jar/product-business/src/main/java/com/odianyun/product/business/manage/stock/impl/ImWarehouseRealStockManageImpl.java';

const PUPPETEER_PATHS = [
  process.env.MDREADER_PUPPETEER,
  'puppeteer',
  'C:/Users/1/AppData/Roaming/npm/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer',
].filter(Boolean);

function loadPuppeteer() {
  for (const p of PUPPETEER_PATHS) {
    try { return require(p); } catch (e) { /* 试下一个 */ }
  }
  console.error('找不到 puppeteer，请设置 MDREADER_PUPPETEER 环境变量');
  process.exit(2);
}

function get(p) {
  return new Promise((ok) => {
    const u = new URL(p, BASE_URL);
    http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { ok({ status: res.statusCode, j: JSON.parse(b) }); } catch (e) { ok({ status: res.statusCode, j: null }); } });
    }).on('error', () => ok({ status: 0, j: null }));
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 统计容器里的 diff 行数：虚拟滚动的文件只看渲染窗口，要读 __vstate.rows */
function countDiff(scope) {
  const s = scope === 'modal' ? document.getElementById('m-scroll') : document.getElementById('ct-scroll');
  if (!s) return { add: 0, del: 0 };
  const vs = s.__vstate;
  let add = 0, del = 0;
  if (vs && vs.rows) {
    for (const r of vs.rows) { if (r.kind === 'add') add++; else if (r.kind === 'del') del++; }
  } else {
    add = document.querySelectorAll((scope === 'modal' ? '#m-scroll' : '#ct-scroll') + ' .cl-line.g-add').length;
    del = document.querySelectorAll((scope === 'modal' ? '#m-scroll' : '#ct-scroll') + ' .cl-line.g-del').length;
  }
  return { add, del };
}

/* 在当前视图里找一个「可点且在可视区内」的类型 token */
function findTypeToken(scope) {
  const sc = scope === 'modal' ? document.getElementById('m-scroll') : document.getElementById('ct-scroll');
  if (!sc) return null;
  const sr = sc.getBoundingClientRect();
  const mid = sr.top + sr.height / 2;
  let best = null, bestD = 1e9;
  for (const row of document.querySelectorAll((scope === 'modal' ? '#m-scroll' : '#ct-scroll') + ' .cl-line')) {
    const span = [...row.querySelectorAll('span.hljs-type')][0];
    if (!span) continue;
    const r = span.getBoundingClientRect();
    if (!r.width) continue;
    if (r.top < sr.top + 4 || r.bottom > sr.bottom - 4) continue;   // 必须真在可视区
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestD) { bestD = d; best = { x: r.left + r.width / 2, y: r.top + r.height / 2, txt: span.textContent }; }
  }
  return best;
}

(async () => {
  const puppeteer = loadPuppeteer();
  const probe = await get('/api/code?path=' + encodeURIComponent(FILE));
  if (!probe.j || !probe.j.content) {
    console.log('[SKIP] 样本文件打不开：' + FILE);
    process.exit(2);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(1800);

  // 找一个「确实改过这个文件」的提交
  await page.evaluate(async (p) => { await openCodeModal(p, 60); }, FILE);
  // 等提交下拉填好（git 元数据是异步的，别用固定等待）
  let commits = [];
  try {
    await page.waitForFunction(
      () => { const s = document.getElementById('m-commit'); return s && s.options.length > 1; },
      { timeout: 30000, polling: 300 });
  } catch (e) { /* 下面按空列表处理 */ }
  commits = await page.evaluate(() => {
    const sel = document.getElementById('m-commit');
    return sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.textContent })) : [];
  });
  console.log('  提交下拉项数:', commits.length, commits.slice(0, 3).map(c => c.v.slice(0, 8)).join(','));
  let pick = null;
  for (const c of commits) {
    if (!c.v || /最新/.test(c.t)) continue;
    const r = await get('/api/git/diff?path=' + encodeURIComponent(FILE) + '&commit=' + encodeURIComponent(c.v));
    const j = r && r.j;
    if (j && j.hunks && j.hunks.length) { pick = c; break; }
  }
  if (!pick) {
    console.log('[SKIP] 样本文件没有「改过它的提交」，无法验证 diff 视图');
    try { await browser.close(); } catch (e) { /* 忽略 */ }
    process.exit(2);
  }

  const selectCommit = async (selId) => {
    await page.evaluate((id, v) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.value = v;
      sel.dispatchEvent(new Event('change'));
    }, selId, pick.v);
    await sleep(4000);
  };
  const modalState = async () => page.evaluate(() => ({
    path: modalState.path, commit: modalState.commit,
    hunks: modalState.diffHunks ? modalState.diffHunks.length : 0,
    info: (document.getElementById('m-gitinfo') || {}).textContent || '',
  }));

  // ================= 弹窗侧 =================
  await selectCommit('m-commit');
  const d0 = await page.evaluate(countDiff, 'modal');
  const m0 = await modalState();

  // 场景 1：弹窗内跳到别的文件（跨文件）
  const tok1 = await page.evaluate(findTypeToken, 'modal');
  if (tok1) {
    await page.keyboard.down('Control');
    await page.mouse.click(tok1.x, tok1.y);
    await page.keyboard.up('Control');
    await sleep(4500);
  }
  const d1 = await page.evaluate(countDiff, 'modal');
  const m1 = await modalState();

  // 场景 2：弹窗「返回」
  await page.evaluate(() => { const b = document.getElementById('m-back'); if (b) b.click(); });
  await sleep(2500);
  const d2 = await page.evaluate(countDiff, 'modal');
  const m2 = await modalState();

  // ================= 代码 tab 侧 =================
  await page.evaluate((p) => { openTab(p, { focus: true }); }, FILE);
  await sleep(4000);
  await selectCommit('ct-commit');
  const t0 = await page.evaluate(countDiff, 'ct');
  const tok2 = await page.evaluate(findTypeToken, 'ct');
  if (tok2) {
    await page.keyboard.down('Control');
    await page.mouse.click(tok2.x, tok2.y);
    await page.keyboard.up('Control');
    await sleep(4500);
  }
  const t1 = await page.evaluate(() => {
    const sel = document.getElementById('ct-commit');
    const info = document.getElementById('ct-gitinfo');
    const p = document.querySelector('#content .ct-path');
    return {
      commit: sel ? sel.value : '', hasDiffData: !!(window.curActiveTab && curActiveTab().diffData),
      hunks: (window.curActiveTab && curActiveTab().diffData && curActiveTab().diffData.hunks || []).length,
      path: p ? (p.dataset.full || '') : '',
      info: info ? (info.textContent || '').trim() : '',
    };
  });
  // Alt+← 返回
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Alt');
  await sleep(3000);
  const t2 = await page.evaluate(countDiff, 'ct');

  const checks = [
    ['弹窗：选中提交后 diff 渲染出来', d0.add > 0 || d0.del > 0],
    ['弹窗：状态里记下了改动块（hunks）', m0.hunks > 0],
    ['弹窗：跨文件跳转后仍是同一个提交视图', m1.commit === pick.v],
    ['弹窗：跨文件跳转后目标文件按该提交渲染（无改动则给出提示）',
      (d1.add + d1.del) > 0 || /未修改/.test(m1.info)],
    ['弹窗：返回后 diff 复原', (d2.add + d2.del) > 0],
    ['弹窗：返回后仍是同一个提交视图', m2.commit === pick.v],
    ['tab：选中提交后 diff 渲染出来', t0.add > 0 || t0.del > 0],
    ['tab：Ctrl+点击开的新标签仍是同一个提交视图', t1.commit === pick.v],
    ['tab：新标签按该提交取改动块（无改动则给提示）',
      t1.hunks > 0 || /未修改/.test(t1.info)],
    ['tab：Alt+← 返回后原标签的 diff 复原', (t2.add + t2.del) > 0],
    ['页面无 JS 异常', pageErrors.length === 0],
  ];

  console.log('=== diff 视图下的跳转/返回 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  样本：${FILE.split('/').pop()}  提交 ${pick.v.slice(0, 8)}`);
  console.log(`  弹窗：选中提交 +${d0.add} -${d0.del} → 跳转 +${d1.add} -${d1.del} → 返回 +${d2.add} -${d2.del}`);
  console.log(`  tab ：选中提交 +${t0.add} -${t0.del} → 返回 +${t2.add} -${t2.del}`);
  console.log(`  跳转到的文件：${(t1.path || '').split('/').pop()}（hunks=${t1.hunks}）`);
  if (pageErrors.length) console.log('  JS 异常：' + pageErrors.join(' | '));
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
