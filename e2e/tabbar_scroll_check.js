/* 标签栏横向滚动回归检查
   背景（回归守卫）：
     标签栏用普通纵向滚轮横向滚动（不用按 Shift）。这条链路最容易坏在
     「重建标签栏把 scrollLeft 归零」上 —— 滚过去了，一切换标签就被弹回最左，
     表现为「时灵时不灵」。本脚本守住这条链路：
       1. 普通滚轮能横向滚动
       2. 重建标签栏 / 切换标签后，用户滚到的位置不丢
       3. 重建后还能继续滚
       4. 小增量（高精度触控板）与行模式（deltaMode=1）都有效
       5. 活动标签切换到不可见的那个时，会滚入可视区

   运行方式（需先启动服务 python server.py）：
     node e2e/tabbar_scroll_check.js
   可选环境变量：
     BASE_URL               默认 http://127.0.0.1:8765/
     MDREADER_PUPPETEER     puppeteer 模块路径（默认取 mermaid-cli 自带的）

   退出码：0 = 全部通过，1 = 存在失败。
*/
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const PUPPETEER_PATHS = [
  process.env.MDREADER_PUPPETEER,
  'puppeteer',
  'C:/Users/1/AppData/Roaming/npm/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer',
].filter(Boolean);

function loadPuppeteer() {
  for (const p of PUPPETEER_PATHS) {
    try { return require(p); } catch (e) { /* 试下一个 */ }
  }
  console.error('找不到 puppeteer，请设置 MDREADER_PUPPETEER 环境变量指向其模块路径');
  process.exit(2);
}

(async () => {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  const res = await page.evaluate(async () => {
    const bar = document.querySelector('#tabbar');
    const out = {};
    const wheel = (dy, mode = 0) => bar.dispatchEvent(
      new WheelEvent('wheel', { deltaY: dy, deltaMode: mode, bubbles: true, cancelable: true }));

    // 造 20 个标签，走真实的 task.tabs → renderTabbar 流程
    const task = curTask();
    const saved = task.tabs.slice();
    task.tabs = Array.from({ length: 20 }, (_, i) => ({
      id: 'probe' + i, path: 'probe/doc-' + i + '.md', name: '标签栏滚动检查-' + i + '.md',
      kind: 'md', content: '', dirty: false, jumpLine: null, scrollTop: 0, mmdRendered: [],
    }));
    task.activeTabId = task.tabs[0].id;
    renderTabbar();
    await new Promise(r => setTimeout(r, 300));
    out.overflow = bar.scrollWidth - bar.clientWidth;

    bar.scrollLeft = 0;
    wheel(300);
    out.afterWheel = bar.scrollLeft;

    const before = bar.scrollLeft;
    renderTabbar();                       // 重建标签栏
    out.keptAfterRender = bar.scrollLeft === before;

    const before2 = bar.scrollLeft;
    activateTab(task.tabs[0].id);         // 切换标签（同一标签 → 活动标签没变）
    await new Promise(r => setTimeout(r, 400));
    out.keptAfterActivate = bar.scrollLeft === before2;

    const before3 = bar.scrollLeft;
    wheel(200);
    out.wheelAfterRender = bar.scrollLeft - before3;

    bar.scrollLeft = 0;
    for (let i = 0; i < 5; i++) wheel(1);        // 高精度触控板的小增量
    out.smallDelta = bar.scrollLeft;

    bar.scrollLeft = 0;
    wheel(3, 1);                                // 行模式
    out.lineMode = bar.scrollLeft;

    bar.scrollLeft = 0;
    activateTab(task.tabs[19].id);              // 切到最右那个（不可见）
    await new Promise(r => setTimeout(r, 400));
    const act = bar.querySelector('.tab.active');
    const r = act.getBoundingClientRect(), br = bar.getBoundingClientRect();
    out.activeVisible = r.left >= br.left - 1 && r.right <= br.right + 1;

    task.tabs = saved;
    task.activeTabId = saved.length ? saved[0].id : null;
    renderTabbar();
    return out;
  });

  const checks = [
    ['标签栏有横向溢出', res.overflow > 0],
    ['普通滚轮横向滚动', res.afterWheel > 0],
    ['重建标签栏后位置不丢', res.keptAfterRender],
    ['切换标签后位置不丢', res.keptAfterActivate],
    ['重建后还能继续滚', res.wheelAfterRender > 0],
    ['小增量累计生效', res.smallDelta > 0],
    ['行模式(deltaMode=1)生效', res.lineMode > 0],
    ['活动标签滚入可视区', res.activeVisible],
  ];
  console.log('=== 标签栏横向滚动 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  if (pageErrors.length) {
    fail++;
    console.log('  [FAIL] 页面 JS 错误: ' + pageErrors.join('; '));
  }
  console.log(fail ? `\n共 ${fail} 项失败` : '\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
