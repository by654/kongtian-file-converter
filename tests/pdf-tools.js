import { ensurePdfLib } from '../js/engine/pdf.js';
import {
  applyPagePlan, batesPdf, bookletPdf, clearMetadataPdf, comparePdfs, cropPdf, deletePdfPages,
  editMetadataPdf, extractPdfPages, headerFooterPdf, nupPdf, pageNumbersPdf, pdfInfo, pdfToBmp,
  pdfToCbz, pdfToHtml, pdfToJson, pdfToTiff, redactPdf, resizePdf, sanitizePdf, textToPdf, watermarkPdf,
} from '../js/engine/pdf-tools.js';

const out = document.getElementById('log');
const results = [];
const started = performance.now();
function say(msg) {
  out.textContent += '\n' + msg;
  console.log(msg);
}

async function test(label, fn) {
  const t = performance.now();
  try {
    const res = await fn();
    const first = Array.isArray(res) ? res[0] : res;
    const size = first && (first.blob ? first.blob.size : first.size) || 0;
    if (!size) throw new Error('输出为空');
    results.push({ label, ok: true, size, ms: Math.round(performance.now() - t) });
    say(`OK ${label}  ${Math.round(performance.now() - t)}ms  ${size}B`);
  } catch (e) {
    const msg = (e && (e.message || String(e))) || 'unknown';
    results.push({ label, ok: false, error: msg.slice(0, 240), ms: Math.round(performance.now() - t) });
    say(`FAIL ${label}  ${msg.slice(0, 200)}`);
  }
}

async function makeSamplePdf(pages = 6) {
  const { PDFDocument, StandardFonts, rgb } = await ensurePdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 40, y: 720, width: 515, height: 70, color: rgb(0.08, 0.2, 0.42) });
    page.drawText('KongTian PDF Tools Test', { x: 58, y: 748, size: 20, font: bold, color: rgb(1, 1, 1) });
    page.drawText('Page ' + i + ' / ' + pages, { x: 58, y: 300, size: 14, font, color: rgb(0.1, 0.12, 0.18) });
    page.drawCircle({ x: 500, y: 340, size: 24, color: rgb(0.2, 0.7, 0.95) });
  }
  const bytes = await doc.save();
  return new File([bytes], 'sample.pdf', { type: 'application/pdf' });
}

async function main() {
  say('生成测试 PDF…');
  const sample = await makeSamplePdf(6);
  const sample2 = await makeSamplePdf(4);

  await test('pdfInfo', async () => {
    const info = await pdfInfo(sample);
    if (info.pageCount !== 6) throw new Error('页数错误 ' + info.pageCount);
    return [{ size: info.pageCount }];
  });

  await test('applyPagePlan(排序/旋转/复制/空白)', () => applyPagePlan(sample, [
    { src: 2, rotate: 90 }, { src: 0 }, { blank: true, width: 595, height: 842 }, { src: 1 }, { src: 1, rotate: -90 },
  ]));

  await test('deletePdfPages', () => deletePdfPages(sample, { range: '2,4-5' }));
  await test('extractPdfPages(single)', () => extractPdfPages(sample, { range: '1-3,6', extractMode: 'single' }));
  await test('extractPdfPages(separate)', () => extractPdfPages(sample, { range: '1-2,4-6', extractMode: 'separate' }));
  await test('nupPdf(4合1)', () => nupPdf(sample, { nupGrid: '4', nupOrientation: 'auto', nupMargin: '18', nupGap: '8' }));
  await test('nupPdf(2合1)', () => nupPdf(sample, { nupGrid: '2', nupOrientation: 'auto' }));
  await test('bookletPdf', () => bookletPdf(sample, { nupMargin: '12' }));
  await test('resizePdf(A4)', () => resizePdf(sample, { pageSizeTarget: 'a4', pageSizeOrientation: 'auto' }));
  await test('cropPdf', () => cropPdf(sample, { cropTop: '20', cropRight: '20', cropBottom: '20', cropLeft: '20' }));
  await test('watermarkPdf(中文)', () => watermarkPdf(sample, { wmText: '内部资料 · 禁止外传', wmSize: '48', wmOpacity: '22', wmRotation: '-30', wmColor: '#d11a2a', wmMode: 'center' }));
  await test('watermarkPdf(平铺)', () => watermarkPdf(sample, { wmText: 'CONFIDENTIAL', wmSize: '30', wmOpacity: '18', wmRotation: '-30', wmColor: '#1a73e8', wmMode: 'tile' }));
  await test('pageNumbersPdf', () => pageNumbersPdf(sample, { pnPosition: 'bottom-center', pnFormat: 'n-total', pnStart: '1', pnSize: '10', pnColor: '#334155' }));
  await test('headerFooterPdf(中文)', () => headerFooterPdf(sample, { hfHeader: '空天文件转换 · 内部文件', hfFooter: '2026-11-08', hfSize: '9', hfColor: '#64748b' }));
  await test('batesPdf', () => batesPdf(sample, { batesPrefix: 'KT', batesStart: '1', batesDigits: '6', batesSize: '9' }));
  await test('redactPdf', () => redactPdf(sample, { redactRects: '1:40,60,300,80;2:120,500,200,50', redactColor: '#000000' }));
  await test('editMetadataPdf', () => editMetadataPdf(sample, { metaTitle: '空天测试', metaAuthor: 'KongTian', metaSubject: 'PDF 工具测试', metaKeywords: 'pdf,test', metaCreator: '空天文件转换' }));
  await test('clearMetadataPdf', () => clearMetadataPdf(sample, {}));
  await test('sanitizePdf', () => sanitizePdf(sample, {}));
  await test('pdfToHtml', () => pdfToHtml(sample, { range: '1-2' }));
  await test('pdfToBmp', () => pdfToBmp(sample, { range: '1', dpi: '72' }));
  await test('pdfToTiff', () => pdfToTiff(sample, { range: '1-2', dpi: '72' }));
  await test('pdfToCbz', () => pdfToCbz(sample, { range: '1-2', dpi: '72', quality: '80' }));
  await test('pdfToJson', () => pdfToJson(sample, { range: '1-2' }));
  await test('textToPdf(中文 Markdown 多页)', () => {
    const md = '# 空天文件转换\n\n' + Array.from({ length: 90 }, (_, i) => `第 ${i + 1} 段：这是一段用于验证自动换行、分页与中文字形渲染的测试文字。`).join('\n\n');
    return textToPdf(new Blob([md], { type: 'text/markdown' }), { textPdfSize: '12', textPdfMargin: '20' }, {}, 'sample.md', 'md');
  });
  await test('comparePdfs', () => comparePdfs(sample, sample2, {}, { onStage() {}, onProgress() {} }));

  const summary = {
    ok: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok).length,
    totalMs: Math.round(performance.now() - started),
    results,
  };
  say(`\n完成：${summary.ok} 通过 / ${summary.fail} 失败，用时 ${summary.totalMs}ms`);
  document.title = 'DONE ' + summary.ok + '/' + (summary.ok + summary.fail);
  try {
    await fetch('/__pdf-tools-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
  } catch (_) {}
}

main().catch((e) => {
  say('脚本异常：' + (e && (e.stack || e.message || e)));
  document.title = 'DONE 0/0 ERROR';
});
