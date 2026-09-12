/** The browser module cache shares successful/concurrent loads. No application
 * promise cache pins a rejected load or a PDF document to the app lifetime. */
export async function loadPdfRuntime() {
  return (await import('./pdf-runtime')).pdfjsLib;
}
