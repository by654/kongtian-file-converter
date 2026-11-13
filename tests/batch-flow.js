/* 批量流程自测：验证总进度、暂停 / 继续 / 停止、批量设置与预设 */
const logEl = document.getElementById('log');
const lines = [];
const checks = [];
function log(s) {
  lines.push(s);
  logEl.textContent = lines.join('\n');
  console.log(s);
}
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn, timeout, label) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(150);
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

  doc.querySelector('#btn-samples').click();
  await waitFor(() => doc.querySelectorAll('.job').length >= 5, 90000, '示例文件入队');
  log(`队列文件数：${doc.querySelectorAll('.job').length}`);

  /* 1. 批量设置：按类别应用目标格式 */
  doc.querySelector('#btn-batch-settings').click();
  await waitFor(() => doc.querySelector('#batch-dialog').hasAttribute('open'), 3000, '批量设置打开');
  const tabs = doc.querySelectorAll('#batch-tabs .cat-tab');
  check('批量设置按类别分组', tabs.length === 8, `${tabs.length} 个类别`);
  doc.querySelector('#batch-tabs .cat-tab[data-bcat="image"]').click();
  await sleep(100);
  const batchTarget = doc.querySelector('#batch-target');
  batchTarget.value = 'webp';
  batchTarget.dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
  await sleep(100);
  doc.querySelector('#btn-batch-apply').click();
  await sleep(150);
  const imageTargets = Array.from(doc.querySelectorAll('.job')).filter((j) => j.textContent.includes('图片'));
  const applied = Array.from(doc.querySelectorAll('.job select[data-role="target"]')).filter((s) => s.value === 'webp').length;
  check('批量设置应用到同类文件', applied >= 2, `${applied} 个文件目标为 webp`);
  log('图片类别文件：' + imageTargets.length);

  /* 2. 预设保存与载入 */
  doc.querySelector('#preset-name').value = '批量自测预设';
  doc.querySelector('#btn-preset-save').click();
  await sleep(120);
  const presetRows = Array.from(doc.querySelectorAll('.preset-item .preset-name')).map((n) => n.textContent);
  check('预设保存后出现在列表', presetRows.includes('批量自测预设'), presetRows.join('、'));
  const loadBtn = doc.querySelector('.preset-item [data-preset-load]');
  if (loadBtn) {
    loadBtn.click();
    await sleep(120);
    check('预设可载入', doc.querySelector('#batch-count').textContent.includes('队列中'), doc.querySelector('#batch-count').textContent.trim());
  }
  doc.querySelector('#batch-dialog').close();

  /* 3. 暂停 / 继续 / 停止 */
  doc.querySelector('#btn-convert-all').click();
  await sleep(60);
  const pauseBtn = doc.querySelector('#btn-pause');
  check('开始后出现暂停按钮', pauseBtn && !pauseBtn.classList.contains('hidden'));
  pauseBtn.click();
  await sleep(120);
  const progressText = doc.querySelector('#batch-progress-text').textContent;
  check('暂停后按钮变为继续', pauseBtn.textContent === '继续', pauseBtn.textContent);
  check('暂停后总进度显示已暂停', progressText.includes('已暂停'), progressText.trim());
  check('暂停时总进度条可见', !doc.querySelector('#batch-progress').classList.contains('hidden'));

  pauseBtn.click();
  await sleep(120);
  check('继续后按钮恢复为暂停', pauseBtn.textContent === '暂停', pauseBtn.textContent);

  doc.querySelector('#btn-stop').click();
  await waitFor(() => !doc.querySelector('.job .pill.run'), 30000, '停止批量');
  await sleep(300);
  check('停止后无转换中任务', !doc.querySelector('.job .pill.run'));
  check('停止后暂停与停止按钮隐藏', doc.querySelector('#btn-pause').classList.contains('hidden') && doc.querySelector('#btn-stop').classList.contains('hidden'));

  const failed = doc.querySelectorAll('.job .pill.err').length;
  const failedRetryVisible = !doc.querySelector('#btn-retry-failed').classList.contains('hidden');
  check('失败项重试按钮状态一致', failed === 0 ? !failedRetryVisible : failedRetryVisible, `失败 ${failed} 个`);

  /* 4. 窄屏（390 px）布局 */
  const mobile = document.createElement('iframe');
  mobile.style.cssText = 'width:390px;height:844px;border:0;display:block';
  mobile.src = '/';
  document.body.appendChild(mobile);
  await new Promise((resolve, reject) => {
    mobile.onload = resolve;
    mobile.onerror = () => reject(new Error('窄屏首页加载失败'));
    setTimeout(() => reject(new Error('窄屏首页加载超时')), 30000);
  });
  const mdoc = mobile.contentDocument;
  const overflow = mdoc.documentElement.scrollWidth - mdoc.documentElement.clientWidth;
  check('窄屏无横向溢出', overflow <= 1, `溢出 ${overflow}px`);

  mdoc.querySelector('#btn-samples').click();
  await waitFor(() => mdoc.querySelectorAll('.job').length >= 5, 90000, '窄屏示例入队');
  const batchBtnRect = mdoc.querySelector('#btn-batch-settings').getBoundingClientRect();
  check('窄屏批量设置按钮在可视区', batchBtnRect.width > 0 && batchBtnRect.right <= 391,
    `${Math.round(batchBtnRect.width)}×${Math.round(batchBtnRect.height)}`);

  mdoc.querySelector('#btn-images-pdf').click();
  await sleep(250);
  const mobileDlg = mdoc.querySelector('#imgpdf-dialog');
  const dlgRect = mobileDlg.getBoundingClientRect();
  check('窄屏图片合成对话框宽度适配', dlgRect.width > 0 && dlgRect.width <= 392 && dlgRect.left >= -1,
    `${Math.round(dlgRect.width)}px`);
  const orderBtn = mdoc.querySelector('#imgpdf-list [data-ipdown]');
  const orderRect = orderBtn.getBoundingClientRect();
  check('窄屏排序按钮可点击尺寸', orderRect.width >= 36 && orderRect.height >= 32,
    `${Math.round(orderRect.width)}×${Math.round(orderRect.height)}`);
  mobileDlg.close();
}

main()
  .then(() => {
    const okCount = checks.filter((c) => c.ok).length;
    const failed = checks.filter((c) => !c.ok);
    document.title = `DONE ${okCount}/${checks.length} 批量流程`;
    log(`汇总：${okCount}/${checks.length} 通过`);
    fetch('/__batch-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: failed.length ? 'failed' : 'done', checks, lines }),
    }).catch(() => {});
  })
  .catch((e) => {
    document.title = 'CRASH 批量流程';
    log('CRASH ' + (e && (e.message || e)));
    fetch('/__batch-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'crashed', error: String(e && (e.message || e)), checks, lines }),
    }).catch(() => {});
  });
