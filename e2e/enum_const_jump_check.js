/* 枚举值（enum constant）高亮与 Ctrl+点击跳转 回归检查
   背景：
     Java 枚举里的常量（RulesTypeEnum.POINT_REDEMPTION）之前既没有独立 token
     （hljs 不标它，类型增强也只管 PascalCase），点击落在纯文本上 → 认不出 kind → 跳不动。
     现在：全大写标识符 → hljs-constant（独立 token + 常量色），点击按 kind=constant
     由服务端解析到「枚举常量声明行」。

   验证（真实无头 Chrome + 真实 Ctrl+点击）：
     1. 枚举常量的引用处（X.CONST）被识别成独立 token（hljs-constant）且有常量色
     2. Ctrl+点击它 → 跳到枚举文件里该常量的声明行
     3. 枚举类里常量的声明处同样被识别成 hljs-constant
     4. 页面无 JS 异常

   运行方式（需先启动服务 python server.py）：
     node e2e/enum_const_jump_check.js
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
 */
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const SRC = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/api/CustomerApi.java';
const ENUM = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/model/enums/RulesTypeEnum.java';
const CONST = 'REGISTER_POINT_TYPE';

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

(async () => {
  const puppeteer = loadPuppeteer();
  const probe = await get('/api/code?path=' + encodeURIComponent(SRC));
  if (!probe.j || !probe.j.content) { console.log('[SKIP] 样本文件打不开'); process.exit(2); }
  const lines = probe.j.content.split('\n');
  let useLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('RulesTypeEnum.') && lines[i].includes(CONST)) { useLine = i + 1; break; }
  }
  if (useLine < 0) { console.log('[SKIP] 样本里没有 ' + CONST + ' 的引用'); process.exit(2); }

  const enumProbe = await get('/api/code?path=' + encodeURIComponent(ENUM));
  if (!enumProbe.j || !enumProbe.j.content) { console.log('[SKIP] 枚举文件打不开'); process.exit(2); }
  const enumLines = enumProbe.j.content.split('\n');
  let declLine = -1;
  for (let i = 0; i < enumLines.length; i++) {
    if (enumLines[i].trim().startsWith(CONST)) { declLine = i + 1; break; }
  }
  if (declLine < 0) { console.log('[SKIP] 枚举里找不到 ' + CONST + ' 的声明'); process.exit(2); }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // ---- 1. 引用处：枚举常量是独立 token + 常量色 ----
  await page.evaluate(async (p, line) => { await openCodeModal(p, line); }, SRC, useLine);
  await new Promise(r => setTimeout(r, 3000));
  const ref = await page.evaluate((line, name) => {
    const row = document.querySelector(`#m-scroll .cl-line[data-line="${line}"]`);
    if (!row) return { row: false };
    const spans = [...row.querySelectorAll('span')];
    const c = spans.find(s => (s.className || '').includes('hljs-constant') && s.textContent === name);
    const plain = spans.find(s => !(s.className || '').includes('hljs-constant') && s.textContent && s.textContent !== name);
    return {
      row: true,
      found: !!c,
      cls: c ? c.className : null,
      color: c ? getComputedStyle(c).color : null,
      plainColor: plain ? getComputedStyle(plain).color : null,
    };
  }, useLine, CONST);

  // ---- 2. 真实 Ctrl+点击枚举常量 → 跳到枚举里的声明行 ----
  const box = await page.evaluate((line, name) => {
    const row = document.querySelector(`#m-scroll .cl-line[data-line="${line}"]`);
    if (!row) return null;
    const s = [...row.querySelectorAll('span')].find(x => (x.className || '').includes('hljs-constant') && x.textContent === name);
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, useLine, CONST);
  let jumped = { path: null, line: null };
  if (box) {
    await page.keyboard.down('Control');
    await page.mouse.click(box.x, box.y);
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 3500));
    jumped = await page.evaluate(() => ({ path: modalState.path, line: modalState.line }));
  }

  // ---- 3. 枚举类里常量的声明处也是 hljs-constant ----
  await page.evaluate(async (p, line) => { await openCodeModal(p, line); }, ENUM, declLine);
  await new Promise(r => setTimeout(r, 3000));
  const decl = await page.evaluate((line, name) => {
    const row = document.querySelector(`#m-scroll .cl-line[data-line="${line}"]`);
    if (!row) return { row: false };
    const c = [...row.querySelectorAll('span')].find(s => (s.className || '').includes('hljs-constant') && s.textContent === name);
    return { row: true, found: !!c, cls: c ? c.className : null };
  }, declLine, CONST);

  const checks = [
    ['枚举常量的引用行渲染出来了', ref.row === true],
    ['枚举常量被识别成独立 token（hljs-constant）', ref.found === true],
    ['枚举常量用常量色（与普通文字不同）', !!ref.color && !!ref.plainColor && ref.color !== ref.plainColor],
    ['Ctrl+点击枚举常量能跳', !!box],
    ['跳到枚举文件', !!jumped.path && jumped.path.endsWith('RulesTypeEnum.java')],
    ['跳到该常量的声明行', jumped.line === declLine],
    ['枚举类里常量声明处也是 hljs-constant', decl.found === true],
    ['页面无 JS 异常', pageErrors.length === 0],
  ];

  console.log('=== 枚举值高亮与跳转 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  样本：${SRC.split('/').pop()} 第 ${useLine} 行 → ${ENUM.split('/').pop()} 第 ${declLine} 行`);
  console.log(`  常量 span：cls="${ref.cls}" color=${ref.color}（普通文字 ${ref.plainColor}）`);
  console.log(`  跳转结果：${jumped.path} @ L${jumped.line}`);
  if (pageErrors.length) console.log('  JS 异常：' + pageErrors.join(' | '));
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
