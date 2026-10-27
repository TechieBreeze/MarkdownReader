/* 代码弹窗「返回」后高亮行是否还在原位 回归检查
   背景：
     带行信息打开代码弹窗会高亮该行；ctrl+点击别的方法跳走、再点「返回」时，
     高亮行会跑到视口中心那行 —— 看起来就是「高亮行自己变了」。
     根因：scrollCodeToLine() 是滚动函数，却在虚拟滚动分支里顺手写了
     scroll.__vstate.hlLine = line（等于「滚到哪行就把哪行标成高亮」）。
     返回时 renderModalView → scrollCodeToLine(viewportLine) 就把高亮行改成了
     视口中心那行。非虚拟滚动分支没有这个行为，两条路径不一致。
     修法：高亮行只由 renderRows(rows, hl, hlLine) 决定，scrollCodeToLine 不碰它。

   运行方式（需先启动服务 python server.py）：
     node e2e/modal_line_check.js
   可选环境变量：
     BASE_URL   默认 http://127.0.0.1:8765/
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
*/
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const SAMPLE = {
  path: '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/api/CustomerApi.java',
  line: 143,
};

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
  // 样本文件要够长（>800 行才走虚拟滚动，正是出问题的分支）
  const probe = await get('/api/code?path=' + encodeURIComponent(SAMPLE.path));
  if (!probe.j || !probe.j.content) {
    console.log('[SKIP] 样本文件打不开：' + SAMPLE.path);
    process.exit(2);
  }
  const isVirtual = probe.j.lines > 800;

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  const out = await page.evaluate(async (path, line) => {
    const hlOf = () => {
      const h = document.querySelector('#m-scroll .cl-line.hl-line');
      return h ? h.dataset.line : null;
    };
    const vhl = () => {
      const s = document.querySelector('#m-scroll');
      return s && s.__vstate ? s.__vstate.hlLine : null;
    };
    await openCodeModal(path, line);
    await new Promise(r => setTimeout(r, 2500));
    const r = { openHl: hlOf(), openVhl: vhl(), vscroll: document.querySelector('#m-scroll').classList.contains('vscroll') };
    // 跳到别处（同文件跳转 = localJump 路径）
    const src = { path: modalState.path, text: modalState.content, tab: null };
    localJump(src, 500);
    await new Promise(r2 => setTimeout(r2, 1200));
    r.afterJumpHl = hlOf();
    r.afterJumpVhl = vhl();
    // 返回
    document.querySelector('#m-back').click();
    await new Promise(r2 => setTimeout(r2, 1500));
    r.backHl = hlOf();
    r.backVhl = vhl();
    r.backLine = modalState.line;
    r.backStack = modalState._backStack.length;
    return r;
  }, SAMPLE.path, SAMPLE.line);

  const checks = [
    ['打开时高亮在目标行', String(out.openHl) === String(SAMPLE.line)],
    ['跳走后高亮跟着新位置', String(out.afterJumpHl) === '500'],
    ['返回后高亮行回到原位', String(out.backVhl) === String(SAMPLE.line)],
    ['返回后 modalState.line 正确', String(out.backLine) === String(SAMPLE.line)],
    ['返回后高亮在 DOM 里可见', String(out.backHl) === String(SAMPLE.line)],
    ['返回栈已弹出', out.backStack === 0],
    ['页面无 JS 异常', pageErrors.length === 0],
  ];
  console.log('=== 代码弹窗返回后高亮行 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  样本：${SAMPLE.path.split('/').pop()} @ L${SAMPLE.line}（${probe.j.lines} 行${isVirtual ? '，虚拟滚动' : ''}）`);
  console.log(`  打开高亮=${out.openHl} → 跳转后=${out.afterJumpHl} → 返回后=${out.backHl}（内部 ${out.backVhl}）`);
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
