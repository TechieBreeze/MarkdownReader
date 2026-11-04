/* 批量渲染 mermaid → SVG（复用一次浏览器，避免每图启动 Chromium）
   用法: node render-mermaid-batch.js <源文件> <输出目录>
   源文件格式: 每行一条 base64(mermaid源码)，或直接多行 mermaid 源码用 --- 分隔
   输出: <outdir>/<index>.svg */
const fs = require("fs");
const path = require("path");

(async () => {
  const srcFile = process.argv[2];
  const outDir = process.argv[3];
  const limit = parseInt(process.argv[4] || "0", 10);

  const text = fs.readFileSync(srcFile, "utf8");
  // 用 ---MMD--- 分隔每个图
  const sources = text.split(/^---MMD---$/m).map(s => s.trim()).filter(Boolean);
  const list = limit > 0 ? sources.slice(0, limit) : sources;
  console.log("共", list.length, "个图");

  // 加载 mermaid 库（mermaid-cli 依赖）
  const mmdPath = "C:/Users/1/AppData/Roaming/npm/node_modules/@mermaid-js/mermaid-cli";
  const puppeteer = require(mmdPath + "/node_modules/puppeteer");

  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.goto("about:blank");
  // 注入 mermaid
  const mermaidSrc = fs.readFileSync(path.join(mmdPath, "node_modules/mermaid/dist/mermaid.min.js"), "utf8");
  await page.evaluate(mermaidSrc);
  // 暗色主题，与页面 github-dark 风格一致（默认 default 是亮色）
  await page.evaluate(() => {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "loose" });
  });

  const t0 = Date.now();
  const results = { ok: 0, err: 0 };
  for (let i = 0; i < list.length; i++) {
    const src = list[i];
    try {
      const svg = await page.evaluate(async (code, id) => {
        const m = await mermaid.render("b-" + id, code);
        return m.svg;
      }, src, i);
      fs.writeFileSync(path.join(outDir, i + ".svg"), svg);
      results.ok++;
    } catch (e) {
      results.err++;
      fs.writeFileSync(path.join(outDir, i + ".err.txt"), String(e.message || e).slice(0, 500));
    }
    if ((i + 1) % 10 === 0) {
      const el = ((Date.now() - t0) / (i + 1) * list.length / 1000).toFixed(0);
      console.log(`  ${i + 1}/${list.length} 预估剩余 ${el}s`);
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("完成:", results.ok, "成功", results.err, "失败", "耗时", dt + "s");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
