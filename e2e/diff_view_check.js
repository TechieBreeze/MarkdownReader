/* commit diff 视图回归检查（空行 / 丢行 / 长路径）
   背景（三个已确认的真 bug）：
   1) 服务端取「某提交版本的文件内容」用 `git show <rev>:<path>`，在 Windows 上会被
      git 当成 pathspec 去 stat：「仓库根路径 + 40 位哈希 + 长相对路径」拼起来超过
      MAX_PATH(260) → git 报 "Filename too long" 失败 → /api/git/file 返回 404。
      前端拿不到文件内容 → 未改动区域全补成空行 → diff 视图一大片「莫名空行」
      （实测：20261020-jjy 的 xls-platform/jar/back-product-web-jar 下的 Java 文件，
       dev_1119 最新提交，54 行空行；修复后只剩文件里本来就有的 13 行空行）。
      修法：改用 `git cat-file blob <rev>:<path>`（按对象名取 blob，不 stat 路径）。
   2) 服务端 diff 解析把 hunk 内部以 "--- "/"+++ " 开头的行当文件头丢掉
      （SQL 注释 "-- xxx"、Markdown 分隔线 "--- xxx"）→ 该行从 diff 里消失、
      后续行号错位、diff 视图串行。
   3) 前端在拿不到文件内容时仍按空数组补「未改动区域」→ 补出一长串空行。
      修法：fileLines 传 null 表示「无文件内容」，此时只渲染改动块。

   运行方式（需先启动服务 python server.py）：
     node e2e/diff_view_check.js
   可选环境变量：
     BASE_URL   默认 http://127.0.0.1:8765/
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
*/
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';

/* 样本：用户报的那个文件（长路径 + 仓库嵌套 → 触发 MAX_PATH） */
const SAMPLE = {
  path: '20261020-jjy/gits/jjy-o2o/xls-platform/jar/back-product-web-jar/product-business/src/main/java/com/odianyun/product/business/support/data/expt/handler/ImWarehouseRealStockExportHandler.java',
  commit: '196f7e9ecc0b3d057f736ea5a1160d500b14938f',
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
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { ok({ status: res.statusCode, j: JSON.parse(b) }); } catch (e) { ok({ status: res.statusCode, j: null }); } });
    }).on('error', () => ok({ status: 0, j: null }));
  });
}

(async () => {
  const puppeteer = loadPuppeteer();

  // —— 接口层：长路径 + 提交哈希必须能取到文件内容（bug 1 的回归守卫）——
  const fq = await get('/api/git/file?path=' + encodeURIComponent(SAMPLE.path) + '&commit=' + SAMPLE.commit);
  const dq = await get('/api/git/diff?path=' + encodeURIComponent(SAMPLE.path) + '&commit=' + SAMPLE.commit);
  if (!dq.j || !dq.j.hunks || !dq.j.hunks.length) {
    console.log('[SKIP] 样本不存在或该提交没改此文件（换个工作区/提交再跑）：' + SAMPLE.path);
    process.exit(2);
  }
  const fileOk = !!(fq.j && fq.j.content);
  const fileLines = fileOk ? fq.j.content.split('\n') : [];

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  const out = await page.evaluate(async (path, commit) => {
    const j = await api('/api/git/diff?path=' + encodeURIComponent(path) + '&commit=' + encodeURIComponent(commit));
    const fj = await api('/api/git/file?path=' + encodeURIComponent(path) + '&commit=' + encodeURIComponent(commit)).catch(() => null);
    const fileLines = fj && fj.content ? fj.content.split('\n') : null;
    const hunks = j.hunks || [];

    // 复刻 renderFileWithDiff 的行序列
    const build = (fl) => {
      const rows = [];
      let fileIdx = 0;
      const hasFile = Array.isArray(fl);
      hunks.forEach(h => {
        while (hasFile && fileIdx < h.new_start - 1) { rows.push({ kind: 'plain', text: fl[fileIdx] || '' }); fileIdx++; }
        h.lines.forEach(l => {
          if (l.type === '-') rows.push({ kind: 'del', text: l.text });
          else if (l.type === '+') { rows.push({ kind: 'add', text: l.text }); fileIdx++; }
          else { rows.push({ kind: 'ctx', text: l.text }); fileIdx++; }
        });
      });
      while (hasFile && fileIdx < fl.length) { rows.push({ kind: 'plain', text: fl[fileIdx] }); fileIdx++; }
      return rows;
    };
    const maxRun = (rows) => {
      let best = 0, run = 0;
      for (const r of rows) {
        if (r.text === '') { run++; if (run > best) best = run; } else run = 0;
      }
      return best;
    };
    const withFile = build(fileLines);
    const withoutFile = build(null);   // 取不到文件内容 → 只渲染改动块
    // 「未改动区域」补出来的行 = kind=plain（改动块内部不会有 plain）
    const fillerRows = (rows) => rows.filter(r => r.kind === 'plain').length;

    // 真实渲染（fileLines=null）到独立容器，确认 DOM 里没有补出来的空行
    const host = document.createElement('div');
    host.className = 'ct-scroll';
    host.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:600px;';
    document.body.appendChild(host);
    renderFileWithDiff(null, hunks, j.meta || {}, host, path);
    await new Promise(r => setTimeout(r, 150));
    const domRows = [...host.querySelectorAll('.cl-line')];
    let domEmpty = 0;
    for (const d of domRows) {
      const c = d.querySelector('.cl-code');
      if (c && c.textContent.replace(/^[\s+−]/, '').trim() === '') domEmpty++;
    }
    host.remove();

    return {
      hunkCount: hunks.length,
      hunkLines: hunks.reduce((s, h) => s + h.lines.length, 0),
      rowsWithFile: withFile.length,
      rowsWithoutFile: withoutFile.length,
      fillerWithoutFile: fillerRows(withoutFile),
      fillerWithFile: fillerRows(withFile),
      emptyWithFile: withFile.filter(r => r.text === '').length,
      fileEmpty: fileLines ? fileLines.filter(t => t === '').length : 0,
      maxEmptyRunWithFile: maxRun(withFile),
      maxEmptyRunWithoutFile: maxRun(withoutFile),
      domRows: domRows.length,
      domEmptyWithoutFile: domEmpty,
    };
  }, SAMPLE.path, SAMPLE.commit);

  const checks = [
    // bug 1：长路径 + 提交哈希能取到文件内容
    ['长路径文件内容接口返回 200', fileOk],
    ['文件内容长度合理（>100 字符）', fileOk && fileLines.join('\n').length > 100],
    // bug 3：无文件内容时只渲染改动块，不补空行
    ['无文件内容时行数 = 改动块行数', out.rowsWithoutFile === out.hunkLines],
    ['无文件内容时不补「未改动区域」行', out.fillerWithoutFile === 0],
    ['无文件内容时 DOM 行数 = 改动块行数', out.domRows === out.hunkLines],
    // 有文件内容时，空行数与文件本身一致（不多不少）
    ['空行数 = 文件本身的空行数', out.emptyWithFile === out.fileEmpty],
    ['最长连续空行不超过文件里的连续空行', out.maxEmptyRunWithFile <= 3],
    // 页面无 JS 异常
    ['页面无 JS 异常', pageErrors.length === 0],
  ];
  console.log('=== commit diff 视图回归检查 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  console.log(`  样本：${SAMPLE.path.split('/').pop()} @ ${SAMPLE.commit.slice(0, 8)}`);
  console.log(`  改动块 ${out.hunkCount} 个 / ${out.hunkLines} 行；空行 ${out.emptyWithFile}（文件本身 ${out.fileEmpty}）`);
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
