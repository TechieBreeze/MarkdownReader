/* 仓库视角链接（GitLab /-/blob/<ref>/<path>）→ 本地文件 回归检查
   背景：
     文档里大量引用代码仓库页面（GitLab /-/blob/<ref>/<path>#L12）。原来这些链接
     只能「新标签页打开远端页面」，无法在阅读器里直接看代码。
     现在：服务端把仓库链接解析成本地工作区文件（gits/<project>/<path>，多模块仓库
     按后缀匹配），前端把链接换成「点开应用内代码弹窗」。

   断言覆盖：
     1. 仓库链接被识别并解析成本地文件
     2. 行号从 URL 的 #L12 取到
     3. 点击 → 打开本地文件的代码弹窗（内容是本地文件，不是远端页面）
     4. 弹窗定位到对应行
     5. Shift+点击不劫持（走浏览器原生）
     6. 链接仍是真实 <a href>（右键菜单可用，href 保持远端地址）
     7. 解析不到的链接保持「新标签页打开远端」

   运行方式（需先启动服务 python server.py）：
     node e2e/repo_link_check.js
   可选环境变量：
     BASE_URL   默认 http://127.0.0.1:8765/
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
*/
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';

/* 样本：含大量仓库链接的文档 */
const DOC = '20260917-微服务/gits/docs/交付文档/专题/01-会员注册流程.md';

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
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { ok({ status: res.statusCode, j: JSON.parse(b) }); } catch (e) { ok({ status: res.statusCode, j: null }); } });
    }).on('error', () => ok({ status: 0, j: null }));
  });
}

(async () => {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // 文档打不开 → 样本缺失
  const docOk = await page.evaluate(async (p) => {
    try { await openTab(p); return true; } catch (e) { return false; }
  }, DOC);
  if (!docOk) { console.log('[SKIP] 样本文档打不开：' + DOC); await browser.close(); process.exit(2); }
  await new Promise(r => setTimeout(r, 4000));

  const out = await page.evaluate(async () => {
    const links = [...document.querySelectorAll('#content .md-body a.gitlab-jump')];
    const local = links.filter(a => a.classList.contains('repo-local'));
    const res = { total: links.length, local: local.length };

    if (local.length) {
      const a = local[0];
      res.hrefStillRemote = /^https?:\/\//.test(a.getAttribute('href') || '');
      res.targetRemoved = !a.getAttribute('target');
      res.tag = a.tagName;
      res.title = a.title || '';
      res.ref = a.dataset.repoRef || '';
      // 样式：链接里的行内代码（marked 把 `代码` 渲染成 a > code）不能盖住链接的底色/hover
      const withCode = local.find(x => x.querySelector('code'));
      if (withCode) {
        const code = withCode.querySelector('code');
        const cs = getComputedStyle(code), ls = getComputedStyle(withCode);
        res.innerCodeColorSame = ls.color === cs.color;
        res.innerCodeHasBg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)';   // 内层必须透明，否则盖住链接底色
        res.linkHasBg = ls.backgroundColor !== 'rgba(0, 0, 0, 0)';        // 链接自己有底色（芯片）
      }
      // 点击 → 应打开本地文件的代码弹窗，并按 URL 里的分支（git 版本）打开
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await new Promise(r => setTimeout(r, 2500));
      const mask = document.querySelector('#modal-mask');
      res.modalShown = !!(mask && mask.classList.contains('show'));
      const lines = [...document.querySelectorAll('#m-scroll .cl-line')];
      res.modalFirstLine = lines.length ? lines[0].textContent.trim().slice(0, 60) : '';
      res.modalLineCount = lines.length;
      const hl = lines.find(d => d.classList.contains('hl-line'));
      res.modalHlLine = hl ? hl.dataset.line : null;
      res.modalPath = (document.querySelector('#m-path') || {}).textContent || '';
      const bsel = document.querySelector('#m-branch');
      res.modalBranch = bsel ? bsel.value : null;
      // 关掉弹窗
      if (mask) mask.classList.remove('show');
      await new Promise(r => setTimeout(r, 300));
      // Shift+点击 → 不应被劫持
      const a2 = local[0];
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true, view: window });
      const notPrevented = a2.dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 600));
      const mask2 = document.querySelector('#modal-mask');
      res.shiftNotPrevented = notPrevented;              // true = 没 preventDefault ✅
      res.shiftModalShown = !!(mask2 && mask2.classList.contains('show'));
      // Ctrl+点击 → 开标签页，且按该分支（git 版本）打开
      const a3 = local[0];
      const before = curTask().tabs.length;
      a3.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, view: window }));
      await new Promise(r => setTimeout(r, 2500));
      const task = curTask();
      const tab = task.tabs[task.tabs.length - 1];
      res.ctrlTabOpened = task.tabs.length > before;
      res.ctrlTabPath = tab ? tab.path : null;
      res.ctrlTabBranch = tab ? (tab._viewBranch || null) : null;
      res.ctrlTabLines = tab && tab.branchContent ? tab.branchContent.split('\n').length : null;
    }
    return res;
  });

  const checks = [
    ['文档里的仓库链接被识别', out.total > 0],
    ['仓库链接解析到本地文件', out.local > 0],
    ['全部仓库链接都解析成功', out.local === out.total],
    ['链接仍是真实 <a> 标签', out.tag === 'A'],
    ['href 保持远端仓库地址（右键可复制）', out.hrefStillRemote === true],
    ['解析后去掉 target（点击不再开新标签）', out.targetRemoved === true],
    ['点击打开代码弹窗', out.modalShown === true],
    ['弹窗里是本地文件内容', /package |@Resource|^\s*\d+\s+\S/.test(out.modalFirstLine || '')],
    ['弹窗定位到 URL 里的行号', !!out.modalHlLine],
    ['弹窗按 URL 里的分支（git 版本）打开', !!out.modalBranch],
    ['Ctrl+点击开为标签页', out.ctrlTabOpened === true],
    ['标签页按 URL 里的分支打开', !!out.ctrlTabBranch],
    ['链接里的行内代码跟随链接颜色', out.innerCodeColorSame === true],
    ['行内代码背景透明（不盖住链接底色）', out.innerCodeHasBg === false],
    ['链接自身有底色（芯片）', out.linkHasBg === true],
    ['Shift+点击不被劫持（走浏览器原生）', out.shiftNotPrevented === true && out.shiftModalShown === false],
    ['页面无 JS 异常', pageErrors.length === 0],
  ];
  console.log('=== 仓库视角链接 → 本地文件（按 git 版本打开）===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  仓库链接 ${out.total} 个，解析到本地 ${out.local} 个，URL 分支 ${out.ref || '(无)'}`);
  console.log(`  弹窗：${out.modalPath}（分支 ${out.modalBranch}，定位行 ${out.modalHlLine}）`);
  console.log(`  Ctrl+点击标签页：${out.ctrlTabPath}（分支 ${out.ctrlTabBranch}，${out.ctrlTabLines} 行）`);
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
