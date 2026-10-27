/* 标签栏横向滚动回归检查
   背景（回归守卫）：
     标签栏要支持「普通纵向滚轮横向滚动」（不用按 Shift）。
     这条链路有两个坑，都必须守住：

       1) 原生横向滚动会把纵向滚轮「锁到横向轴」，一下滚到一头，
          之后继续滚没反应 —— 用户报的就是这个（滚动一下瞬间滚到一端，再滚没反应）。
          修法：#tabbar 改 overflow:hidden 关掉原生滚动，位移全部由 JS 的 wheel 处理算。
       2) 重建标签栏（innerHTML=""）会把 scrollLeft 归零，用户滚到的位置一被
          重建就丢（切换标签/关闭标签/打开标签都会触发重建）—— 同样是「时灵时不灵」。

   必须用【真实滚轮事件】验证：page.mouse.wheel() 走 CDP Input.dispatchMouseEvent，
   会带上浏览器自己的默认滚动行为；用 new WheelEvent() 合成的事件绕过了这条路径，
   测不出上面的坑（本次就是这样漏测的）。

   运行方式（需先启动服务 python server.py）：
     node e2e/tabbar_scroll_check.js
   可选环境变量：
     BASE_URL               默认 http://127.0.0.1:8765/
     MDREADER_PUPPETEER     puppeteer 模块路径（默认取 mermaid-cli 自带的）

   退出码：0 = 全部通过，1 = 存在失败。
*/
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

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';

(async () => {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // 造 20 个标签，走真实的 task.tabs → renderTabbar 流程
  await page.evaluate(async () => {
    const task = curTask();
    task.tabs = Array.from({ length: 20 }, (_, i) => ({
      id: 'probe' + i, path: 'probe/doc-' + i + '.md', name: '标签栏滚动检查-' + i + '.md',
      kind: 'md', content: '', dirty: false, jumpLine: null, scrollTop: 0, mmdRendered: [],
    }));
    task.activeTabId = task.tabs[0].id;
    renderTabbar();
    await new Promise(r => setTimeout(r, 300));
  });

  const target = await page.evaluate(() => {
    const r = document.querySelectorAll('#tabbar .tab')[3].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const scrollLeft = () => page.evaluate(() => document.querySelector('#tabbar').scrollLeft);
  const setScroll = (v) => page.evaluate((v) => { document.querySelector('#tabbar').scrollLeft = v; }, v);
  const overflowX = await page.evaluate(() => getComputedStyle(document.querySelector('#tabbar')).overflowX);

  await page.mouse.move(target.x, target.y);

  // ① 原生横向滚动必须关掉（否则浏览器会把纵向滚轮锁到横向轴、一下滚到一头）
  const nativeOff = overflowX === 'hidden';

  // ② 连续滚 6 次：每次只走一格，不能跳
  await setScroll(0);
  let prev = 0, maxStep = 0, anyJump = false;
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise(r => setTimeout(r, 220));
    const now = await scrollLeft();
    const step = now - prev;
    if (step > 200 || step < 0) anyJump = true;
    if (step > maxStep) maxStep = step;
    prev = now;
  }
  const smooth = !anyJump && prev > 0;

  // ③ 到底后继续滚：停在末尾，不能乱跳
  await page.evaluate(() => {
    const b = document.querySelector('#tabbar');
    b.scrollLeft = b.scrollWidth - b.clientWidth;
  });
  const endBefore = await scrollLeft();
  await page.mouse.wheel({ deltaY: 120 });
  await new Promise(r => setTimeout(r, 300));
  const endAfter = await scrollLeft();

  // ④ 反向能滚回来
  await page.mouse.wheel({ deltaY: -120 });
  await new Promise(r => setTimeout(r, 300));
  const back = await scrollLeft();

  // ⑤ Shift+滚轮（浏览器转成 deltaX）
  await setScroll(0);
  await page.keyboard.down('Shift');
  await page.mouse.wheel({ deltaY: 120 });
  await page.keyboard.up('Shift');
  await new Promise(r => setTimeout(r, 300));
  const shiftScroll = await scrollLeft();

  // ⑥ 触控板横滑（deltaX）
  await setScroll(0);
  await page.mouse.wheel({ deltaX: 150, deltaY: 0 });
  await new Promise(r => setTimeout(r, 300));
  const trackpadScroll = await scrollLeft();

  // ⑦ 小增量累计（高精度触控板 deltaY=1 × 5）
  await setScroll(0);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel({ deltaY: 1 });
    await new Promise(r => setTimeout(r, 60));
  }
  const smallDelta = await scrollLeft();

  // ⑧ 重建标签栏后位置不丢
  await setScroll(400);
  const keepBefore = await scrollLeft();
  await page.evaluate(() => renderTabbar());
  await new Promise(r => setTimeout(r, 300));
  const keepAfter = await scrollLeft();

  const checks = [
    ['原生横向滚动已关闭(overflow-x:hidden)', nativeOff],
    ['连续滚轮每格一档、不跳到一头', smooth],
    ['滚到末尾后停住', endAfter === endBefore],
    ['到底后能反向滚回来', back < endAfter],
    ['Shift+滚轮可横向滚', shiftScroll > 0],
    ['触控板横滑可横向滚', trackpadScroll > 0],
    ['小增量累计生效', smallDelta > 0],
    ['重建标签栏后位置不丢', keepAfter === keepBefore],
  ];
  console.log('=== 标签栏横向滚动 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  （单次最大位移 ${maxStep}px / 6 次滚轮后 scrollLeft=${prev}）`);
  if (pageErrors.length) {
    fail++;
    console.log('  [FAIL] 页面 JS 错误: ' + pageErrors.join('; '));
  }
  console.log(fail ? `\n共 ${fail} 项失败` : '\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
