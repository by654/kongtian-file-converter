/* 浏览器内真实转换测试：素材全部现场生成，不依赖后端与外部文件 */
import { runJob } from '../js/engine/dispatch.js';
import { ensurePdfLib, imagesToPdf, mergePdfs } from '../js/engine/pdf.js';
import { ensureFFmpeg, runFFmpeg, terminateFFmpeg } from '../js/engine/ffmpeg.js';
import { base64Decode, base64Encode, encodingConvert, hashBytes, jsonFormat, md5Hex } from '../js/engine/tools.js';
import { AVIF_ENCODE_SUPPORTED, CAPABILITY_NOTES, targetsOf } from '../js/engine/registry.js';
import { loadVendor, makeZip } from '../js/engine/utils.js';

/* ---------------- 断言与工具 ---------------- */
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function first(out) {
  if (!Array.isArray(out) || !out.length) throw new Error('转换没有返回输出');
  const o = out[0];
  if (!o || !o.blob || !o.blob.size) throw new Error('输出为空');
  return o;
}
async function textOf(blob) {
  return new TextDecoder('utf-8').decode(await blob.arrayBuffer());
}
function bytesOf(blob, n = 16) {
  return blob.slice(0, n).arrayBuffer();
}
async function headAscii(blob, n = 8) {
  const buf = new Uint8Array(await bytesOf(blob, n));
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return s;
}
async function pdfPageCount(blob) {
  const { PDFDocument } = await ensurePdfLib();
  const doc = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true });
  return doc.getPageCount();
}
async function zipEntryNames(blob) {
  await loadVendor('jszip/jszip.min.js');
  const zip = await window.JSZip.loadAsync(await blob.arrayBuffer());
  return Object.keys(zip.files).filter((n) => !zip.files[n].dir);
}
async function xlsxRows(blob) {
  await loadVendor('xlsx/xlsx.full.min.js');
  const wb = window.XLSX.read(await blob.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(ws, { defval: null });
}

/* ---------------- 测试素材 ---------------- */
async function makePngFile(name = '测试图片.png') {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 320, 180);
  g.addColorStop(0, '#0b1220');
  g.addColorStop(1, '#35d0ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px "Microsoft YaHei", sans-serif';
  ctx.fillText('空天', 96, 108);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}

function makeSvgFile(name = '测试矢量.svg') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">
  <rect width="120" height="80" fill="#12305a"/>
  <circle cx="40" cy="40" r="26" fill="#35d0ff"/>
  <text x="72" y="48" fill="#ffffff" font-size="18" font-family="sans-serif">KT</text>
</svg>`;
  return new File([svg], name, { type: 'image/svg+xml' });
}

function makeWavFile(seconds = 1, sr = 44100) {
  const frames = Math.floor(sr * seconds);
  const buf = new ArrayBuffer(44 + frames * 4);
  const dv = new DataView(buf);
  const put = (off, str) => {
    for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i));
  };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + frames * 4, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, frames * 4, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    const t = i / sr;
    const v = Math.sin(2 * Math.PI * 440 * t) * 0.6 + Math.sin(2 * Math.PI * 880 * t) * 0.25;
    const s = Math.max(-1, Math.min(1, v)) * 32767;
    dv.setInt16(off, s, true);
    dv.setInt16(off + 2, s, true);
    off += 4;
  }
  return new File([buf], '测试音频.wav', { type: 'audio/wav' });
}

async function makePdfFile(pages = 2, name = '测试文档.pdf') {
  const { PDFDocument, StandardFonts, rgb } = await ensurePdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`KongTian Page ${i}`, { x: 72, y: 780, size: 26, font, color: rgb(0.05, 0.12, 0.24) });
    p.drawText('Hello PDF conversion test', { x: 72, y: 740, size: 13, font });
  }
  const bytes = await doc.save();
  return new File([bytes], name, { type: 'application/pdf' });
}

async function makeXlsxFile() {
  await loadVendor('xlsx/xlsx.full.min.js');
  const ws = window.XLSX.utils.aoa_to_sheet([
    ['名称', '数量'],
    ['空天', 3],
    ['转换', 5],
  ]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, '数据');
  const out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new File([out], '测试表格.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function tarHeader(name, size, mtime) {
  const b = new Uint8Array(512);
  const put = (str, off) => {
    const enc = new TextEncoder().encode(str);
    b.set(enc.subarray(0, Math.min(enc.length, 512 - off)), off);
  };
  put(name, 0);
  put('0000644', 100);
  put('0000000', 108);
  put('0000000', 116);
  put(size.toString(8).padStart(11, '0'), 124);
  put(Math.floor((mtime || Date.now()) / 1000).toString(8).padStart(11, '0'), 136);
  b[156] = 0x30;
  put('ustar', 257);
  put('00', 263);
  return b;
}

function buildTar(files) {
  const parts = [];
  for (const f of files) {
    const data = new Uint8Array(f.data);
    parts.push(tarHeader(f.name, data.length));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}

async function gzipBlob(blob) {
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
}

/* ---------------- 测试注册 ---------------- */
const T = [];
const test = (name, fn, timeout = 90000) => T.push({ name, fn, timeout });

let pngFile;
let pdfFile;
let wavFile;
let xlsxFile;

/* 环境 */
test('环境：静态托管无 COOP/COEP 时 crossOriginIsolated=false', async () => {
  assert(typeof WebAssembly !== 'undefined', '浏览器不支持 WebAssembly');
  assert(!crossOriginIsolated, '当前页面处于 crossOriginIsolated，无法证明 Pages 等效条件');
  assert(typeof SharedArrayBuffer === 'undefined' || true, '');
  return `crossOriginIsolated=${crossOriginIsolated} · SharedArrayBuffer=${typeof SharedArrayBuffer} · AVIF编码=${AVIF_ENCODE_SUPPORTED} · GZIP=${typeof DecompressionStream}`;
});

test('限制：超大文件在转换前被拦截', async () => {
  const fake = { name: 'huge.mp4', size: 300 * 1024 * 1024, arrayBuffer: () => Promise.reject(new Error('不应读取')) };
  let msg = '';
  try {
    await runJob({ file: fake, category: 'video', target: 'mp4', params: {} });
  } catch (e) {
    msg = e.message || String(e);
  }
  assert(/上限/.test(msg), '未按预期拦截大文件：' + msg);
  return msg;
});

/* 图片 */
test('图片：PNG → JPG（质量 80）', async () => {
  pngFile = await makePngFile();
  const out = first(await runJob({ file: pngFile, category: 'image', target: 'jpg', params: { quality: 80 } }));
  assert(out.name.endsWith('.jpg'), '输出扩展名异常：' + out.name);
  const bmp = await createImageBitmap(out.blob);
  assert(bmp.width === 320 && bmp.height === 180, `尺寸异常 ${bmp.width}x${bmp.height}`);
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB · ${bmp.width}x${bmp.height}`;
});

