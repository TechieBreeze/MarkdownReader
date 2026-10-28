/* 代码弹窗内的文件内搜索（Ctrl+F）回归检查
   背景：
     文件内搜索条原来只认「当前标签页」（#ct-scroll / md 正文），
     代码弹窗（#m-scroll）打开时按 Ctrl+F，搜索条要么被弹窗盖住看不见，
     要么搜的是标签页里的内容 —— 与「用户眼前正在看的代码」对不上。
     现在：弹窗打开时 Ctrl+F → 搜索作用域 = 弹窗里的代码。
     高亮标在「目标文本」上（浏览器原生 Custom Highlight API），不是整行涂黄；
     搜索时优先选中「当前视口内最靠上的那个命中」。

   场景（都走真实交互：真实 Ctrl+F 键、真实输入、真实点击按钮）：
     A. 弹窗 + 小文件（行数 < 虚拟滚动阈值）→ 全部行都在 DOM 里，断言命中的行号集合
     B. 弹窗 + 大文件（虚拟滚动，DOM 只有可视窗口）→ 断言逐个前进时经过的行号序列
     B2. 弹窗 + 大文件，开在某个命中行上 → 断言「视口内最靠上的命中」被优先选中，
         且视口没有跳到文件里第一个命中
     C. 代码标签页（回归：改造动了标签页那条路径）
     D. md 标签页（回归：fileSearchRun 的分流被改过）
     E. 弹窗的 diff 视图（删除行也能搜到）
     F. 弹窗里从搜索条跳到全局搜索，Esc 不该把代码弹窗一起关掉

   运行方式（需先启动服务 python server.py）：
     node e2e/modal_search_check.js
   可选环境变量：
     BASE_URL   默认 http://127.0.0.1:8765/
   退出码：0 = 全部通过，1 = 有失败，2 = 样本缺失（无法验证）。
 */
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const BIG = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/api/CustomerApi.java';
const SMALL = '20260917-微服务/gits/customer/src/main/java/com/pvh/customer/api/WeChatController.java';
const SCENES = [
  { tag: 'A-弹窗·小文件(全部行在DOM)', mode: 'modal', path: SMALL, line: 35, query: 'requestMap' },
  { tag: 'B-弹窗·大文件(虚拟滚动)', mode: 'modal', path: BIG, line: 143, query: 'UserFacade' },
  { tag: 'C-代码标签页(回归)', mode: 'tab', path: SMALL, line: 35, query: 'requestMap' },
];

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

const uniq = (a) => [...new Set(a)];
const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* 页面内取高亮状态（代码视图的高亮画在目标文本上，DOM 里没有 class 痕迹） */
const PAGE_HL = `
  const rowOfRange = (r) => {
    if (!r) return null;
    const el = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
    return el && el.closest ? el.closest('.cl-line') : null;
  };
  const hlInfo = () => {
    const hm = CSS.highlights.get('fs-match');
    const hc = CSS.highlights.get('fs-current');
    const ranges = hm ? [...hm] : [];
    const cur = hc && hc.size ? [...hc][0] : null;
    const curRow = rowOfRange(cur);
    return {
      matchCount: ranges.length,
      matchTexts: ranges.map(r => r.toString()),
      matchLines: ranges.map(r => { const l = rowOfRange(r); return l ? parseInt(l.dataset.line, 10) : null; }).filter(n => n != null),
      curText: cur ? cur.toString() : null,
      curLine: curRow ? parseInt(curRow.dataset.line, 10) : null,
      curVisible: (() => {
        if (!curRow) return false;
        const sc = curRow.closest('#m-scroll, #ct-scroll');
        if (!sc) return false;
        const r = curRow.getBoundingClientRect(), b = sc.getBoundingClientRect();
        return r.bottom > b.top && r.top < b.bottom;
      })(),
      rowTint: document.querySelectorAll('#m-scroll .cl-line.fs-line, #ct-scroll .cl-line.fs-line').length,
      hasHl: !!hm,
    };
  };
  /* 独立算一遍：视口内最靠上的那个命中行号（不依赖页面内部状态） */
  const topVisibleMatch = (scopeSel, expectLines) => {
    const container = document.querySelector(scopeSel);
    if (!container) return null;
    const box = container.getBoundingClientRect();
    for (const row of container.querySelectorAll('.cl-line')) {
      const ln = parseInt(row.dataset.line, 10);
      if (!expectLines.includes(ln)) continue;
      const r = row.getBoundingClientRect();
      if (r.bottom <= box.top || r.top >= box.bottom) continue;
      return ln;
    }
    return null;
  };
`;

