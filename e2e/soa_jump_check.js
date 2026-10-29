/* SOA（ody 远程调用）Ctrl+点击跳转 回归检查
   背景：
     jjy-o2o 是多模块工程，仓库嵌在 gits/jjy-o2o/xls-platform/jar|war/<模块>/ 下，
     之前阅读器只认 gits/* 一层的仓库 → ①通配符导入的 SDK 类型被误判成
     「外部框架类型」（点不动），②SDK 接口找不到服务端实现类。

   验证（真实无头 Chrome + 真实 Ctrl+点击）：
     1. 业务模块里用到的 SDK 请求类（通配符 import）→ Ctrl+点击跳到 SDK 里的类定义
     2. SDK 接口里的方法 → Ctrl+点击跳到服务端实现类的同名方法
     3. 点 SDK 接口里的请求类型 → 跳到 DTO 类定义
     4. 负向：JDK 类型仍然报「外部/框架方法」，不乱跳

   运行方式（需先启动服务 python server.py）：
     node e2e/soa_jump_check.js
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
 */
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const VTOP = '20261020-jjy';
const SDK = VTOP + '/gits/jjy-o2o/xls-platform/jar/soa-sdk-jar/src/main/java/ody/soa/product/StockReadService.java';
const DTO = VTOP + '/gits/jjy-o2o/xls-platform/jar/soa-sdk-jar/src/main/java/ody/soa/product/request/CanUpdateStoreWarehouseStockRequest.java';
const IMPL = VTOP + '/gits/jjy-o2o/xls-platform/jar/oms-jar/oms-order/src/main/java/com/odianyun/oms/backend/order/service/impl/SoItemServiceImpl.java';
const PROVIDER = VTOP + '/gits/jjy-o2o/xls-platform/jar/back-product-web-jar/product-api/src/main/java/com/odianyun/product/api/service/stock/impl/StockReadServiceImpl.java';

const REQ_TYPE = 'CanUpdateStoreWarehouseStockRequest';
const REQ_METHOD = 'getCanUpdateStoreWarehouseStock';

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

/* 在弹窗里打开文件并定位到某一行 */
async function locateToken(page, path, line, word, wantCls, label) {
  await page.evaluate(async (p, ln) => { await openCodeModal(p, ln); }, path, line);
  // 等目标行渲染出来（虚拟滚动的文件要等滚动到位；别用固定等待）
  try {
    await page.waitForFunction(
      (ln) => !!document.querySelector(`#m-scroll .cl-line[data-line="${ln}"]`),
      { timeout: 20000, polling: 300 }, line);
  } catch (e) {
    const st = await page.evaluate(() => {
      const scroll = document.getElementById('m-scroll');
      return {
        path: modalState.path, line: modalState.line,
        rows: document.querySelectorAll('#m-scroll .cl-line').length,
        scrollTop: scroll ? scroll.scrollTop : null,
      };
    });
    console.log(`  [${label}] 等待第 ${line} 行超时：modal=${st.path} 行=${st.line} 已渲染=${st.rows} scrollTop=${st.scrollTop}`);
  }
  await new Promise(r => setTimeout(r, 600));
  return { line, word, wantCls: wantCls || '' };
}

/* 量 token 的坐标；点击前要重新量 —— 弹窗会在 git 分支内容加载完后重排 */
async function tokenBox(page, loc) {
  return page.evaluate((ln, w, cls) => {
    const row = document.querySelector(`#m-scroll .cl-line[data-line="${ln}"]`);
    if (!row) return null;
    const spans = [...row.querySelectorAll('span')].filter(s => s.textContent === w);
    const hit = spans.find(s => !cls || (s.className || '').includes(cls)) || spans[0];
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, cls: hit.className || '' };
  }, loc.line, loc.word, loc.wantCls);
}

async function ctrlClick(page, loc) {
  const box = await tokenBox(page, loc);
  if (!box) return { path: null, line: null };
  const before = await page.evaluate(() => modalState.path);
  await page.keyboard.down('Control');
  await page.mouse.click(box.x, box.y);
  await page.keyboard.up('Control');
  // 等跳转落地：服务端可能要跑 git grep（机器负载高时慢），别用固定等待
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    const st = await page.evaluate(() => ({ path: modalState.path, line: modalState.line }));
    if (st.path && st.path !== before) return st;
  }
  return page.evaluate(() => ({ path: modalState.path, line: modalState.line }));
}

