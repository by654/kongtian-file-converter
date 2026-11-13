/* 首页流程自测：在同源 iframe 内真实点击「载入示例文件 → 全部转换」，检查队列结果 */
const logEl = document.getElementById('log');
const lines = [];
function log(s) {
  lines.push(s);
  logEl.textContent = lines.join('\n');
  console.log(s);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn, timeout, label) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error('等待超时：' + label);
}

async function main() {
  const frame = document.getElementById('app');
  await new Promise((resolve, reject) => {
    frame.onload = resolve;
    frame.onerror = () => reject(new Error('首页加载失败'));
    setTimeout(() => reject(new Error('首页加载超时')), 30000);
  });
  const doc = frame.contentDocument;
  log('首页已加载：' + doc.title);

  const samples = doc.querySelector('#btn-samples');
  if (!samples) throw new Error('找不到「载入示例文件」按钮');
  samples.click();
  log('已点击「载入示例文件」');

  await waitFor(() => doc.querySelectorAll('.job').length >= 5, 60000, '示例文件入队');
  const jobs = doc.querySelectorAll('.job');
  log(`队列文件数：${jobs.length}`);
  for (const j of jobs) {
    const name = j.querySelector('.file-name, .job-name, .name');
    const pill = j.querySelector('.pill');
    log(`  ${name ? name.textContent.trim().slice(0, 24) : '(文件)'} · ${pill ? pill.textContent : '?'}`);
  }

  const all = doc.querySelector('#btn-convert-all');
  if (!all) throw new Error('找不到「全部转换」按钮');
  if (all.disabled) throw new Error('「全部转换」按钮不可用');
  all.click();
  log('已点击「全部转换」');
  await sleep(900);

  const stateTotal = doc.querySelectorAll('.job').length;
  await waitFor(() => {
    const running = doc.querySelectorAll('.job .pill.run').length;
    const finished = doc.querySelectorAll('.job .pill.ok').length + doc.querySelectorAll('.job-error').length;
    return !running && finished >= stateTotal;
  }, 480000, '批量转换结束');
  await sleep(600);

  const total = doc.querySelectorAll('.job').length;
  const done = Array.from(doc.querySelectorAll('.job .pill.ok')).length;
  const errors = Array.from(doc.querySelectorAll('.job-error')).map((e) => e.textContent.trim());
  const errToasts = Array.from(doc.querySelectorAll('.toast.err')).map((t) => t.textContent.trim());
  const stats = doc.querySelector('#queue-stats')?.textContent.trim() || '';

  for (const j of doc.querySelectorAll('.job')) {
    const name = j.querySelector('.file-name, .job-name, .name');
    const pill = j.querySelector('.pill');
    const out = Array.from(j.querySelectorAll('.job-outputs .out-name, .job-outputs a, .job-outputs li')).map((o) => o.textContent.trim()).join(',');
    log(`结果 ${name ? name.textContent.trim().slice(0, 24) : '(文件)'} · ${pill ? pill.textContent : '?'}${out ? ' → ' + out.slice(0, 60) : ''}`);
  }

  const result = { status: 'done', total, done, errors, errToasts, stats };
  window.__KT_UI_RESULT__ = result;
  document.title = `[UI完成 队列${total}/完成${done}/失败${errors.length}] 界面自测`;
  log(`汇总：队列 ${total} · 完成 ${done} · 失败 ${errors.length} · ${stats}`);
  fetch('/__ui-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...result, lines }),
  }).catch(() => {});
}

main().catch((e) => {
  window.__KT_UI_RESULT__ = { status: 'crashed', error: String(e && (e.message || e)), lines };
  document.title = '[UI崩溃] 界面自测';
  log('CRASH ' + (e && (e.message || e)));
  fetch('/__ui-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'crashed', error: String(e && (e.message || e)), lines }),
  }).catch(() => {});
});
