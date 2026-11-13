import { runFFmpeg, runFFmpegInfo } from '../js/engine/ffmpeg.js';
import { convertMedia } from '../js/engine/media.js';
import { convertImage } from '../js/engine/image.js';
import { convertDocument } from '../js/engine/documents.js';
import { convertSubtitle } from '../js/engine/subtitle.js';
import { convertSheet } from '../js/engine/sheets.js';
import { imagesToPdf, rotatePdf, compressPdf } from '../js/engine/pdf.js';
import { loadVendor, makeZip } from '../js/engine/utils.js';

const out = document.getElementById('log');
const results = [];
const started = performance.now();
function say(msg) {
  out.textContent += '\n' + msg;
  console.log(msg);
}

function makeWav() {
  const rate = 8000;
  const n = rate * 0.5;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000);
    dv.setInt16(44 + i * 2, v, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function canvasFile(w = 64, h = 64, type = 'image/png') {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a6df4'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffd166'; ctx.fillRect(8, 8, w / 2, h / 2);
  const blob = await new Promise((r) => c.toBlob(r, type, 0.9));
  return new File([blob], 'sample.' + type.split('/')[1], { type });
}

async function test(label, fn) {
  const t = performance.now();
  try {
    const res = await fn();
    const first = Array.isArray(res) ? res[0] : res;
    const size = first && (first.blob ? first.blob.size : first.size) || 0;
    results.push({ label, ok: true, size, ms: Math.round(performance.now() - t) });
    say(`✅ ${label}  ${Math.round(performance.now() - t)}ms  ${size}B`);
  } catch (e) {
    const msg = (e && (e.message || String(e))) || 'unknown';
    results.push({ label, ok: false, error: msg.slice(0, 220), ms: Math.round(performance.now() - t) });
    say(`❌ ${label}  ${msg.slice(0, 180)}`);
  }
}

async function main() {
  say('读取编码器列表…');
  let encoders = '';
  try {
    const logs = await runFFmpegInfo(['-hide_banner', '-encoders']);
    encoders = logs.join('\n');
  } catch (e) { say('编码器列表读取失败：' + e.message); }
  const wanted = ['libmp3lame', 'aac', 'flac', 'libvorbis', 'libx264', 'mpeg4', 'libvpx', 'mpeg1video', 'mpeg2video', 'wmv2', 'wmav2', 'mp2', 'ac3', 'pcm_s16le', 'pcm_s24le', 'pcm_s16be', 'pcm_s24be', 'pcm_f32le'];
  const enc = {};
  for (const w of wanted) enc[w] = new RegExp('(^|\\s)' + w + '(\\s|$)', 'm').test(encoders);
  say('编码器：' + JSON.stringify(enc));

  const wav = new File([makeWav()], 'sample.wav', { type: 'audio/wav' });
  say('生成测试视频…');
  let videoFile = null;
  try {
    const data = await runFFmpeg({
      args: ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=0.5',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'sample.mp4'],
      outputName: 'sample.mp4',
    });
    videoFile = new File([data], 'sample.mp4', { type: 'video/mp4' });
    say('测试视频生成成功 ' + data.length + 'B');
  } catch (e) { say('测试视频生成失败：' + e.message); }

  const audioTargets = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'aiff', 'ac3', 'wma', 'mp2'];
  for (const target of audioTargets) {
    await test('audio→' + target, () => convertMedia({
      file: wav, category: 'audio', target, ext: 'wav',
      params: { bitrate: '192', sampleRate: '44100', channels: 'stereo', wavDepth: '16', mp3Vbr: 'off', vorbisQuality: '5', metadata: 'keep' },
    }, {}));
  }

  if (videoFile) {
    const videoTargets = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'ts', 'flv', 'wmv', '3gp', 'mpg', 'gif', 'mp3', 'wav', 'm4a', 'flac', 'aiff'];
    for (const target of videoTargets) {
      await test('video→' + target, () => convertMedia({
        file: videoFile, category: 'video', target, ext: 'mp4',
        params: { resolution: 'auto', fps: 'auto', videoQuality: 'low', audioBitrate: '96', videoEncoder: 'auto', pixelFormat: 'auto', metadata: 'keep', wavDepth: '16', bitrate: '192', mp3Vbr: 'off' },
      }, {}));
    }
  } else {
    results.push({ label: 'video sample', ok: false, error: '无法生成测试视频' });
  }

  const png = await canvasFile();
  for (const target of ['jpg', 'png', 'webp', 'avif', 'bmp', 'tiff', 'svg', 'ico', 'pdf']) {
    await test('image→' + target, () => convertImage(png, target, { quality: '80', width: '0', height: '0', background: '#ffffff', pdfPage: 'original', compressStrategy: 'quality', targetKB: '300' }, {}));
  }

  const md = new File(['# 标题\n\n第一段。\n\n## 二级\n\n第二段。\n'], 'sample.md', { type: 'text/markdown' });
  for (const target of ['txt', 'html', 'docx', 'rtf', 'epub', 'odt']) {
    await test('doc md→' + target, () => convertDocument(md, target, {}, {}));
  }
  for (const inputExt of ['epub', 'odt', 'docx']) {
    let blob = null;
    try {
      const r = await convertDocument(md, inputExt, {}, {});
      blob = r[0].blob;
    } catch (e) { say('生成 ' + inputExt + ' 失败：' + e.message); }
    if (blob) {
      const f = new File([blob], 'sample.' + inputExt, { type: 'application/octet-stream' });
      await test(inputExt + '→txt', () => convertDocument(f, 'txt', {}, {}));
      await test(inputExt + '→md', () => convertDocument(f, 'md', {}, {}));
      await test(inputExt + '→html', () => convertDocument(f, 'html', {}, {}));
      await test(inputExt + '→docx', () => convertDocument(f, 'docx', {}, {}));
    }
  }

  const srt = new File(['1\n00:00:01,000 --> 00:00:03,000\n第一行\n第二行\n\n2\n00:00:04,000 --> 00:00:06,000\n第二条\n'], 'sample.srt', { type: 'application/x-subrip' });
  for (const target of ['srt', 'vtt', 'ass', 'txt']) {
    await test('subtitle→' + target, () => convertSubtitle(srt, target, { subtitleEncoding: 'utf-8' }, {}));
  }
  const vtt = new File(['WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c>第一行</c>\n\n00:00:04.000 --> 00:00:06.000\n第二条\n'], 'sample.vtt', { type: 'text/vtt' });
  await test('vtt→srt', () => convertSubtitle(vtt, 'srt', { subtitleEncoding: 'utf-8' }, {}));
  const ass = new File(['[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\b1}第一行\\N第二行\n'], 'sample.ass', { type: 'text/x-ssa' });
  await test('ass→srt', () => convertSubtitle(ass, 'srt', { subtitleEncoding: 'utf-8' }, {}));

  const csv = new File(['姓名;年龄\n张三;18\n李四;20\n'], 'sample.csv', { type: 'text/csv' });
  for (const target of ['xlsx', 'csv', 'tsv', 'json', 'html']) {
    await test('sheet csv→' + target, () => convertSheet(csv, target, { csvInputDelimiter: 'auto', csvDelimiter: 'auto', csvEncoding: 'utf-8' }, {}));
  }

  try {
    await loadVendor('jszip/jszip.min.js');
    const zip = new window.JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
    zip.file('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
    zip.file('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell office:value-type="string"><text:p>姓名</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>年龄</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell office:value-type="string"><text:p>张三</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="18"><text:p>18</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>');
    const odsBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.oasis.opendocument.spreadsheet' });
    const ods = new File([odsBlob], 'sample.ods', { type: 'application/vnd.oasis.opendocument.spreadsheet' });
    await test('sheet ods→csv', () => convertSheet(ods, 'csv', { csvInputDelimiter: 'auto', csvDelimiter: 'auto' }, {}));
  } catch (e) { results.push({ label: 'ods sample', ok: false, error: e.message }); }

  let pdfFile = null;
  try {
    const r = await imagesToPdf([png], { pdfPage: 'original' }, {});
    pdfFile = new File([r[0].blob], 'sample.pdf', { type: 'application/pdf' });
    say('PDF 样例生成成功 ' + r[0].blob.size + 'B');
  } catch (e) { say('PDF 样例生成失败：' + e.message); }
  if (pdfFile) {
    for (const target of ['txt', 'png', 'jpg', 'webp', 'split']) {
      await test('pdf→' + target, async () => {
        const { pdfToText, pdfToImages, splitPdf } = await import('../js/engine/pdf.js');
        if (target === 'txt') return pdfToText(pdfFile, { range: '' }, {});
        if (target === 'split') return splitPdf(pdfFile, { range: '' }, {});
        return pdfToImages(pdfFile, target, { range: '', dpi: '96', quality: '80' }, {});
      });
    }
    await test('pdf rotate', () => rotatePdf(pdfFile, { range: '', rotate: '90' }, {}));
    await test('pdf compress', () => compressPdf(pdfFile, { range: '', dpi: '96', quality: '70' }, {}));
  }

  const zipEntries = [{ name: 'a.txt', blob: new Blob(['hello']) }, { name: 'dir/b.txt', blob: new Blob(['world']) }];
  for (const level of ['0', '9']) {
    await test('zip level ' + level, () => makeZip(zipEntries, { level: Number(level), keepPaths: true }));
  }
  await test('zip repack', async () => {
    const { repackZip } = await import('../js/engine/archive.js');
    const z = await makeZip(zipEntries, { level: 6, keepPaths: true });
    return repackZip(new File([z], 'sample.zip', { type: 'application/zip' }), { zipLevel: '9' }, {});
  });

  const summary = {
    ok: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok).length,
    totalMs: Math.round(performance.now() - started),
    encoders: enc,
    results,
  };
  say(`\n完成：${summary.ok} 通过 / ${summary.fail} 失败，用时 ${summary.totalMs}ms`);
  document.title = 'DONE ' + summary.ok + '/' + (summary.ok + summary.fail);
  try {
    await fetch('/__codec-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
  } catch (_) {}
}

main().catch((e) => {
  say('探测脚本崩溃：' + (e && (e.stack || e.message || e)));
  document.title = 'ERROR';
});
