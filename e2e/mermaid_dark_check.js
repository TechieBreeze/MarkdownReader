/* mermaid 浅色节点 → 深色 回归检查
   背景（回归守卫）：
     md 里的 mermaid 常带 GitHub 风格的浅色 classDef（fill:#e8f0ff / #ffecec / #eee …），
     mermaid 会原样渲染，且这些声明带 !important —— 直接压过暗色主题的节点底色，
     于是暗色阅读器里出现浅色节点；更糟的是文字色仍取主题的浅灰 #ccc，
     浅底浅字几乎看不清。
     修法在 index.html 的 mermaidDarkenSvg()：把 classDef 的浅色底色压暗（保色相），
     同组的深色文字一起提亮；已在服务端渲染好的 SVG 也在插入时补这一刀。

   断言覆盖：
     1. 浅色底色被压暗（且色相不变）
     2. 本来就是深色的 classDef 底色不动
     3. 显式指定的深色文字被提亮（否则深字压深底看不清）
     4. 深色底色上的白字不被误改
     5. 命名色（装饰锚点）不被误改

   运行方式（需先启动服务 python server.py）：
     node e2e/mermaid_dark_check.js
   可选环境变量：
     BASE_URL               默认 http://127.0.0.1:8765/
     MDREADER_PUPPETEER     puppeteer 模块路径（默认取 mermaid-cli 自带的）

   退出码：0 = 全部通过，1 = 存在失败。
*/
const http = require('http');

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

/* 覆盖：浅底浅字 / 浅底深字 / 浅底无字 / 深底白字 / 深底浅字 / 深灰描边 */
const SRC = `flowchart TD
  A[琥珀底深字] --> B[浅蓝底]
  B --> C[浅红底]
  C --> D[深蓝底白字]
  D --> E[浅灰底深字]
  classDef amber fill:#FFB300,color:#212121,stroke:#FF8F00
  classDef lightblue fill:#e8f0ff,stroke:#36c
  classDef lightred fill:#ffecec,stroke:#c33
  classDef darkblue fill:#1565C0,color:#fff,stroke:#0D47A1
  classDef graylight fill:#eee,stroke:#333,color:#666
  class A amber
  class B lightblue
  class C lightred
  class D darkblue
  class E graylight
`;

function post(base, p, body) {
  return new Promise((ok, bad) => {
    const data = JSON.stringify(body);
    const u = new URL(p, base);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { bad(e); } }); });
    req.on('error', bad); req.write(data); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  // 服务端渲染（可能异步排队，要轮询到拿到）
  let j = null;
  for (let i = 0; i < 30; i++) {
    j = await post(BASE_URL, '/api/mermaid/render', { items: [{ id: 'm0', src: SRC }] });
    if (j.results && j.results.m0 && j.results.m0.svg) break;
    await sleep(1500);
  }
  const svg = j && j.results && j.results.m0 && j.results.m0.svg;
  if (!svg) { console.log('[FAIL] 服务端 mermaid 渲染没拿到 SVG'); await browser.close(); process.exit(1); }

  const out = await page.evaluate((svg) => {
    const fixed = mermaidDarkenSvg(svg);
    // 取某色值在 !important 声明里出现的次数
    const countOf = (s, prop, hex) => {
      const re = new RegExp(prop + ':\\s*' + hex + '\\s*!important', 'gi');
      return (s.match(re) || []).length;
    };
    const norm = (s) => s.toLowerCase();
    // 找出变换后所有 !important 的颜色（归一化成 hex 便于比较）
    const colors = (s) => {
      const set = new Map();
      for (const m of s.matchAll(/([a-z-]+):\s*([^;}"']+?)\s*!important/g)) {
        const k = m[1] + ':' + norm(m[2].trim());
        set.set(k, (set.get(k) || 0) + 1);
      }
      return set;
    };
    const before = colors(svg), after = colors(fixed);
    const has = (map, prop, hex) => {
      for (const [k, v] of map) {
        const [p, c] = k.split(':');
        if (p !== prop) continue;
        if (c === hex.toLowerCase()) return v;          // 命名色（lightgrey 等）：按原字符串比
        const rgb = _mmdRgb(c);                         // hex / rgb() 两种写法
        if (rgb && _mmdHex(rgb) === hex.toLowerCase()) return v;
      }
      return 0;
    };
    return {
      changed: svg !== fixed,
      beforeLightBlue: has(before, 'fill', '#e8f0ff'),
      afterLightBlue: has(after, 'fill', '#e8f0ff'),
      afterDarkBlueNode: has(after, 'fill', '#142b57'),
      afterLightRed: has(after, 'fill', '#571414'),
      beforeAmber: has(before, 'fill', '#ffb300'),
      afterAmber: has(after, 'fill', '#ffb300'),
      beforeDarkText: has(before, 'color', '#212121'),
      afterDarkText: has(after, 'color', '#212121'),
      afterLightText: has(after, 'color', '#d1d1d1'),
      beforeWhite: has(before, 'color', '#ffffff'),
      afterWhite: has(after, 'color', '#ffffff'),
      beforeAnchor: has(before, 'fill', 'lightgrey'),
      afterAnchor: has(after, 'fill', 'lightgrey'),
      afterGrayFill: has(after, 'fill', '#363636'),
      beforeGrayStroke: has(before, 'stroke', '#333333'),
      afterGrayStroke: has(after, 'stroke', '#333333'),
      afterGrayStrokeLit: has(after, 'stroke', '#737373'),
    };
  }, svg);

  const checks = [
    ['SVG 有被改动', out.changed],
    ['浅蓝底色 #e8f0ff 已消失', out.beforeLightBlue > 0 && out.afterLightBlue === 0],
    ['浅蓝底色变成深蓝 #142b57', out.afterDarkBlueNode > 0],
    ['浅红底色变成深红 #571414', out.afterLightRed > 0],
    ['琥珀底色 #FFB300 已消失', out.beforeAmber > 0 && out.afterAmber === 0],
    ['深色底色 #1565C0 不受影响', out.afterWhite > 0 && out.beforeWhite > 0],
    ['深色文字 #212121 已提亮', out.beforeDarkText > 0 && out.afterDarkText === 0 && out.afterLightText > 0],
    ['浅灰底 #eee 变深灰 #363636', out.afterGrayFill > 0],
    ['深灰描边 #333 提亮为 #737373', out.beforeGrayStroke > 0 && out.afterGrayStroke === 0 && out.afterGrayStrokeLit > 0],
    ['命名色装饰锚点 lightgrey 不动', out.afterAnchor > 0],
  ];
  console.log('=== mermaid 浅色节点 → 深色 ===');
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
