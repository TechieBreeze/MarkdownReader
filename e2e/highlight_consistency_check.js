/* 代码高亮一致性检查 —— md 正文代码块 vs 代码视图
   背景（回归守卫）：
     · md 代码块与代码视图必须走同一条高亮管线（highlightCodeHtml / highlightToLines），
       同一段源码两处的着色（token class 集合）必须完全一致。
     · highlight.js v11 的 Java 语法遇到泛型（List<VO> / Map<String, Object>>）会
       「放弃整段高亮」并返回纯文本 —— 只靠 hljs 的旧实现会让整块代码无色，
       Java/Kotlin 后处理（补类型色/方法名/变量色）负责兜住这类代码块。

   运行方式（需先启动服务 python server.py）：
     node e2e/highlight_consistency_check.js
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

/* 覆盖：多语言 + 泛型 + 特殊字符
   label = 用例名；lang = 传给高亮管线的语言名 */
const SAMPLES = [
  {
    label: 'java', lang: 'java',
    code: [
      'import java.util.List;',
      'public class Demo {',
      '  private List<String> names;',
      '  public void run() {',
      '    int count = 0;',
      '    if (count < 10 && count > 1) {',
      '      helper.doThing(count);',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  },
  {
    label: 'java 泛型（hljs 会放弃整段高亮）', lang: 'java', generic: true,
    code: 'List<Map<String, Object>> list = mapper.listMapBySql(param.getSelectSql(), query);\n' +
      'list.stream().forEach(item -> results.add(DataExportItem.of(item)));',
  },
  {
    label: 'java 泛型 + 强转', lang: 'java', generic: true,
    code: 'List<StockVO> rows = list.stream().map(map -> JSONObject.parseObject(map))\n' +
      '        .collect(Collectors.toList());\n' +
      'rows.forEach(vo -> results.add(DataExportItem.of((Map<String, Object>) vo)));',
  },
  { label: 'js', lang: 'js', code: 'const a = 1;\nfunction f(x) { return `v${x}`; }\n// note\n' },
  { label: 'python', lang: 'python', code: 'def f(x):\n    """doc"""\n    return x + 1\n' },
  { label: 'xml', lang: 'xml', code: '<div class="a">text</div>\n' },
  { label: 'bash', lang: 'bash', code: 'echo "hi" | grep -q x\n' },
  { label: 'json', lang: 'json', code: '{"a": 1, "b": [true, null]}\n' },
  { label: 'js 特殊字符', lang: 'js', code: 'if (a<b && c>d) { }\nlet s = "x<y>z";\n' },
];

(async () => {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1500));

  const res = await page.evaluate((SAMPLES) => {
    const out = { rows: [], errors: [] };
    for (const s of SAMPLES) {
      const code = s.code;
      let view = '', md = '';
      try {
        view = highlightByLine(code, s.lang).join('\n');     // 代码视图管线
        md = renderHighlightedCode(code, s.lang);            // md 代码块管线
      } catch (e) {
        out.errors.push(s.label + ': ' + (e && e.message));
        continue;
      }
      // 拼回 HTML 后文本应还原为源码（转义正确）
      const d = document.createElement('div');
      d.innerHTML = md;
      const pre = document.createElement('pre');
      pre.appendChild(d);
      // token class 集合
      const clsOf = (html) => {
        const t = document.createElement('div');
        t.innerHTML = html;
        return [...new Set([...t.querySelectorAll('span')].map(x => x.className))].sort().join('|');
      };
      out.rows.push({
        label: s.label,
        generic: !!s.generic,
        identical: view === md,
        escaped: pre.textContent === code,
        sameClasses: clsOf(view) === clsOf(md),
        spanCount: (md.match(/<span/g) || []).length,
      });
    }
    return out;
  }, SAMPLES);

  console.log('=== md 代码块 vs 代码视图：着色一致性 ===');
  let fail = 0;
  for (const r of res.rows) {
    const ok = r.identical && r.escaped && r.sameClasses;
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${r.label}` +
      `  逐字节一致=${r.identical} 转义还原=${r.escaped} class一致=${r.sameClasses} token数=${r.spanCount}`);
  }
  // 泛型代码块必须有高亮（用户报告过的回归点）
  for (const r of res.rows.filter(x => x.generic)) {
    const ok = r.spanCount > 0;
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] 泛型代码块有高亮 token（${r.label}）: ${r.spanCount}`);
  }
  if (res.errors.length) {
    fail++;
    console.log('  [FAIL] 执行异常: ' + res.errors.join('; '));
  }
  if (pageErrors.length) {
    fail++;
    console.log('  [FAIL] 页面 JS 错误: ' + pageErrors.join('; '));
  }
  console.log(fail ? `\n共 ${fail} 项失败` : '\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
