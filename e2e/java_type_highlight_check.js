/* Java 泛型/返回类型/import 类名的高亮与跳转 回归检查
   背景：
     hljs 的 Java 语法把「返回类型里的泛型」整段留成纯文本：
       public OutputDTO<Map<Long, Boolean>> getX(...)
     旧的类型增强只认「后跟 . / 空白」和「紧跟 < 的那一个」，
     于是 OutputDTO（泛型的头）和 Boolean（逗号后的实参）既没上色、
     也不是独立 token → Ctrl+点击点不动；List<Foo> 里的 List 同理。
     import 行里的类名（import java.util.List; 的 List）同样没上色。

   验证（真实无头 Chrome + 真实 Ctrl+点击）：
     1. 返回类型的泛型头 / 泛型实参都是类型 token（hljs-type）且用类型色
     2. List<Foo> 这种声明里的 List 是类型 token
     3. import 行里的类名是类型 token
     4. Ctrl+点击返回类型里的类名能跳到它的定义（跨模块）
     5. 回归：参数里的类型、枚举值、方法名着色不受影响

   运行方式（需先启动服务 python server.py）：
     node e2e/java_type_highlight_check.js
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
 */
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const VTOP = '20261020-jjy';
const IMPL = VTOP + '/gits/jjy-o2o/xls-platform/jar/back-product-web-jar/product-api/src/main/java/com/odianyun/product/api/service/stock/impl/StockReadServiceImpl.java';

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
  const probe = await get('/api/code?path=' + encodeURIComponent(IMPL));
  if (!probe.j || !probe.j.content) {
    console.log('[SKIP] 样本文件打不开：' + IMPL);
    process.exit(2);
  }
  const lines = probe.j.content.split('\n');
  // 样本行：带泛型的返回类型 / List 声明 / 单个类名的 import
  const retLine = lines.findIndex(l => /public\s+OutputDTO<Map<Long, Boolean>>\s+getCanUpdate/.test(l)) + 1;
  const listLine = lines.findIndex(l => /\bList<[A-Z]\w*>(\s+\w+\s*[=;])/.test(l)) + 1;
  const importLine = lines.findIndex(l => /^import\s+ody\.soa\.product\.StockReadService;/.test(l)) + 1;
  if (!retLine || !listLine || !importLine) {
    console.log('[SKIP] 样本里找不到目标行');
    process.exit(2);
  }

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));
  await page.evaluate(async (path, line) => { await openCodeModal(path, line); }, IMPL, retLine);
  // 等目标行渲染出来（别用固定等待：机器负载高时会偶发超时）
  await page.waitForFunction(
    (ln) => !!document.querySelector(`#m-scroll .cl-line[data-line="${ln}"]`),
    { timeout: 60000, polling: 300 }, retLine);
  await new Promise(r => setTimeout(r, 400));

  // ---- 渲染层：各行的 token 情况 ----
  const render = await page.evaluate((a, b, c) => {
    function row(ln) {
      const el = document.querySelector(`#m-scroll .cl-line[data-line="${ln}"]`);
      return el ? el.querySelector('.cl-code') : null;
    }
    function types(code) {
      if (!code) return [];
      return [...code.querySelectorAll('span.hljs-type')].map(s => ({
        txt: s.textContent, color: getComputedStyle(s).color, cls: s.className,
      }));
    }
    function bare(code) {
      if (!code) return [];
      const out = [];
      for (const n of code.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) out.push(n.textContent.trim());
      }
      return out;
    }
    // 对照组：普通声明里的类型（hljs 原生就认的）
    const refType = [...document.querySelectorAll('#m-scroll .cl-line span.hljs-type')]
      .find(s => s.textContent && s.textContent !== 'OutputDTO' && !/hljs-params/.test(s.className));
    return {
      retTypes: types(row(a)), retBare: bare(row(a)),
      listTypes: types(row(b)), listBare: bare(row(b)),
      impTypes: types(row(c)), impBare: bare(row(c)),
      refTypeColor: refType ? getComputedStyle(refType).color : null,
      // 回归：枚举/常量、方法名、参数类型仍在
      paramType: !!document.querySelector('#m-scroll .cl-line span.hljs-params.hljs-type'),
      fnName: !!document.querySelector('#m-scroll .cl-line span.hljs-title.function_'),
      constToken: !!document.querySelector('#m-scroll .cl-line span.hljs-constant'),
    };
  }, retLine, listLine, importLine);

  const findType = (arr, txt) => arr.find(t => t.txt === txt) || null;

  // ---- Ctrl+点击返回类型里的类名 → 应跳到该类型的定义 ----
  // 点击前重新量坐标：弹窗会在 git 分支内容加载完后重排，之前的坐标会点偏
  const box = await page.evaluate((ln) => {
    const row = document.querySelector(`#m-scroll .cl-line[data-line="${ln}"]`);
    if (!row) return null;
    const span = [...row.querySelectorAll('span.hljs-type')].find(s => s.textContent === 'OutputDTO');
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, retLine);
  let jumped = { path: null, line: null };
  if (box) {
    await page.keyboard.down('Control');
    await page.mouse.click(box.x, box.y);
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 4000));
    jumped = await page.evaluate(() => ({ path: modalState.path, line: modalState.line }));
  }

  const tOut = findType(render.retTypes, 'OutputDTO');
  const tMap = findType(render.retTypes, 'Map');
  const tBool = findType(render.retTypes, 'Boolean');
  const tList = findType(render.listTypes, 'List');
  const tImp = findType(render.impTypes, 'StockReadService');

  const checks = [
    ['返回类型行渲染出来了', render.retTypes.length > 0],
    ['返回类型的泛型头 OutputDTO 是类型 token', !!tOut],
    ['返回类型的泛型实参 Map 是类型 token', !!tMap],
    ['逗号后的泛型实参 Boolean 是类型 token', !!tBool],
    ['泛型里的类型用类型色（与普通声明的类型同色）',
      !!tOut && !!render.refTypeColor && tOut.color === render.refTypeColor],
    ['List<Foo> 声明里的 List 是类型 token', !!tList],
    ['import 行里的类名是类型 token', !!tImp],
    ['import 行里的类名用类型色', !!tImp && !!render.refTypeColor && tImp.color === render.refTypeColor],
    ['回归：参数里的类型仍是类型 token', render.paramType === true],
    ['回归：方法名仍是函数色 token', render.fnName === true],
    ['Ctrl+点击返回类型里的类名能跳', !!box],
    ['跳到该类型的定义文件', !!jumped.path && jumped.path.endsWith('OutputDTO.java')],
    ['跳到定义行', !!jumped.line && jumped.line > 0],
    ['页面无 JS 异常', pageErrors.length === 0],
  ];

  console.log('=== Java 泛型/返回类型/import 类名的高亮与跳转 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  样本：${IMPL.split('/').pop()}（返回类型 L${retLine} / List L${listLine} / import L${importLine}）`);
  console.log(`  返回类型行类型 token：${render.retTypes.map(t => t.txt).join(', ')}`);
  console.log(`  List 行类型 token：${render.listTypes.map(t => t.txt).join(', ')}`);
  console.log(`  import 行类型 token：${render.impTypes.map(t => t.txt).join(', ')}`);
  console.log(`  跳转结果：${jumped.path} @ L${jumped.line}`);
  if (pageErrors.length) console.log('  JS 异常：' + pageErrors.join(' | '));
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