(async () => {
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));

  const checks = [];

  /* ---------- 代码视图场景（弹窗 / 标签页） ---------- */
  for (const sc of SCENES) {
    const probe = await get('/api/code?path=' + encodeURIComponent(sc.path));
    if (!probe.j || !probe.j.content) {
      console.log('[SKIP] 样本文件打不开：' + sc.path);
      process.exit(2);
    }
    const isVirtual = probe.j.lines > 800;
    const inModal = sc.mode === 'modal';
    const scopeSel = inModal ? '#m-scroll' : '#ct-scroll';
    const otherSel = inModal ? '#ct-scroll' : '#m-scroll';

    await page.evaluate(async (mode, path, line) => {
      if (mode === 'modal') await openCodeModal(path, line);
      else { await openTab(path, { focus: true, line }); }
    }, sc.mode, sc.path, sc.line);
    await new Promise(r => setTimeout(r, 3000));

    // 期望命中：以「实际渲染出来的内容」为准
    const expect = await page.evaluate((mode, q) => {
      const cnt = (line) => {
        const l = line.toLowerCase(), s = q.toLowerCase();
        let n = 0, i = 0;
        for (;;) { const k = l.indexOf(s, i); if (k < 0) break; n++; i = k + s.length; }
        return n;
      };
      let text = '';
      if (mode === 'modal') {
        text = modalState.commitContent != null ? modalState.commitContent
          : (modalState.branchContent != null ? modalState.branchContent : modalState.content);
      } else {
        const tab = curActiveTab();
        text = tab ? (tab.branchContent != null ? tab.branchContent : (tab.content || '')) : '';
      }
      const seq = [];
      text.split('\n').forEach((l, i) => { const n = cnt(l); for (let k = 0; k < n; k++) seq.push(i + 1); });
      return { seq: seq, lines: text.split('\n').length };
    }, sc.mode, sc.query);
    const expectSeq = expect.seq;
    const expectLines = uniq(expectSeq);
    if (expectLines.length < 3) {
      console.log('[SKIP] ' + sc.tag + '：查询词命中行太少，无法验证逐个前进');
      process.exit(2);
    }

    // ---- 真实 Ctrl+F ----
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 400));
    const opened = await page.evaluate((scopeSel) => {
      const w = document.querySelector('#file-search');
      const mask = document.querySelector('#modal-mask');
      const body = document.querySelector('#modal-body');
      const wRect = w ? w.getBoundingClientRect() : null;
      const bRect = body ? body.getBoundingClientRect() : null;
      return {
        widgetVisible: !!w && getComputedStyle(w).display !== 'none',
        widgetRect: wRect ? { top: wRect.top, left: wRect.left, right: wRect.right, bottom: wRect.bottom } : null,
        bodyRect: bRect ? { top: bRect.top, left: bRect.left, right: bRect.right, bottom: bRect.bottom } : null,
        widgetZ: w ? getComputedStyle(w).zIndex : null,
        maskZ: mask ? getComputedStyle(mask).zIndex : null,
        modalOpen: !!(mask && mask.classList.contains('show')),
      };
    }, scopeSel);

    // ---- 真实输入 + 回车搜索 ----
    await page.keyboard.type(sc.query);
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 700));
    const searched = await page.evaluate(new Function('scopeSel', 'expectLines', PAGE_HL + `
      const info = hlInfo();
      const top = topVisibleMatch(scopeSel, expectLines);
      return { ...info, top: top, firstLine: expectLines[0],
               count: (document.querySelector('#fs-count') || {}).textContent || '' };
    `), scopeSel, expectLines);

    // ---- 真实点击「下一个」，记录经过的每一站 ----
    const visited = [];
    for (let i = 0; i < expectSeq.length; i++) {
      const cur = await page.evaluate(new Function(PAGE_HL + 'return hlInfo().curLine;'));
      visited.push(cur);
      if (i === expectSeq.length - 1) break;
      await page.click('#fs-next');
      await new Promise(r => setTimeout(r, 260));
    }
    const last = await page.evaluate(new Function(PAGE_HL + 'return hlInfo();'));

    // ---- 真实 Esc 关闭搜索条 ----
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 400));
    const closed = await page.evaluate(new Function(PAGE_HL + `
      const hm = CSS.highlights.get('fs-match');
      return { hasHl: !!hm, widgetVisible: getComputedStyle(document.querySelector('#file-search')).display !== 'none',
               modalOpen: document.querySelector('#modal-mask').classList.contains('show') };
    `));

    // ---- 再按 Ctrl+F 能重新唤起 ----
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 400));
    const reopened = await page.evaluate(() => getComputedStyle(document.querySelector('#file-search')).display !== 'none');

    const lower = sc.query.toLowerCase();
    const textsOk = searched.matchTexts.length > 0 && searched.matchTexts.every(t => t.toLowerCase().includes(lower));
    const widgetInside = !!(opened.widgetRect && opened.bodyRect &&
      opened.widgetRect.top >= opened.bodyRect.top - 6 &&
      opened.widgetRect.right <= opened.bodyRect.right + 6 &&
      opened.widgetRect.bottom <= opened.bodyRect.bottom + 6);

    checks.push([sc.tag + ' · Ctrl+F 唤起搜索条', opened.widgetVisible]);
    if (inModal) {
      checks.push([sc.tag + ' · 搜索条落在弹窗代码区内', widgetInside]);
      checks.push([sc.tag + ' · 搜索条层级高于代码弹窗', Number(opened.widgetZ) > Number(opened.maskZ)]);
    }
    checks.push([sc.tag + ' · 高亮画在目标文本上（每个高亮都含查询词）', textsOk]);
    checks.push([sc.tag + ' · 当前命中的高亮文本 = 查询词', (searched.curText || '').toLowerCase() === lower]);
    checks.push([sc.tag + ' · 没有整行涂黄', searched.rowTint === 0]);
    checks.push([sc.tag + ' · 初始选中 = 视口内最靠上的命中', searched.curLine === searched.top]);
    checks.push([sc.tag + ' · 命中总次数与实际内容一致', Number((/(\d+)\s*\/\s*(\d+)/.exec(searched.count || '') || [0, 0, 0])[2]) === expectSeq.length]);
    checks.push([sc.tag + ' · 逐个前进经过的行号与实际内容一致', sameSet(visited, expectSeq)]);
    checks.push([sc.tag + ' · 最后一条命中可见', last.curVisible === true]);
    checks.push([sc.tag + ' · Esc 后搜索条关闭', closed.widgetVisible === false]);
    if (inModal) checks.push([sc.tag + ' · Esc 后代码弹窗仍打开', closed.modalOpen === true]);
    checks.push([sc.tag + ' · Esc 后高亮清空', closed.hasHl === false]);
    checks.push([sc.tag + ' · 再次 Ctrl+F 能重新唤起', reopened === true]);

    console.log(`--- ${sc.tag}：${sc.path.split('/').pop()}（${expect.lines} 行${isVirtual ? '，虚拟滚动' : ''}）`);
    console.log(`    查询词「${sc.query}」真实 ${expectSeq.length} 处 / ${expectLines.length} 行（${expectLines.slice(0, 6).join(',')}…）`);
    console.log(`    当前命中行=${searched.curLine}（视口内最靠上的命中=${searched.top}），高亮区间 ${searched.matchCount} 个，整行涂黄 ${searched.rowTint} 行`);
    console.log(`    经过行号=${visited.join(',')}`);

    // 场景之间复位：关掉搜索条与弹窗（Ctrl+F 是 toggle，下个场景必须从「未打开」开始）
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => { try { closeModal(); } catch (e) { } });
    await new Promise(r => setTimeout(r, 500));
  }

  /* ---------- B2. 视口内最靠上的命中被优先选中（而不是文件里第一个命中） ---------- */
  {
    const tag = 'B2-优先选中视口内的命中';
    const q = 'UserFacade';
    // 876 行正好是一个命中行 → 打开弹窗定位到它，视口里就有命中
    await page.evaluate(async (p) => { await openCodeModal(p, 876); }, BIG);
    await new Promise(r => setTimeout(r, 3000));
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 400));
    await page.keyboard.type(q);
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 700));
    const r2 = await page.evaluate(new Function('expectLines', PAGE_HL + `
      const info = hlInfo();
      const top = topVisibleMatch('#m-scroll', expectLines);
      const sc = document.querySelector('#m-scroll');
      return { ...info, top: top, scrollTop: sc.scrollTop, firstRendered: [...sc.querySelectorAll('.cl-line')].map(x => parseInt(x.dataset.line,10)).sort((a,b)=>a-b)[0] };
    `), [12, 115, 335, 876, 894, 1005, 1106, 1117, 1280, 1559, 1699]);
    checks.push([tag + ' · 选中的是视口内最靠上的命中', r2.curLine === r2.top]);
    checks.push([tag + ' · 不是文件里第一个命中', r2.curLine !== 12]);
    checks.push([tag + ' · 视口没有跳到第一个命中那行', r2.firstRendered !== 12]);
    checks.push([tag + ' · 当前命中的高亮文本 = 查询词', (r2.curText || '').toLowerCase() === q.toLowerCase()]);
    console.log(`--- ${tag}：当前命中行=${r2.curLine}（视口内最靠上的=${r2.top}），窗口起始行=${r2.firstRendered}`);
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => { try { closeModal(); } catch (e) { } });
    await new Promise(r => setTimeout(r, 500));
  }

  /* ---------- D. md 标签页（回归：fileSearchRun 的分流被改过） ---------- */
  {
    const tag = 'D-md标签页(回归)';
    const mdPath = '20260917-微服务/docs/梳理/00-业务全景导读.md';
    const q = '会员';
    await page.evaluate(async (p) => { await openTab(p, { focus: true }); }, mdPath);
    await new Promise(r => setTimeout(r, 3000));
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 400));
    await page.keyboard.type(q);
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 800));
    const md = await page.evaluate(() => {
      const marks = [...document.querySelectorAll('.md-body mark.fs-mark')];
      const cur = document.querySelector('.md-body mark.fs-mark.fs-cur');
      return {
        widgetVisible: getComputedStyle(document.querySelector('#file-search')).display !== 'none',
        marks: marks.length,
        curText: cur ? cur.textContent : null,
        curVisible: cur ? (() => { const r = cur.getBoundingClientRect(); return r.width > 0 && r.height > 0; })() : false,
        codeHl: document.querySelectorAll('#m-scroll .fs-line, #ct-scroll .fs-line').length,
      };
    });
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 400));
    const mdClosed = await page.evaluate(() => ({
      widgetVisible: getComputedStyle(document.querySelector('#file-search')).display !== 'none',
      marks: document.querySelectorAll('.md-body mark.fs-mark').length,
    }));
    checks.push([tag + ' · Ctrl+F 唤起搜索条', md.widgetVisible]);
    checks.push([tag + ' · md 正文里找到命中', md.marks > 0]);
    checks.push([tag + ' · 当前命中有高亮', !!md.curText]);
    checks.push([tag + ' · 当前命中可见', md.curVisible === true]);
    checks.push([tag + ' · 代码视图没有被误标', md.codeHl === 0]);
    checks.push([tag + ' · Esc 后搜索条关闭', mdClosed.widgetVisible === false]);
    checks.push([tag + ' · Esc 后 md 高亮清空', mdClosed.marks === 0]);
    console.log(`--- ${tag}：${mdPath.split('/').pop()}`);
    console.log(`    命中 mark=${md.marks} 处`);
  }

  /* ---------- E. 代码弹窗的 diff 视图（删除行也能搜到） ---------- */
  {
    const tag = 'E-弹窗·diff视图';
    const path = BIG;
    await page.evaluate(async (p) => { await openCodeModal(p, 100); }, path);
    await new Promise(r => setTimeout(r, 2500));
    const commits = await page.evaluate(() => {
      const sel = document.querySelector('#m-commit');
      if (!sel) return [];
      return [...sel.options].map(o => o.value).filter(v => v && v !== sel.options[0].value).slice(0, 12);
    });
    if (!commits.length) {
      console.log('[SKIP] ' + tag + '：该文件没有可选的提交');
    } else {
      let picked = null;
      for (const c of commits) {
        const d = await get('/api/git/diff?path=' + encodeURIComponent(path) + '&commit=' + encodeURIComponent(c));
        if (!d.j || !d.j.hunks) continue;
        const delWords = new Set();
        for (const h of d.j.hunks) for (const l of (h.lines || [])) {
          if (l.type !== '-') continue;
          for (const m of String(l.text).match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) || []) delWords.add(m);
        }
        if (delWords.size) { picked = { commit: c, word: [...delWords][0] }; break; }
      }
      if (!picked) {
        console.log('[SKIP] ' + tag + '：这些提交的删除行里没有可搜的词');
      } else {
        const { commit, word } = picked;
        await page.select('#m-commit', commit);
        await new Promise(r => setTimeout(r, 3000));
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyF');
        await page.keyboard.up('Control');
        await new Promise(r => setTimeout(r, 400));
        await page.keyboard.type(word);
        await new Promise(r => setTimeout(r, 200));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 800));
        const total = await page.evaluate(() => {
          const t = (document.querySelector('#fs-count') || {}).textContent || '';
          const m = /(\d+)\s*\/\s*(\d+)/.exec(t);
          return m ? parseInt(m[2], 10) : 0;
        });
        const visited = [];
        for (let i = 0; i < total; i++) {
          const st = await page.evaluate(() => {
            const hc = CSS.highlights.get('fs-current');
            const cur2 = hc && hc.size ? [...hc][0] : null;
            const row = (() => {
              if (!cur2) return null;
              const el = (cur2.startContainer.nodeType === 1 ? cur2.startContainer : cur2.startContainer.parentElement);
              return el && el.closest ? el.closest('.cl-line') : null;
            })();
            return { isDel: row ? row.classList.contains('g-del') : false, text: cur2 ? cur2.toString() : '' };
          });
          if (!st.text) break;
          visited.push(st);
          if (i === total - 1) break;
          await page.click('#fs-next');
          await new Promise(r => setTimeout(r, 240));
        }
        const lower = word.toLowerCase();
        const visitedOk = visited.length > 0 && visited.every(v => v.text.toLowerCase().includes(lower));
        checks.push([tag + ' · diff 视图里找到命中', visited.length > 0]);
        checks.push([tag + ' · 逐个前进经过的行都含该词', visitedOk]);
        checks.push([tag + ' · 能搜到 diff 里的删除行', visited.some(v => v.isDel)]);
        console.log(`--- ${tag}：提交 ${commit.slice(0, 8)}，查询词「${word}」（取自删除行）`);
        console.log(`    经过 ${visited.length} 条，其中删除行 ${visited.filter(v => v.isDel).length} 条`);
      }
      await page.keyboard.press('Escape');
      await new Promise(r => setTimeout(r, 300));
      await page.evaluate(() => { try { closeModal(); } catch (e) { } });
      await new Promise(r => setTimeout(r, 500));
    }
  }

  /* ---------- F. 弹窗里从搜索条跳到全局搜索，Esc 不该把代码弹窗一起关掉 ---------- */
  {
    const tag = 'F-弹窗·全局搜索Esc';
    await page.evaluate(async (p) => { await openCodeModal(p, 100); }, BIG);
    await new Promise(r => setTimeout(r, 2500));
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 400));
    await page.click('#fs-global');           // 真实点击「全局」按钮
    await new Promise(r => setTimeout(r, 600));
    const gsOpen = await page.evaluate(() => ({
      gs: document.querySelector('#gsearch-mask').classList.contains('show'),
      modal: document.querySelector('#modal-mask').classList.contains('show'),
      fs: getComputedStyle(document.querySelector('#file-search')).display !== 'none',
      gsZ: getComputedStyle(document.querySelector('#gsearch-mask')).zIndex,
      fsZ: getComputedStyle(document.querySelector('#file-search')).zIndex,
    }));
    await page.keyboard.press('Escape');      // 真实 Esc：只关全局搜索
    await new Promise(r => setTimeout(r, 500));
    const gsClosed = await page.evaluate(() => ({
      gs: document.querySelector('#gsearch-mask').classList.contains('show'),
      modal: document.querySelector('#modal-mask').classList.contains('show'),
    }));
    checks.push([tag + ' · 「全局」按钮打开全局搜索', gsOpen.gs === true]);
    checks.push([tag + ' · 全局搜索层级高于搜索条', Number(gsOpen.gsZ) > Number(gsOpen.fsZ)]);
    checks.push([tag + ' · 打开全局搜索时搜索条收起', gsOpen.fs === false]);
    checks.push([tag + ' · Esc 只关全局搜索', gsClosed.gs === false]);
    checks.push([tag + ' · Esc 后代码弹窗仍打开', gsClosed.modal === true]);
    await page.evaluate(() => { try { closeModal(); } catch (e) { } });
    await new Promise(r => setTimeout(r, 500));
  }
  checks.push(['页面无 JS 异常', pageErrors.length === 0]);

  console.log('=== 代码弹窗内 Ctrl+F 搜索 ===');
  let fail = 0;
  for (const [name, ok] of checks) {
    if (!ok) fail++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  }
  if (pageErrors.length) console.log('  JS 异常：' + pageErrors.join(' | '));
  if (fail) console.log(`\n共 ${fail} 项失败`);
  else console.log('\n全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