(async () => {
  const puppeteer = loadPuppeteer();

  // 样本存在性：文件打不开就没法验证
  for (const p of [SDK, DTO, IMPL, PROVIDER]) {
    const probe = await get('/api/code?path=' + encodeURIComponent(p));
    if (!probe.j || !probe.j.content) {
      console.log('[SKIP] 样本文件打不开：' + p);
      process.exit(2);
    }
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // 找到样本里各符号所在行（不写死行号，文件一改行号就错）
  const sdkCode = (await get('/api/code?path=' + encodeURIComponent(SDK))).j.content.split('\n');
  const implCode = (await get('/api/code?path=' + encodeURIComponent(IMPL))).j.content.split('\n');
  const sdkLine = sdkCode.findIndex(l => l.includes(REQ_METHOD + '(')) + 1;
  // 请求类型在方法签名里（不是注解里 —— 注解里的词不会被 hljs 包成 token）
  const dtoLineInSdk = sdkLine;
  const implLine = implCode.findIndex(l => l.includes(REQ_TYPE + ' request')) + 1;
  const jdkLine = implCode.findIndex(l => /new\s+ArrayList<>/.test(l)) + 1;
  if (!sdkLine || !dtoLineInSdk || !implLine || !jdkLine) {
    console.log('[SKIP] 样本里找不到目标行');
    process.exit(2);
  }

  const results = {};

  // ---- 场景 1：业务模块里的 SDK 请求类 → 跳到 SDK 类定义 ----
  const locA = await locateToken(page, IMPL, implLine, REQ_TYPE, 'hljs-type', '场景1');
  const boxA = await tokenBox(page, locA);
  results.tokenA = { token: !!boxA, cls: boxA ? boxA.cls : '' };
  results.jumpA = boxA ? await ctrlClick(page, locA) : { path: null, line: null };

  // ---- 场景 2：SDK 接口里的方法 → 跳到服务端实现类的同名方法 ----
  const locB = await locateToken(page, SDK, sdkLine, REQ_METHOD, '', '场景2');
  const boxB = await tokenBox(page, locB);
  results.tokenB = { token: !!boxB, cls: boxB ? boxB.cls : '' };
  results.jumpB = boxB ? await ctrlClick(page, locB) : { path: null, line: null };

  // ---- 场景 3：SDK 接口里的请求类型 → 跳到 DTO 类定义 ----
  const locC = await locateToken(page, SDK, dtoLineInSdk, REQ_TYPE, '', '场景3');
  const boxC = await tokenBox(page, locC);
  results.tokenC = { token: !!boxC, cls: boxC ? boxC.cls : '' };
  results.jumpC = boxC ? await ctrlClick(page, locC) : { path: null, line: null };

  // ---- 场景 4（负向）：JDK 类型不乱跳，报「外部/框架方法」 ----
  const locD = await locateToken(page, IMPL, jdkLine, 'ArrayList', '', '场景4');
  const boxD = await tokenBox(page, locD);
  const before = await page.evaluate(() => modalState.path);
  let toast = '';
  if (boxD) {
    await page.keyboard.down('Control');
    await page.mouse.click(boxD.x, boxD.y);
    await page.keyboard.up('Control');
    // 等提示出现（服务端响应可能几百毫秒；toast 2.6 秒后隐藏但文本保留）
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      toast = await page.evaluate(() => {
        const t = document.getElementById('toast');
        return t ? (t.textContent || '').trim() : '';
      });
      if (toast) break;
    }
  }
  const after = await page.evaluate(() => modalState.path);
  results.toast = toast;
  results.negativeStayed = before === after;

  const checks = [
    // 场景 1
    ['场景1：业务模块里 SDK 请求类被识别成类型 token', results.tokenA.token === true && (results.tokenA.cls || '').includes('hljs-type')],
    ['场景1：Ctrl+点击能跳', !!results.jumpA.path],
    ['场景1：跳到 SDK 里的请求类文件', !!results.jumpA.path && results.jumpA.path.endsWith('CanUpdateStoreWarehouseStockRequest.java')],
    ['场景1：跳到类声明行', !!results.jumpA.line && results.jumpA.line > 0],
    // 场景 2
    ['场景2：SDK 接口方法被识别成方法 token', results.tokenB.token === true && (results.tokenB.cls || '').includes('function_')],
    ['场景2：Ctrl+点击能跳', !!results.jumpB.path],
    ['场景2：跳到服务端实现类', !!results.jumpB.path && results.jumpB.path.endsWith('StockReadServiceImpl.java')],
    ['场景2：跳到实现方法所在行（不是类声明行）', !!results.jumpB.line && results.jumpB.line > 100],
    // 场景 3
    ['场景3：SDK 接口里的请求类型能跳', !!results.jumpC.path && results.jumpC.path.endsWith('CanUpdateStoreWarehouseStockRequest.java')],
    ['场景3：跳到类声明行', !!results.jumpC.line && results.jumpC.line > 0],
    // 场景 4
    ['场景4：JDK 类型不跳走（仍在原文件）', results.negativeStayed === true],
    ['场景4：给出「外部/框架」提示', /外部|框架/.test(results.toast || '')],
    ['页面无 JS 异常', pageErrors.length === 0],
  ];

  console.log('=== SOA（ody）Ctrl+点击跳转 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  场景1 跳：${results.jumpA.path} @ L${results.jumpA.line}`);
  console.log(`  场景2 跳：${results.jumpB.path} @ L${results.jumpB.line}`);
  console.log(`  场景3 跳：${results.jumpC.path} @ L${results.jumpC.line}`);
  console.log(`  场景4 toast：${results.toast}`);
  if (pageErrors.length) console.log('  JS 异常：' + pageErrors.join(' | '));
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
