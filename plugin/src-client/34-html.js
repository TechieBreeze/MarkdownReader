/**
 * HTML / image tab views — owned by the html slice.
 *
 * Contracts (wired by 50-app.js, owned by the workbench teammate):
 *   h(HtmlTabView, { tab, onLocate })     tab = { id, kind:'html', path, content?, htmlMode:'render'|'source', line }
 *                                         渲染模式：<iframe src="/markdown-reader/api/html?path=…">
 *                                         源码模式：带行号的 HTML 源码（可切回渲染）
 *   h(ImageView, { tab })                 tab = { id, kind:'image', path }
 */
function HtmlTabView() {
  return null
}

function ImageView() {
  return null
}
