/**
 * Code modal (弹窗) — owned by the modal slice.
 *
 * Contract (wired by 50-app.js):
 *   h(CodeModal, {
 *     request,          // null | { path: string, line: number } — code file to show
 *     onClose,          // close the modal
 *     onOpenTab,        // open the same file at the same line as a tab
 *     onOpen,           // open another file (Ctrl+click navigation) in a tab
 *   })
 */
function CodeModal() {
  return null
}
