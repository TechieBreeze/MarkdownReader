/* 文件路径右键复制 回归检查
   背景：代码弹窗头 / 代码标签页头 / md 工具条上的路径只能看不能复制，
   要贴路径给别人时只能手动框选。

   验证（真实无头 Chrome + 真实右键 + 真实点击）：
     1. 右键点路径 → 弹出菜单（复制路径 / 复制文件名）
     2. 点「复制路径」→ 剪贴板里就是完整路径 + 提示 toast
     3. 代码标签页路径同样能右键复制（复制文件名）
     4. md 工具条路径同样能右键复制
     5. 非路径区域右键不弹菜单（不劫持原生右键）
     6. Esc 能关掉菜单
     7. 页面无 JS 异常

   运行方式（需先启动服务 python server.py）：
     node e2e/path_copy_check.js
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
 */
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const CODE = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/api/CustomerApi.java';
const MD = '20260917-微服务/docs/梳理/00-业务全景导读.md';

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

/* 右键点某个元素中心 */
async function rightClick(page, sel) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 80), y: r.top + r.height / 2, w: r.width, h: r.height };
  }, sel);
  if (!box) return null;
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await new Promise(r => setTimeout(r, 400));
  return box;
}

const menuInfo = (page) => page.evaluate(() => {
  const m = document.querySelector('#ctx-menu');
  return {
    shown: !!m && getComputedStyle(m).display !== 'none',
    items: m ? [...m.querySelectorAll('.ctx-item')].map(b => b.textContent) : [],
  };
});

(async () => {
  const puppeteer = loadPuppeteer();
  const probe = await get('/api/code?path=' + encodeURIComponent(CODE));
  if (!probe.j || !probe.j.content) { console.log('[SKIP] 样本文件打不开'); process.exit(2); }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(BASE_URL, ['clipboard-read', 'clipboard-write']);
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  const checks = [];

  // ---- 1. 代码弹窗头的路径 ----
  await page.evaluate(async (p) => { await openCodeModal(p, 143); }, CODE);
  await new Promise(r => setTimeout(r, 2500));
  const modalPath = await page.evaluate(() => (document.querySelector('#m-path') || {}).dataset?.full
    || (document.querySelector('#m-path') || {}).textContent || '');
  await rightClick(page, '#m-path');
  const m1 = await menuInfo(page);
  checks.push(['右键弹窗头路径弹出菜单', m1.shown === true]);
  checks.push(['菜单有「复制路径」「复制文件名」', m1.items.length === 2 && m1.items[0] === '复制路径' && m1.items[1] === '复制文件名']);
  // 点「复制路径」
  await page.click('#ctx-menu .ctx-item');
  await new Promise(r => setTimeout(r, 500));
  const clip1 = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  const toast1 = await page.evaluate(() => (document.querySelector('#toast') || {}).textContent || '');
  checks.push(['剪贴板里是完整路径', clip1 === modalPath]);
  checks.push(['复制后有 toast 提示', /已复制/.test(toast1)]);

  // ---- 2. 代码标签页的路径（复制文件名） ----
  await page.evaluate(() => { try { closeModal(); } catch (e) { } });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(async (p) => { await openTab(p, { focus: true, line: 143 }); }, CODE);
  await new Promise(r => setTimeout(r, 2500));
  await rightClick(page, '.ct-path');
  const m2 = await menuInfo(page);
  checks.push(['右键代码标签页路径弹出菜单', m2.shown === true]);
  const items = await page.evaluate(() => [...document.querySelectorAll('#ctx-menu .ctx-item')].map(b => b.textContent));
  if (items[1] === '复制文件名') await page.click('#ctx-menu .ctx-item:nth-child(2)');
  else await page.click('#ctx-menu .ctx-item');
  await new Promise(r => setTimeout(r, 500));
  const clip2 = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  checks.push(['复制文件名得到的是文件名', clip2 === 'CustomerApi.java']);

  // ---- 3. md 工具条的路径 ----
  await page.evaluate(async (p) => { await openTab(p, { focus: true }); }, MD);
  await new Promise(r => setTimeout(r, 3000));
  const mdPath = await page.evaluate(() => (document.querySelector('.mt-path') || {}).textContent || '');
  await rightClick(page, '.mt-path');
  const m3 = await menuInfo(page);
  checks.push(['右键 md 工具条路径弹出菜单', m3.shown === true]);
  await page.click('#ctx-menu .ctx-item');
  await new Promise(r => setTimeout(r, 500));
  const clip3 = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  checks.push(['md 路径也能复制', clip3 === mdPath.trim() && clip3.length > 0]);

  // ---- 4. 非路径区域右键不弹菜单 ----
  await page.evaluate(() => { const m = document.querySelector('#ctx-menu'); if (m) m.remove(); });
  await page.mouse.click(700, 500, { button: 'right' });
  await new Promise(r => setTimeout(r, 300));
  const m4 = await menuInfo(page);
  checks.push(['非路径区域右键不弹菜单', m4.shown === false]);

  // ---- 5. Esc 关闭菜单 ----
  await rightClick(page, '.mt-path');
  const m5 = await menuInfo(page);
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));
  const m6 = await menuInfo(page);
  checks.push(['Esc 能关掉菜单', m5.shown === true && m6.shown === false]);

  checks.push(['页面无 JS 异常', pageErrors.length === 0]);

  console.log('=== 路径右键复制 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  弹窗路径：${modalPath}`);
  console.log(`  剪贴板：弹窗=${clip1} / 标签页=${clip2} / md=${clip3}`);
  if (pageErrors.length) console.log('  JS 异常：' + pageErrors.join(' | '));
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