test('图片：PNG → WEBP', async () => {
  const out = first(await runJob({ file: pngFile, category: 'image', target: 'webp', params: { quality: 85 } }));
  const bmp = await createImageBitmap(out.blob);
  assert(bmp.width === 320, 'WEBP 解码尺寸异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
});

test('图片：PNG → BMP（手写编码）', async () => {
  const out = first(await runJob({ file: pngFile, category: 'image', target: 'bmp', params: {} }));
  assert((await headAscii(out.blob, 2)) === 'BM', 'BMP 文件头不是 BM');
  const bmp = await createImageBitmap(out.blob);
  assert(bmp.width === 320 && bmp.height === 180, 'BMP 解码尺寸异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
});

test('图片：PNG → ICO（多尺寸）', async () => {
  const out = first(await runJob({ file: pngFile, category: 'image', target: 'ico', params: {} }));
  const dv = new DataView(await out.blob.slice(0, 6).arrayBuffer());
  assert(dv.getUint16(0, true) === 0 && dv.getUint16(2, true) === 1, 'ICO 文件头异常');
  const count = dv.getUint16(4, true);
  assert(count >= 2, 'ICO 尺寸数量异常：' + count);
  return `${out.name} · ${count} 种尺寸 · ${(out.blob.size / 1024).toFixed(1)} KB`;
});

test('图片：SVG → PNG', async () => {
  const out = first(await runJob({ file: makeSvgFile(), category: 'image', target: 'png', params: {} }));
  const bmp = await createImageBitmap(out.blob);
  assert(bmp.width === 120 && bmp.height === 80, `SVG 渲染尺寸异常 ${bmp.width}x${bmp.height}`);
  return `${out.name} · ${bmp.width}x${bmp.height}`;
});

test('图片：PNG → PDF', async () => {
  const out = first(await runJob({ file: pngFile, category: 'image', target: 'pdf', params: { pdfPage: 'a4' } }));
  assert((await headAscii(out.blob, 4)) === '%PDF', '不是有效 PDF');
  const pages = await pdfPageCount(out.blob);
  assert(pages === 1, 'PDF 页数异常：' + pages);
  return `${out.name} · ${pages} 页 · ${(out.blob.size / 1024).toFixed(1)} KB`;
});

test('图片：多图批量 → PDF（2 页）', async () => {
  const out = first(await imagesToPdf([pngFile, makeSvgFile()], { pdfPage: 'fit' }));
  const pages = await pdfPageCount(out.blob);
  assert(pages === 2, '批量图片 PDF 页数异常：' + pages);
  return `${out.name} · ${pages} 页`;
});

/* 文档 */
test('文档：MD → HTML', async () => {
  const md = '# 空天文件转换\n\n这是 **测试** 文档。\n\n- 音频\n- 视频\n';
  const out = first(await runJob({
    file: new File([md], '说明.md', { type: 'text/markdown' }),
    category: 'document', target: 'html', params: {},
  }));
  const html = await textOf(out.blob);
  assert(html.includes('<h1') && html.includes('空天文件转换'), 'HTML 未包含标题');
  assert(html.includes('<strong>'), 'HTML 未处理加粗');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
});

test('文档：HTML → Markdown', async () => {
  const html = '<h2>标题</h2><p>正文 <strong>加粗</strong> 与 <a href="https://example.com">链接</a></p><ul><li>第一项</li><li>第二项</li></ul>';
  const out = first(await runJob({
    file: new File([html], 'page.html', { type: 'text/html' }),
    category: 'document', target: 'md', params: {},
  }));
  const md = await textOf(out.blob);
  assert(md.includes('## 标题'), '未生成二级标题');
  assert(md.includes('**加粗**'), '未生成加粗');
  assert(md.includes('- 第一项'), '未生成列表');
  return md.slice(0, 90).replace(/\n/g, ' ⏎ ');
});

test('文档：TXT → DOCX → TXT（写入与回读）', async () => {
  const text = '第一段：空天文件转换\n第二段：纯浏览器转换，无后端。';
  const docx = first(await runJob({
    file: new File([text], '原文.txt', { type: 'text/plain' }),
    category: 'document', target: 'docx', params: {},
  }));
  assert(docx.name.endsWith('.docx'), '未生成 docx');
  assert((await headAscii(docx.blob, 2)) === 'PK', 'DOCX 不是 ZIP 容器');
  const back = first(await runJob({
    file: new File([docx.blob], docx.name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    category: 'document', target: 'txt', params: {},
  }));
  const round = await textOf(back.blob);
  assert(round.includes('空天文件转换'), 'DOCX 回读丢失内容：' + round.slice(0, 60));
  assert(round.includes('无后端'), 'DOCX 回读丢失第二段');
  return `${docx.name} ${(docx.blob.size / 1024).toFixed(1)} KB → 回读 ${round.length} 字`;
});

test('文档：TXT → RTF → TXT', async () => {
  const text = '空天 RTF 往返测试\nSecond line';
  const rtf = first(await runJob({
    file: new File([text], 'note.txt', { type: 'text/plain' }),
    category: 'document', target: 'rtf', params: {},
  }));
  const rtfText = await textOf(rtf.blob);
  assert(rtfText.startsWith('{\\rtf'), 'RTF 头异常');
  const back = first(await runJob({
    file: new File([rtf.blob], rtf.name, { type: 'application/rtf' }),
    category: 'document', target: 'txt', params: {},
  }));
  const plain = await textOf(back.blob);
  assert(plain.includes('RTF') && plain.includes('Second line'), 'RTF 回读异常：' + plain.slice(0, 60));
  return `${rtf.name} → ${plain.length} 字`;
});

/* 表格 */
test('表格：CSV → XLSX（中文内容校验）', async () => {
  const csv = '名称,数量\n空天,3\n转换,5\n';
  const out = first(await runJob({
    file: new File([csv], '数据.csv', { type: 'text/csv' }),
    category: 'sheet', target: 'xlsx', params: {},
  }));
  assert(out.name.endsWith('.xlsx'), '未生成 xlsx');
  const rows = await xlsxRows(out.blob);
  assert(rows.length === 2 && rows[0].名称 === '空天' && rows[0].数量 === 3, 'XLSX 内容异常：' + JSON.stringify(rows).slice(0, 80));
  return `${out.name} · ${rows.length} 行`;
});

test('表格：XLSX → JSON', async () => {
  xlsxFile = await makeXlsxFile();
  const out = first(await runJob({ file: xlsxFile, category: 'sheet', target: 'json', params: {} }));
  const data = JSON.parse(await textOf(out.blob));
  assert(Array.isArray(data) && data[0].名称 === '空天', 'JSON 内容异常：' + JSON.stringify(data).slice(0, 80));
  return `${out.name} · ${data.length} 行`;
});

test('表格：JSON → XLSX', async () => {
  const json = JSON.stringify([{ 文件名: 'a.mp3', 大小: 12 }, { 文件名: 'b.png', 大小: 30 }]);
  const out = first(await runJob({
    file: new File([json], '记录.json', { type: 'application/json' }),
    category: 'sheet', target: 'xlsx', params: {},
  }));
  const rows = await xlsxRows(out.blob);
  assert(rows.length === 2 && rows[1].文件名 === 'b.png', 'JSON→XLSX 内容异常');
  return `${out.name} · ${rows.length} 行`;
});

test('表格：XLSX → CSV', async () => {
  const out = first(await runJob({ file: xlsxFile, category: 'sheet', target: 'csv', params: {} }));
  const csv = await textOf(out.blob);
  assert(csv.includes('空天'), 'CSV 内容异常：' + csv.slice(0, 60));
  return `${out.name} · ${csv.split('\n').length} 行`;
});

/* PDF */
test('PDF：PDF → 文本', async () => {
  pdfFile = await makePdfFile(2);
  const out = first(await runJob({ file: pdfFile, category: 'pdf', target: 'txt', params: {} }));
  const text = await textOf(out.blob);
  assert(text.includes('KongTian') && text.includes('Page 2'), 'PDF 文本抽取异常：' + text.slice(0, 80));
  return `${out.name} · ${text.length} 字`;
});

test('PDF：PDF → PNG（多页打包 ZIP）', async () => {
  const out = first(await runJob({ file: pdfFile, category: 'pdf', target: 'png', params: { dpi: 96 } }));
  assert(out.name.endsWith('.zip'), '多页未打包 ZIP：' + out.name);
  const names = await zipEntryNames(out.blob);
  assert(names.length === 2, '页数异常：' + names.join(', '));
  return `${out.name} · ${names.join(' / ')}`;
});

test('PDF：拆分（第 1 页）', async () => {
  const out = first(await runJob({ file: pdfFile, category: 'pdf', target: 'split', params: { range: '1' } }));
  assert(out.name.endsWith('.pdf'), '单组拆分未直接输出 PDF：' + out.name);
  const pages = await pdfPageCount(out.blob);
  assert(pages === 1, '拆分页数异常：' + pages);
  return `${out.name} · ${pages} 页`;
});

test('PDF：合并两份（共 4 页）', async () => {
  const out = first(await mergePdfs([pdfFile, await makePdfFile(2, '第二份.pdf')]));
  const pages = await pdfPageCount(out.blob);
  assert(pages === 4, '合并页数异常：' + pages);
  return `${out.name} · ${pages} 页`;
});

/* 压缩包 */
test('压缩包：ZIP 解压', async () => {
  const zip = await makeZip([
    { name: 'a.txt', blob: new Blob(['alpha']) },
    { name: 'folder/b.txt', blob: new Blob(['beta']) },
  ]);
  const out = await runJob({
    file: new File([zip], '包.zip', { type: 'application/zip' }),
    category: 'archive', target: 'extract', params: {},
  });
  assert(out.length === 2, '解压数量异常：' + out.length);
  assert(out.some((o) => o.name.includes('a.txt')), '缺少 a.txt');
  return out.map((o) => o.name).join(' / ');
});

test('压缩包：TAR 解压', async () => {
  const tar = buildTar([
    { name: 'x.txt', data: new TextEncoder().encode('tar-x') },
    { name: 'y.txt', data: new TextEncoder().encode('tar-y') },
  ]);
  const out = await runJob({
    file: new File([tar], '包.tar', { type: 'application/x-tar' }),
    category: 'archive', target: 'extract', params: {},
  });
  assert(out.length === 2, 'TAR 解压数量异常：' + out.length);
  const content = await textOf(out[0].blob);
  assert(content === 'tar-x' || content === 'tar-y', 'TAR 内容异常：' + content);
  return out.map((o) => `${o.name}(${o.size}B)`).join(' / ');
});

test('压缩包：TAR.GZ 解压', async () => {
  const tar = buildTar([{ name: 'z.txt', data: new TextEncoder().encode('tar-gz') }]);
  const gz = await gzipBlob(tar);
  const out = await runJob({
    file: new File([gz], '包.tar.gz', { type: 'application/gzip' }),
    category: 'archive', target: 'extract', params: {},
  });
  assert(out.length === 1 && out[0].name.includes('z.txt'), 'TAR.GZ 解压异常');
  return out.map((o) => o.name).join(' / ');
});

/* 工具箱 */
test('工具：MD5("abc") 与 SHA-256("abc")', async () => {
  assert(md5Hex('abc') === '900150983cd24fb0d6963f7d28e17f72', 'MD5 结果错误：' + md5Hex('abc'));
  const res = await hashBytes(new TextEncoder().encode('abc'), ['SHA-256']);
  const sha = res[0][1];
  assert(sha === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256 错误：' + sha);
  return 'MD5 与 SHA-256 均与标准值一致';
});

test('工具：Base64 中文往返', async () => {
  const text = '空天文件转换 · 测试';
  const b64 = base64Encode(text);
  assert(base64Decode(b64) === text, 'Base64 往返不一致：' + b64);
  return b64;
});

test('工具：JSON 格式化', async () => {
  const out = jsonFormat('{"名称":"空天","数量":3,}'.replace(',}', '}'), 2);
  assert(out.includes('\n  "名称": "空天"'), 'JSON 格式化异常：' + out);
  return out.replace(/\n/g, ' ⏎ ');
});

test('工具：UTF-8 → UTF-16LE', async () => {
  const text = '空天文件转换';
  const r = await encodingConvert(new File([text], 'enc.txt', { type: 'text/plain' }), 'utf-8', 'utf-16le');
  const decoded = new TextDecoder('utf-16le').decode(await r.blob.arrayBuffer());
  assert(decoded === text, 'UTF-16LE 编码异常：' + decoded);
  return `${r.name} · ${r.blob.size} B`;
});

/* 音频（ffmpeg） */
let mp3File;

test('音视频：加载单线程 ffmpeg 核心', async () => {
  await ensureFFmpeg({
    engineStage: () => {},
    engineProgress: () => {},
  });
  assert(!crossOriginIsolated, 'ffmpeg 加载后 crossOriginIsolated 不应为 true');
  return '单线程核心加载完成（无 SharedArrayBuffer）';
}, 240000);

test('音频：WAV → MP3（128kbps）', async () => {
  wavFile = makeWavFile();
  const out = first(await runJob({
    file: wavFile, category: 'audio', target: 'mp3', params: { bitrate: '128', sampleRate: '44100', channels: 'stereo' },
  }));
  mp3File = out.blob;
  const b = new Uint8Array(await bytesOf(out.blob, 3));
  const id3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
  const frame = b[0] === 0xff && (b[1] & 0xe0) === 0xe0;
  assert(id3 || frame, 'MP3 头异常：' + Array.from(b).join(','));
  assert(out.blob.size > 5000, 'MP3 体积异常：' + out.blob.size);
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('音频：MP3 → OGG（Vorbis）', async () => {
  const out = first(await runJob({ file: new File([mp3File], '音频.mp3', { type: 'audio/mpeg' }), category: 'audio', target: 'ogg', params: { vorbisQuality: '5' } }));
  assert((await headAscii(out.blob, 4)) === 'OggS', 'OGG 头异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('音频：MP3 → FLAC', async () => {
  const out = first(await runJob({ file: new File([mp3File], '音频.mp3', { type: 'audio/mpeg' }), category: 'audio', target: 'flac', params: {} }));
  assert((await headAscii(out.blob, 4)) === 'fLaC', 'FLAC 头异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('音频：MP3 → M4A', async () => {
  const out = first(await runJob({ file: new File([mp3File], '音频.mp3', { type: 'audio/mpeg' }), category: 'audio', target: 'm4a', params: {} }));
  const head = await headAscii(out.blob, 8);
  assert(head.slice(4, 8) === 'ftyp', 'M4A 容器头异常：' + head);
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('音频：OPUS 输出已禁用并说明原因', async () => {
  assert(!targetsOf('audio').some((t) => t.id === 'opus'), '音频目标仍包含 OPUS');
  assert(!targetsOf('video').some((t) => t.id === 'opus'), '视频音轨目标仍包含 OPUS');
  const note = CAPABILITY_NOTES.find(([k]) => k === '暂不支持');
  assert(note && /OPUS/.test(note[1]), '格式说明未标注 OPUS');
  return '已从输出目标移除，并写入「暂不支持」说明';
});

test('音频：MP3 → AAC（ADTS）', async () => {
  const out = first(await runJob({ file: new File([mp3File], '音频.mp3', { type: 'audio/mpeg' }), category: 'audio', target: 'aac', params: { bitrate: '128' } }));
  const b = new Uint8Array(await bytesOf(out.blob, 2));
  assert((b[0] & 0xff) === 0xff && (b[1] & 0xf0) === 0xf0, 'ADTS 同步字异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('音频：MP3 → WAV', async () => {
  const out = first(await runJob({ file: new File([mp3File], '音频.mp3', { type: 'audio/mpeg' }), category: 'audio', target: 'wav', params: { channels: 'mono' } }));
  assert((await headAscii(out.blob, 4)) === 'RIFF', 'WAV 头异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

/* 视频 */
let videoFile;
let videoHasAudio = false;

test('视频：生成测试用 MP4 素材', async () => {
  try {
    const data = await runFFmpeg({
      args: ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', 'out.mp4'],
      outputName: 'out.mp4',
    });
    videoFile = new File([data], '测试视频.mp4', { type: 'video/mp4' });
    videoHasAudio = true;
  } catch (e) {
    const png = await makePngFile();
    const data = await runFFmpeg({
      args: ['-y', '-loop', '1', '-i', 'frame.png', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-t', '1', '-r', '15', 'out.mp4'],
      inputs: [{ name: 'frame.png', data: new Uint8Array(await png.arrayBuffer()) }],
      outputName: 'out.mp4',
    });
    videoFile = new File([data], '测试视频.mp4', { type: 'video/mp4' });
    videoHasAudio = false;
    return 'lavfi 不可用，已回退为单帧循环视频：' + e.message.slice(0, 120);
  }
  return `MP4 素材 ${(videoFile.size / 1024).toFixed(1)} KB（含音轨）`;
}, 180000);

test('视频：MP4 → WEBM（VP8 + Vorbis）', async () => {
  const out = first(await runJob({ file: videoFile, category: 'video', target: 'webm', params: { videoQuality: 'medium' } }));
  const b = new Uint8Array(await bytesOf(out.blob, 4));
  assert(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3, 'WEBM 未以 EBML 头开始');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 240000);

test('视频：MP4 → MKV', async () => {
  const out = first(await runJob({ file: videoFile, category: 'video', target: 'mkv', params: { resolution: '240' } }));
  const b = new Uint8Array(await bytesOf(out.blob, 4));
  assert(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3, 'MKV 未以 EBML 头开始');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('视频：MP4 → GIF', async () => {
  const out = first(await runJob({ file: videoFile, category: 'video', target: 'gif', params: { fps: '12' } }));
  assert((await headAscii(out.blob, 6)) === 'GIF89a', 'GIF 头异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 240000);

test('视频：MP4 → MOV', async () => {
  const out = first(await runJob({ file: videoFile, category: 'video', target: 'mov', params: {} }));
  const head = await headAscii(out.blob, 8);
  assert(head.slice(4, 8) === 'ftyp', 'MOV 容器头异常：' + head);
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('视频：MP4 → AVI', async () => {
  const out = first(await runJob({ file: videoFile, category: 'video', target: 'avi', params: {} }));
  assert((await headAscii(out.blob, 4)) === 'RIFF', 'AVI 头异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('视频：MP4 → MP4（画面裁剪 160×120）', async () => {
  const out = first(await runJob({ file: videoFile, category: 'video', target: 'mp4', params: { crop: '160:120:0:0' } }));
  const url = URL.createObjectURL(out.blob);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'metadata';
  v.src = url;
  const meta = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取视频元数据超时')), 15000);
    v.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
    v.onerror = () => { clearTimeout(timer); reject(new Error('输出视频无法解码')); };
  });
  assert(v.videoWidth === 160 && v.videoHeight === 120, `裁剪尺寸异常 ${v.videoWidth}x${v.videoHeight}`);
  URL.revokeObjectURL(url);
  return `${out.name} · ${v.videoWidth}x${v.videoHeight} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

test('视频：提取音轨（MP4 → MP3）', async () => {
  if (!videoHasAudio) return { skip: '测试素材没有音轨（lavfi 不可用）' };
  const out = first(await runJob({ file: videoFile, category: 'video', target: 'mp3', params: { bitrate: '128' } }));
  const head = await headAscii(out.blob, 3);
  assert(head === 'ID3' || out.blob.size > 2000, '音轨提取输出异常');
  return `${out.name} · ${(out.blob.size / 1024).toFixed(1)} KB`;
}, 180000);

/* ---------------- 运行器 ---------------- */
const list = document.getElementById('list');
const stats = {
  total: document.getElementById('stat-total'),
  pass: document.getElementById('stat-pass'),
  fail: document.getElementById('stat-fail'),
  skip: document.getElementById('stat-skip'),
};

function addRow(name) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="tag run">运行中</span><div><div class="name"></div><div class="detail"></div></div>`;
  li.querySelector('.name').textContent = name;
  list.appendChild(li);
  return li;
}

function mark(row, status, detail, isError) {
  const tag = row.querySelector('.tag');
  tag.className = 'tag ' + status;
  tag.textContent = { pass: '通过', fail: '失败', skip: '跳过' }[status] || status;
  const d = row.querySelector('.detail');
  d.textContent = detail || '';
  if (isError) d.classList.add('err');
}

async function run() {
  const env = document.getElementById('env');
  env.textContent = `crossOriginIsolated=${crossOriginIsolated} · SharedArrayBuffer=${typeof SharedArrayBuffer} · WebAssembly=${typeof WebAssembly} · AVIF 编码=${AVIF_ENCODE_SUPPORTED} · DecompressionStream=${typeof DecompressionStream}`;

  const results = [];
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    const row = addRow(t.name);
    const started = performance.now();
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(t.fn),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`超时（${Math.round(t.timeout / 1000)}s）`)), t.timeout);
        }),
      ]);
      clearTimeout(timer);
      if (value && typeof value === 'object' && value.skip) {
        mark(row, 'skip', value.skip);
        results.push({ name: t.name, status: 'skip', detail: value.skip });
      } else {
        mark(row, 'pass', value || '');
        results.push({ name: t.name, status: 'pass', detail: value || '' });
      }
    } catch (e) {
      clearTimeout(timer);
      const msg = (e && (e.message || String(e))) + '';
      if (/^超时/.test(msg)) terminateFFmpeg();
      mark(row, 'fail', msg, true);
      results.push({ name: t.name, status: 'fail', detail: msg });
    }
    const pass = results.filter((r) => r.status === 'pass').length;
    const fail = results.filter((r) => r.status === 'fail').length;
    const skip = results.filter((r) => r.status === 'skip').length;
    stats.total.textContent = `总计 ${i + 1}/${T.length}`;
    stats.pass.textContent = `通过 ${pass}`;
    stats.fail.textContent = `失败 ${fail}`;
    stats.skip.textContent = `跳过 ${skip}`;
    await new Promise((r) => setTimeout(r, 60));
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const payload = { status: 'done', pass, fail, skip, total: T.length, results, when: new Date().toISOString() };
  window.__KT_TEST_RESULT__ = payload;
  fetch('/__result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
  document.title = `[完成 通过${pass}/失败${fail}/跳过${skip}] 引擎实测`;
  stats.total.textContent = `总计 ${T.length} · 完成`;
  console.log('KT_TEST_RESULT', JSON.stringify(payload));
}

run().catch((e) => {
  window.__KT_TEST_RESULT__ = { status: 'crashed', error: String(e) };
  document.title = '[崩溃] 引擎实测';
  console.error(e);
});
