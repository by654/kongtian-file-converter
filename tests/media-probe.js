import { runFFmpeg } from '../js/engine/ffmpeg.js';
import { convertMedia } from '../js/engine/media.js';
import { convertImage } from '../js/engine/image.js';

const out = document.getElementById('log');
const results = [];
const say = (m) => { out.textContent += '\n' + m; console.log(m); };
const started = performance.now();

async function test(label, fn) {
  const t = performance.now();
  try {
    const res = await fn();
    const first = Array.isArray(res) ? res[0] : res;
    const size = first && first.blob ? first.blob.size : first && first.size || 0;
    results.push({ label, ok: true, size, ms: Math.round(performance.now() - t) });
    say(`✅ ${label} ${size}B ${Math.round(performance.now() - t)}ms`);
  } catch (e) {
    results.push({ label, ok: false, error: String(e && e.message || e).slice(0, 260), ms: Math.round(performance.now() - t) });
    say(`❌ ${label} ${String(e && e.message || e).slice(0, 220)}`);
  }
}

async function main() {
  say('生成测试视频…');
  const data = await runFFmpeg({
    args: ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'sample.mp4'],
    outputName: 'sample.mp4',
  });
  const videoFile = new File([data], 'sample.mp4', { type: 'video/mp4' });
  say('视频 ' + data.length + 'B');

  const base = { resolution: 'auto', fps: 'auto', videoQuality: 'low', audioBitrate: '96', videoEncoder: 'auto', pixelFormat: 'auto', metadata: 'keep', wavDepth: '16', bitrate: '192', mp3Vbr: 'off', sampleRate: 'auto', channels: 'auto' };

  await test('video→mp3 (fresh)', () => convertMedia({ file: videoFile, category: 'video', target: 'mp3', ext: 'mp4', params: base }, {}));
  await test('video→mp3 (again)', () => convertMedia({ file: videoFile, category: 'video', target: 'mp3', ext: 'mp4', params: base }, {}));
  await test('video→mpg qscale', () => convertMedia({ file: videoFile, category: 'video', target: 'mpg', ext: 'mp4', params: base }, {}));

  const variants = [
    ['mpeg1 bitrate', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=0.6', '-c:v', 'mpeg1video', '-b:v', '1200k', '-pix_fmt', 'yuv420p', '-an', '-f', 'mpeg', 'v1.mpg']],
    ['mpeg1 qscale', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=0.6', '-c:v', 'mpeg1video', '-q:v', '5', '-pix_fmt', 'yuv420p', '-an', '-f', 'mpeg', 'v2.mpg']],
    ['mpeg1 320x240', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=0.6', '-c:v', 'mpeg1video', '-b:v', '1200k', '-pix_fmt', 'yuv420p', '-an', '-f', 'mpeg', 'v3.mpg']],
    ['mpeg1 with mp2', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:v', 'mpeg1video', '-b:v', '1200k', '-pix_fmt', 'yuv420p', '-c:a', 'mp2', '-b:a', '192k', '-shortest', '-f', 'mpeg', 'v4.mpg']],
    ['mpeg2', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=0.6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:v', 'mpeg2video', '-b:v', '1500k', '-pix_fmt', 'yuv420p', '-c:a', 'mp2', '-b:a', '192k', '-shortest', '-f', 'mpeg', 'v5.mpg']],
  ];
  for (const [label, args] of variants) {
    await test(label, async () => {
      const d = await runFFmpeg({ args, outputName: args[args.length - 1] });
      return { size: d.length };
    });
  }

  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a6df4'; ctx.fillRect(0, 0, 64, 64);
  const pngBlob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const pngFile = new File([pngBlob], 'sample.png', { type: 'image/png' });
  for (const target of ['jpg', 'png', 'webp', 'avif', 'bmp', 'tiff', 'svg', 'ico', 'pdf']) {
    await test('image→' + target, () => convertImage(pngFile, target, { quality: '80', width: '0', height: '0', background: '#ffffff', pdfPage: 'original', compressStrategy: 'quality', targetKB: '300' }, {}));
  }
  await test('image→jpg target 20KB', () => convertImage(pngFile, 'jpg', { quality: '90', width: '0', height: '0', background: '#ffffff', compressStrategy: 'size', targetKB: '20' }, {}));

  const summary = { ok: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, totalMs: Math.round(performance.now() - started), results };
  say(`\n完成：${summary.ok} 通过 / ${summary.fail} 失败`);
  document.title = 'DONE ' + summary.ok + '/' + (summary.ok + summary.fail);
  try { await fetch('/__media-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) }); } catch (_) {}
}

main().catch((e) => { say('崩溃：' + (e && (e.stack || e.message || e))); document.title = 'ERROR'; });
