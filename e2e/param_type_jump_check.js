/* Java 方法签名里「参数的类型」识别与 Ctrl+点击跳转 回归检查
   背景：
     hljs 把整个参数列表塞进一个 <span class="hljs-params">(…)</span>，
     而类型增强（enhanceJavaKtTypes）是「整段 span 跳过」→ 参数里的类型
     既没上色、也不是独立 token → Ctrl+点击点不动（普通变量/字段声明在
     span 之外，不受影响）。表现就是「很短参数列表的参数类型识别不到」。

   验证（真实无头 Chrome + 真实 Ctrl+点击）：
     1. 参数列表里的类型被识别成独立 token（hljs-type），且用类型色
     2. 参数名被识别成变量（hljs-variable），与普通变量一致
     3. Ctrl+点击参数里的类型 → 跳到该类型的定义文件
     4. 同一行里带注解的参数（@RequestBody …）也一致
     5. 普通变量声明的类型仍然正常（回归）

   运行方式（需先启动服务 python server.py）：
     node e2e/param_type_jump_check.js
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
 */
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const SRC = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/api/CustomerApi.java';
const TYPE_NAME = 'DecryptMobileReqDTO';
const TYPE_FILE = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/api/dto/DecryptMobileReqDTO.java';

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
  if (!probe.j || !probe.j.content) {
    console.log('[SKIP] 样本文件打不开：' + SRC);
    process.exit(2);
  }
  // 找到「参数里带项目类型」的那一行（短参数列表）
  const lines = probe.j.content.split('\n');
  let sigLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('\\(' + TYPE_NAME + '\\s+\\w+\\)').test(lines[i])) { sigLine = i + 1; break; }
  }
  if (sigLine < 0) { console.log('[SKIP] 样本里没有 ' + TYPE_NAME + ' 的参数'); process.exit(2); }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  await page.evaluate(async (path, line) => { await openCodeModal(path, line); }, SRC, sigLine);
  await new Promise(r => setTimeout(r, 3000));

  // ---- 1/2/4. 渲染层：参数里的类型/参数名是不是独立 token ----
  const render = await page.evaluate((line, typeName) => {
    const row = document.querySelector(`#m-scroll .cl-line[data-line="${line}"]`);
    if (!row) return { row: false };
    const spans = [...row.querySelectorAll('span')].map(s => ({
      cls: s.className || '',
      txt: s.textContent,
      color: getComputedStyle(s).color,
    }));
    const typeSpan = spans.find(s => s.cls.includes('hljs-type') && s.txt === typeName);
    const varSpans = spans.filter(s => s.cls.includes('hljs-variable'));
    // 对照组：普通声明里的类型/变量（不在 params span 里）
    const refType = [...document.querySelectorAll('#m-scroll .cl-line span.hljs-type')]
      .find(s => s.textContent && s.textContent !== typeName && !/hljs-params/.test(s.className));
    const refVar = [...document.querySelectorAll('#m-scroll .cl-line span.hljs-variable')]
      .find(s => s.textContent && !/hljs-params/.test(s.className));
    // 回归：方法名（签名里的）与方法调用点仍然是 function_（不能被参数识别改掉）
    const sigFn = [...row.querySelectorAll('span')].find(s => (s.className || '').includes('function_'));
    const callFn = [...document.querySelectorAll('#m-scroll .cl-line span.hljs-title.function_')]
      .find(s => s.textContent && !/hljs-params/.test(s.className));
    return {
      row: true,
      typeFound: !!typeSpan,
      typeCls: typeSpan ? typeSpan.cls : null,
      typeColor: typeSpan ? typeSpan.color : null,
      refTypeColor: refType ? getComputedStyle(refType).color : null,
      varTexts: varSpans.map(s => s.txt),
      varColor: varSpans.length ? varSpans[0].color : null,
      refVarColor: refVar ? getComputedStyle(refVar).color : null,
      sigFnCls: sigFn ? sigFn.className : null,
      callFnCls: callFn ? callFn.className : null,
    };
  }, sigLine, TYPE_NAME);

  // ---- 3. 真实 Ctrl+点击参数里的类型 → 应跳到类型定义 ----
  const box = await page.evaluate((line, typeName) => {
    const row = document.querySelector(`#m-scroll .cl-line[data-line="${line}"]`);
    if (!row) return null;
    const span = [...row.querySelectorAll('span')].find(s => (s.className || '').includes('hljs-type') && s.textContent === typeName);
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sigLine, TYPE_NAME);

  let jumped = { path: null, line: null };
  if (box) {
    await page.keyboard.down('Control');
    await page.mouse.click(box.x, box.y);
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 3000));
    jumped = await page.evaluate(() => ({ path: modalState.path, line: modalState.line }));
  }

  const checks = [
    ['参数所在的行渲染出来了', render.row === true],
    ['参数里的类型被识别成独立 token（hljs-type）', render.typeFound === true],
    ['参数里的类型用类型色（与普通声明的类型同色）', !!render.typeColor && !!render.refTypeColor && render.typeColor === render.refTypeColor],
    ['参数名被识别成变量（hljs-variable）', render.varTexts.length > 0],
    ['参数名用变量色（与普通变量同色）', !!render.varColor && !!render.refVarColor && render.varColor === render.refVarColor],
    ['回归：签名里的方法名仍是 function_', !!(render.sigFnCls || '').includes('function_')],
    ['回归：方法调用点仍是 function_', !!(render.callFnCls || '').includes('function_')],
    ['Ctrl+点击参数里的类型能跳', !!box],
    ['跳到类型定义文件', !!jumped.path && jumped.path.endsWith('DecryptMobileReqDTO.java')],
    ['跳到类型定义行', !!jumped.line && jumped.line > 0],
    ['页面无 JS 异常', pageErrors.length === 0],
  ];

  console.log('=== Java 参数类型识别与跳转 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  样本：${SRC.split('/').pop()} 第 ${sigLine} 行`);
  console.log(`  类型 span：cls="${render.typeCls}" color=${render.typeColor}（普通类型 ${render.refTypeColor}）`);
  console.log(`  参数名 token=${JSON.stringify(render.varTexts)} color=${render.varColor}（普通变量 ${render.refVarColor}）`);
  console.log(`  跳转结果：${jumped.path} @ L${jumped.line}`);
  if (pageErrors.length) console.log('  JS 异常：' + pageErrors.join(' | '));
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
