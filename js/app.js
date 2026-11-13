/* 空天文件转换 · 界面与任务调度 */
import {
  AVIF_ENCODE_SUPPORTED, CAPABILITY_NOTES, CATEGORIES, CATEGORY_MAP, categoryFromExt,
  defaultParamsFor, defaultTarget, limitMB, paramDescriptors, targetOf, targetsOf,
} from './engine/registry.js';
import { runJob, mergePdfs } from './engine/dispatch.js';
import { isFFmpegLoaded, terminateFFmpeg } from './engine/ffmpeg.js';
import { ensurePdfLib, imagesToPdf } from './engine/pdf.js';
import {
  applyPagePlan, comparePdfs, openPdfForPreview, pdfInfo, renderThumb,
} from './engine/pdf-tools.js';
import { base64Decode, base64Encode, encodingConvert, hashFile, jsonFormat } from './engine/tools.js';
import {
  baseName, downloadBlob, escapeHtml, extOf, fmtSize, makeZip, readText, uid, zipStamp,
} from './engine/utils.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const LS = {
  theme: 'kt-theme',
  defaults: 'kt-defaults',
  history: 'kt-history',
  presets: 'kt-presets',
};

const state = {
  jobs: [],
  defaults: {},
  settingsCat: 'audio',
  theme: 'auto',
  history: [],
  extra: [],
  running: false,
  cancelAll: false,
  paused: false,
  batchTotal: 0,
  batchIndex: 0,
  batchDone: 0,
  batchFailed: 0,
  historyBlobs: new Map(),
  overlayMode: null,
  retryFn: null,
  presets: [],
  batch: { cat: null, target: '', params: {} },
  imgPdf: { ids: [], selected: new Set() },
  pdfTool: { jobId: null, file: null, pdf: null, items: [], selected: new Set(), loading: false },
};

const DEFAULT_TARGETS = {
  audio: 'mp3', video: 'mp4', image: 'jpg', document: 'md', subtitle: 'srt', pdf: 'txt', sheet: 'csv', archive: 'extract',
};

const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none" opacity=".55"/></svg>',
  light: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
};

const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };

/* ---------- 通用 ---------- */
function toast(message, type = 'info', ms = 3200) {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

/* ---------- 主题 ---------- */
function mediaDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme() {
  const resolved = state.theme === 'auto' ? (mediaDark() ? 'dark' : 'light') : state.theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = state.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === 'dark' ? '#070b14' : '#eef3fa';
  $('#theme-icon').innerHTML = THEME_ICONS[state.theme];
  $('#theme-label').textContent = THEME_LABEL[state.theme];
  $('#theme-toggle').setAttribute('title', '主题：' + THEME_LABEL[state.theme] + '（点击切换）');
}

function initTheme() {
  const saved = localStorage.getItem(LS.theme);
  state.theme = ['auto', 'light', 'dark'].includes(saved) ? saved : 'auto';
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'auto') applyTheme();
    });
  }
  $('#theme-toggle').addEventListener('click', () => {
    const next = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme];
    state.theme = next;
    localStorage.setItem(LS.theme, next);
    applyTheme();
  });
}

/* ---------- 默认设置 ---------- */
function initDefaults() {
  const saved = loadJSON(LS.defaults, {}) || {};
  for (const cat of CATEGORIES) {
    const entry = saved[cat.id] || {};
    let target = entry.target;
    const savedTarget = target ? targetOf(cat.id, target) : null;
    if (!target || !savedTarget || savedTarget.disabled) target = DEFAULT_TARGETS[cat.id] || cat.targets.find((t) => !t.disabled).id;
    const params = { ...defaultParamsFor(cat.id, target, '') };
    if (entry.params && typeof entry.params === 'object') {
      for (const k of Object.keys(params)) {
        if (entry.params[k] !== undefined) params[k] = entry.params[k];
      }
    }
    const byTarget = { ...(entry.byTarget && typeof entry.byTarget === 'object' ? entry.byTarget : {}) };
    if (byTarget[target]) {
      for (const k of Object.keys(params)) {
        if (byTarget[target][k] !== undefined) params[k] = byTarget[target][k];
      }
    }
    byTarget[target] = { ...params };
    state.defaults[cat.id] = { target, params, byTarget };
  }
}

/* ---------- 参数预设 ---------- */
function initPresets() {
  const saved = loadJSON(LS.presets, []);
  if (!Array.isArray(saved)) return;
  state.presets = saved
    .filter((p) => {
      const t = p && p.name && CATEGORY_MAP[p.cat] && targetOf(p.cat, p.target);
      return t && !t.disabled;
    })
    .map((p) => ({
      id: p.id || uid(),
      name: String(p.name).slice(0, 28),
      cat: p.cat,
      target: p.target,
      params: p.params && typeof p.params === 'object' ? p.params : {},
    }));
}

function savePresets() {
  saveJSON(LS.presets, state.presets);
}

function paramsForBatch(cat, target, params) {
  const base = defaultParamsFor(cat, target, '');
  const allowed = new Set(paramDescriptors(cat, target, '').map((d) => d.id));
  for (const k of Object.keys(base)) {
    if (allowed.has(k) && params && params[k] !== undefined) base[k] = params[k];
  }
  return base;
}

function settingsTargetOptions(catId, selected) {
  const cat = CATEGORY_MAP[catId];
  const groups = new Map();
  for (const t of cat.targets) {
    if (t.disabled) continue;
    const g = t.group || '输出格式';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  let html = '';
  for (const [group, list] of groups) {
    html += `<optgroup label="${escapeHtml(group)}">`;
    for (const t of list) {
      html += `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${escapeHtml(t.label)}${t.partial ? '（部分）' : ''}</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}

function paramInputHtml(d, value, attrName) {
  const id = escapeHtml(d.id);
  const val = value !== undefined && value !== null ? String(value) : String(d.default ?? '');
  let control;
  if (d.type === 'select') {
    const options = d.options.map(([v, t]) => `<option value="${escapeHtml(v)}"${v === val ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
    control = `<select ${attrName}="${id}">${options}</select>`;
  } else if (d.type === 'range') {
    control = `<span class="field-top">${escapeHtml(d.label)} <b class="range-val">${val}%</b></span><input type="range" ${attrName}="${id}" min="${d.min}" max="${d.max}" step="${d.step}" value="${val}">`;
  } else if (d.type === 'color') {
    control = `<span>${escapeHtml(d.label)}</span><input type="color" ${attrName}="${id}" value="${val}">`;
  } else if (d.type === 'number') {
    control = `<span>${escapeHtml(d.label)}</span><input type="number" ${attrName}="${id}" min="${d.min ?? 0}" max="${d.max ?? 12000}" value="${val}" placeholder="${escapeHtml(d.placeholder || '')}">`;
  } else {
    control = `<span>${escapeHtml(d.label)}</span><input type="text" ${attrName}="${id}" value="${escapeHtml(val)}" placeholder="${escapeHtml(d.placeholder || '')}">`;
  }
  const cls = d.type === 'color' ? 'field field-color' : d.type === 'range' ? 'field field-range' : 'field';
  return `<label class="${cls}">${control}${d.help ? `<small class="field-help">${escapeHtml(d.help)}</small>` : ''}</label>`;
}

function renderParamsHtml(descriptors, values, attrName) {
  if (!descriptors.length) return '<p class="hint">该输出格式无需额外参数。</p>';
  return '<div class="param-grid">' + descriptors.map((d) => paramInputHtml(d, values[d.id], attrName)).join('') + '</div>';
}

function renderSettings() {
  const tabs = $('#settings-tabs');
  tabs.innerHTML = CATEGORIES.map((c) => `<button class="cat-tab${c.id === state.settingsCat ? ' active' : ''}" data-cat="${c.id}" role="tab">
    <span class="cat-dot" style="background:${c.color}"></span>${c.label}</button>`).join('');

  const cat = CATEGORY_MAP[state.settingsCat];
  const def = state.defaults[cat.id];
  const target = targetOf(cat.id, def.target);
  const descriptors = paramDescriptors(cat.id, def.target, '');
  $('#settings-body').innerHTML = `
    <p class="hint">${escapeHtml(cat.hint || '')}</p>
    <label class="field"><span>默认输出格式</span><select id="settings-target">${settingsTargetOptions(cat.id, def.target)}</select></label>
    ${renderParamsHtml(descriptors, def.params, 'data-sparam')}
    <div class="settings-actions">
      <button class="btn btn-ghost btn-sm" id="btn-reset-settings">恢复默认参数</button>
      <span class="hint small">参数会自动记住，下次打开仍然生效。</span>
    </div>
    <p class="hint small">新加入的「${cat.label}」文件将套用以上设置；单个文件仍可单独修改。</p>`;

  $('#btn-reset-settings').addEventListener('click', () => {
    def.params = defaultParamsFor(cat.id, def.target, '');
    def.byTarget = def.byTarget || {};
    def.byTarget[def.target] = { ...def.params };
    saveJSON(LS.defaults, state.defaults);
    renderSettings();
    toast(`已恢复${cat.label}默认参数`, 'ok');
  });

  $('#settings-target').addEventListener('change', (e) => {
    const next = e.target.value;
    def.byTarget = def.byTarget || {};
    def.byTarget[def.target] = { ...def.params };
    def.target = next;
    def.params = { ...defaultParamsFor(cat.id, next, ''), ...(def.byTarget[next] || {}) };
    def.byTarget[next] = { ...def.params };
    saveJSON(LS.defaults, state.defaults);
    renderSettings();
  });

  // 使用属性赋值避免重复绑定（#settings-body 是常驻节点）
  $('#settings-body').oninput = (e) => {
    const input = e.target.closest('[data-sparam]');
    if (!input) return;
    def.params[input.dataset.sparam] = input.value;
    def.byTarget = def.byTarget || {};
    def.byTarget[def.target] = { ...def.params };
    if (input.type === 'range') {
      const out = input.closest('.field').querySelector('.range-val');
      if (out) out.textContent = input.value + '%';
    }
    saveJSON(LS.defaults, state.defaults);
  };

  tabs.querySelectorAll('.cat-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settingsCat = btn.dataset.cat;
      renderSettings();
    });
  });
}

/* ---------- 队列 ---------- */
function jobById(id) {
  return state.jobs.find((j) => j.id === id);
}

function defaultParamsForJob(catId, target, ext) {
  const base = defaultParamsFor(catId, target, ext);
  const saved = state.defaults[catId];
  if (!saved) return base;
  const allowed = new Set(paramDescriptors(catId, target, ext).map((d) => d.id));
  for (const k of Object.keys(base)) {
    if (allowed.has(k) && saved.params[k] !== undefined) base[k] = saved.params[k];
  }
  return base;
}

function addFiles(fileList) {
  const skipped = [];
  let added = 0;
  for (const file of Array.from(fileList)) {
    const ext = extOf(file.name);
    const catId = categoryFromExt(ext);
    if (!catId) {
      skipped.push(ext ? '.' + ext : file.name);
      continue;
    }
    const cat = CATEGORY_MAP[catId];
    let target = state.defaults[catId].target;
    const t = targetOf(catId, target);
    if (!target || !t || t.disabled) target = DEFAULT_TARGETS[catId] || cat.targets.find((x) => !x.disabled).id;
    if (target === ext) {
      const alt = defaultTarget(catId, ext);
      if (alt && targetOf(catId, alt)) target = alt;
    }
    const job = {
      id: uid(),
      file,
      ext,
      category: catId,
      target,
      params: defaultParamsForJob(catId, target, ext),
      status: 'idle',
      progress: 0,
      stage: '',
      error: null,
      outputs: null,
      expanded: false,
      cancelRequested: false,
    };
    state.jobs.push(job);
    added++;
  }
  renderQueue();
  renderToolbar();
  if (added) toast(`已加入 ${added} 个文件`, 'ok');
  if (skipped.length) {
    const uniq = Array.from(new Set(skipped)).slice(0, 6);
    toast('跳过不支持的格式：' + uniq.join('、') + (skipped.length > 6 ? ' …' : ''), 'warn', 4600);
  }
}

function statusPill(job) {
  const map = {
    idle: ['待转换', ''],
    running: ['转换中', 'run'],
    done: ['完成', 'ok'],
    error: ['失败', 'err'],
    canceled: ['已取消', 'warn'],
  };
  const [text, cls] = map[job.status] || map.idle;
  return `<span class="pill ${cls}">${text}</span>`;
}

function paramSummary(job) {
  const descs = paramDescriptors(job.category, job.target, job.ext);
  const items = [];
  for (const d of descs) {
    const v = job.params[d.id];
    if (v === undefined || v === '' || v === 'auto' || v === '0' || v === null) continue;
    let text = '';
    switch (d.id) {
      case 'bitrate': case 'audioBitrate': text = v + ' kbps'; break;
      case 'sampleRate': text = (Number(v) / 1000) + ' kHz'; break;
      case 'channels': text = v === 'mono' ? '单声道' : v === '6' ? '5.1 声道' : '立体声'; break;
      case 'wavDepth': text = v === '32f' ? '32 位浮点' : v + ' 位'; break;
      case 'mp3Vbr': text = 'VBR q' + v; break;
      case 'metadata': text = v === 'strip' ? '清除元数据' : '保留元数据'; break;
      case 'resolution': text = v + 'p'; break;
      case 'fps': text = v + ' fps'; break;
      case 'videoQuality': text = v === 'high' ? '高画质' : v === 'low' ? '小体积' : '均衡画质'; break;
      case 'videoEncoder': text = v === 'mpeg4' ? 'MPEG-4' : 'H.264'; break;
      case 'pixelFormat': text = v === 'yuv422p' ? 'YUV 4:2:2' : v === 'yuv444p' ? 'YUV 4:4:4' : 'YUV 4:2:0'; break;
      case 'quality': text = v + '% 质量'; break;
      case 'compressStrategy': text = v === 'size' ? '体积优先' : ''; break;
      case 'targetKB': text = job.params.compressStrategy === 'size' ? '≤ ' + v + ' KB' : ''; break;
      case 'width': text = v + 'px 宽'; break;
      case 'height': text = v + 'px 高'; break;
      case 'range': text = '页 ' + v; break;
      case 'extractMode': text = v === 'separate' ? '分组成多份' : '合并为一份'; break;
      case 'nupGrid': text = v + ' 合 1'; break;
      case 'nupMargin': text = '页边距 ' + v + ' pt'; break;
      case 'nupGap': text = '间距 ' + v + ' pt'; break;
      case 'pageSizeTarget': text = '纸张 ' + v.toUpperCase(); break;
      case 'pageSizeOrientation': text = v === 'portrait' ? '纵向' : v === 'landscape' ? '横向' : '跟随原页'; break;
      case 'cropTop': case 'cropRight': case 'cropBottom': case 'cropLeft':
        text = v !== '0' ? d.label.replace(' (pt)', '') + ' ' + v : '';
        break;
      case 'wmText': text = '水印「' + v + '」'; break;
      case 'wmSize': text = '字号 ' + v + ' pt'; break;
      case 'wmOpacity': text = '透明度 ' + v + '%'; break;
      case 'wmRotation': text = v + '°'; break;
      case 'wmMode': text = v === 'tile' ? '平铺水印' : '居中水印'; break;
      case 'pnPosition': text = '页码 ' + ({ 'bottom-center': '底部居中', 'bottom-left': '底部靠左', 'bottom-right': '底部靠右', 'top-center': '顶部居中', 'top-left': '顶部靠左', 'top-right': '顶部靠右' })[v]; break;
      case 'pnFormat': text = ({ n: '数字', 'n-total': '数字/总数', cn: '中文格式' })[v] || ''; break;
      case 'pnStart': text = '起始 ' + v; break;
      case 'pnSize': text = '字号 ' + v + ' pt'; break;
      case 'hfHeader': text = '页眉「' + v + '」'; break;
      case 'hfFooter': text = '页脚「' + v + '」'; break;
      case 'hfSize': text = '字号 ' + v + ' pt'; break;
      case 'batesPrefix': text = '编号前缀 ' + v; break;
      case 'batesStart': text = '起始 ' + v; break;
      case 'batesDigits': text = v + ' 位'; break;
      case 'batesSize': text = '字号 ' + v + ' pt'; break;
      case 'redactRects': text = v ? '遮盖区域 ' + String(v).slice(0, 18) + (String(v).length > 18 ? '…' : '') : ''; break;
      case 'metaTitle': text = '标题「' + v + '」'; break;
      case 'metaAuthor': text = '作者 ' + v; break;
      case 'metaSubject': text = '主题 ' + v; break;
      case 'metaKeywords': text = '关键词 ' + v; break;
      case 'metaCreator': text = '创建工具 ' + v; break;
      case 'textPdfSize': text = '字号 ' + v + ' pt'; break;
      case 'textPdfMargin': text = '页边距 ' + v + ' mm'; break;
      case 'dpi': text = v + ' DPI'; break;
      case 'rotate': text = '旋转 ' + v + '°'; break;
      case 'pdfPage': text = v === 'a4' ? 'A4 页面' : '贴合图片'; break;
      case 'pdfOrientation': text = v === 'portrait' ? '纵向' : v === 'landscape' ? '横向' : ''; break;
      case 'pdfMargin': text = '页边距 ' + v + ' pt'; break;
      case 'pdfPerPage': text = Number(v) > 1 ? '每页 ' + v + ' 张' : ''; break;
      case 'imageQuality': text = v === 'original' ? '' : '图片重编码 ' + v + '%'; break;
      case 'start': text = '起点 ' + v; break;
      case 'end': text = '终点 ' + v; break;
      case 'vorbisQuality': text = 'Vorbis Q' + v; break;
      case 'csvEncoding': case 'subtitleEncoding': text = '源编码 ' + v.toUpperCase(); break;
      case 'csvDelimiter': text = ({ ',': '逗号', '\t': '制表符', ';': '分号', '|': '竖线' })[v] || '自动分隔'; break;
      case 'csvInputDelimiter': text = ({ ',': '源逗号', '\t': '源制表符', ';': '源分号' })[v] || ''; break;
      case 'zipLevel': text = 'ZIP 级别 ' + v; break;
      default: text = v;
    }
    if (text) items.push(text);
  }
  return items.slice(0, 5).join(' · ') || '默认参数';
}

function jobParamsHtml(job) {
  const descs = paramDescriptors(job.category, job.target, job.ext);
  const head = `<div class="param-head"><span>转换参数</span>
    <button class="btn btn-ghost btn-xs" data-act="reset-params">恢复默认</button></div>`;
  return head + renderParamsHtml(descs, job.params, 'data-param');
}

function jobCardHtml(job) {
  const cat = CATEGORY_MAP[job.category];
  const same = job.ext === job.target;
  const targetLabel = targetOf(job.category, job.target)?.label || job.target;
  const pct = Math.round((job.progress || 0) * 100);
  const outputs = job.outputs || [];
  const outHtml = outputs.map((o, i) => `
    <div class="out-row">
      <span class="out-name" title="${escapeHtml(o.name)}">${escapeHtml(o.name)}</span>
      <span class="out-size">${fmtSize(o.size)}</span>
      <button class="btn btn-secondary btn-xs" data-act="download-one" data-index="${i}">下载</button>
    </div>`).join('');

  return `<article class="job ${job.status}" data-id="${job.id}">
  <div class="job-row">
    <span class="file-chip" style="--c:${cat.color}">${escapeHtml((job.ext || '?').toUpperCase().slice(0, 4))}</span>
    <div class="job-info">
      <div class="job-name" title="${escapeHtml(job.file.name)}">${escapeHtml(job.file.name)}</div>
      <div class="job-meta">${fmtSize(job.file.size)} · ${cat.label} · <span class="job-goal">→ ${escapeHtml(targetLabel)}</span> · <span class="job-summary">${escapeHtml(paramSummary(job))}</span></div>
    </div>
    <div class="job-target">
      <span class="arrow">→</span>
      <select data-role="target" aria-label="输出格式">${settingsTargetOptions(job.category, job.target)}</select>
      ${same ? '<span class="same-tag">同格式重编码</span>' : ''}
    </div>
    <div class="job-state">${statusPill(job)}${job.status === 'running' ? `<span class="job-pct">${job.progress == null ? '' : pct + '%'}</span>` : ''}</div>
    <div class="job-actions">
      <button class="btn btn-ghost btn-sm" data-act="toggle-params">参数</button>
      ${job.status === 'running'
        ? `<button class="btn btn-danger btn-sm" data-act="cancel">取消</button>`
        : `<button class="btn btn-primary btn-sm" data-act="convert"${state.running ? ' disabled' : ''}>${job.status === 'done' ? '再次转换' : '转换'}</button>`}
      ${job.status === 'done' ? `<button class="btn btn-secondary btn-sm" data-act="download">下载</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="remove" title="从队列移除">移除</button>
    </div>
  </div>
  ${job.status === 'running' ? `<div class="job-live">
    <div class="bar${job.progress == null ? ' indeterminate' : ''}"><div class="bar-fill" style="width:${job.progress == null ? 40 : pct}%"></div></div>
    <div class="live-meta"><span class="stage">${escapeHtml(job.stage || '处理中…')}</span><span class="pct">${job.progress == null ? '' : pct + '%'}</span></div>
  </div>` : ''}
  ${job.status === 'error' && job.error ? `<div class="job-error">${escapeHtml(job.error)}</div>` : ''}
  ${job.status === 'done' && outputs.length ? `<div class="job-outputs">${outHtml}
    ${outputs.length > 1 ? `<button class="btn btn-secondary btn-xs" data-act="download">打包下载 ${outputs.length} 个文件</button>` : ''}
  </div>` : ''}
  <div class="job-params${job.expanded ? '' : ' hidden'}">
    ${jobParamsHtml(job)}
  </div>
</article>`;
}

function renderQueue() {
  const queue = $('#queue');
  queue.innerHTML = state.jobs.map(jobCardHtml).join('');
  $('#queue-empty').classList.toggle('hidden', state.jobs.length > 0);
  renderStats();
}

function renderStats() {
  const total = state.jobs.length;
  const size = state.jobs.reduce((s, j) => s + j.file.size, 0);
  const done = state.jobs.filter((j) => j.status === 'done').length;
  const failed = state.jobs.filter((j) => j.status === 'error').length;
  let text = total ? `${total} 个文件 · ${fmtSize(size)}${done ? ` · 已完成 ${done}` : ''}${failed ? ` · 失败 ${failed}` : ''}` : '暂无文件';
  if (state.running) text = `${state.paused ? '已暂停' : '正在转换'} ${state.batchIndex}/${state.batchTotal} · ${text}`;
  $('#queue-stats').textContent = text;

  const imageCount = state.jobs.filter((j) => j.category === 'image').length;
  const pdfCount = state.jobs.filter((j) => j.category === 'pdf').length;
  $('#btn-images-pdf').classList.toggle('hidden', imageCount < 2);
  $('#btn-merge-pdf').classList.toggle('hidden', pdfCount < 2);
  $('#btn-pdf-workbench').classList.toggle('hidden', pdfCount < 1);
  refreshPdfWorkbench();
  $('#batch-tool-count').textContent = total ? (imageCount ? `共 ${total} 个文件 · 图片 ${imageCount} 个` : `共 ${total} 个文件`) : '';
}

function renderBatchProgress() {
  const box = $('#batch-progress');
  box.classList.toggle('hidden', !state.running);
  if (!state.running) return;
  const total = Math.max(1, state.batchTotal);
  const running = state.jobs.find((j) => j.status === 'running');
  const currentPct = running && running.progress != null ? running.progress : 0;
  const ratio = Math.min(1, (state.batchDone + state.batchFailed + currentPct) / total);
  const bar = box.querySelector('.bar');
  const fill = box.querySelector('.bar-fill');
  const indeterminate = !!(running && running.progress == null);
  bar.classList.toggle('indeterminate', indeterminate);
  if (!indeterminate) fill.style.width = Math.round(ratio * 100) + '%';
  $('#batch-progress-text').textContent =
    `${state.paused ? '已暂停 · ' : ''}第 ${Math.min(total, Math.max(1, state.batchIndex))}/${total} 个 · 完成 ${state.batchDone}${state.batchFailed ? ` · 失败 ${state.batchFailed}` : ''}`;
}

function renderToolbar() {
  const hasJobs = state.jobs.length > 0;
  const hasDone = state.jobs.some((j) => j.status === 'done');
  const failed = state.jobs.filter((j) => j.status === 'error').length;
  const pending = state.jobs.filter((j) => j.status === 'idle' || j.status === 'error' || j.status === 'canceled').length;
  $('#btn-convert-all').disabled = state.running || !pending;
  const pauseBtn = $('#btn-pause');
  pauseBtn.classList.toggle('hidden', !state.running);
  pauseBtn.textContent = state.paused ? '继续' : '暂停';
  $('#btn-stop').classList.toggle('hidden', !state.running);
  $('#btn-retry-failed').classList.toggle('hidden', state.running || !failed);
  $('#btn-retry-failed').disabled = state.running;
  $('#btn-download-all').disabled = (!hasDone && !state.extra.length) || state.running;
  $('#btn-clear').disabled = !hasJobs || state.running;
  renderStats();
  renderBatchProgress();
}

function refreshJob(job) {
  const el = document.querySelector(`.job[data-id="${job.id}"]`);
  if (!el) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = jobCardHtml(job);
  el.replaceWith(tmp.firstElementChild);
}

function updateLive(job) {
  const el = document.querySelector(`.job[data-id="${job.id}"]`);
  if (!el) return;
  const bar = el.querySelector('.bar');
  const fill = el.querySelector('.bar-fill');
  const pctEl = el.querySelector('.job-pct');
  const livePct = el.querySelector('.live-meta .pct');
  const stage = el.querySelector('.live-meta .stage');
  if (bar) bar.classList.toggle('indeterminate', job.progress == null);
  const pct = Math.round((job.progress || 0) * 100);
  if (fill) fill.style.width = job.progress == null ? '40%' : pct + '%';
  if (pctEl) pctEl.textContent = job.progress == null ? '' : pct + '%';
  if (livePct) livePct.textContent = job.progress == null ? '' : pct + '%';
  if (stage) stage.textContent = job.stage || '处理中…';
  if (state.running) renderBatchProgress();
}

/* ---------- 转换 ---------- */
function showOverlay({ title, detail, progress = null, mode = 'busy', retry = null, cancel = null, close = null }) {
  state.overlayMode = mode;
  state.retryFn = retry;
  $('#overlay').classList.remove('hidden');
  $('#ov-title').textContent = title;
  $('#ov-detail').textContent = detail || '';
  $('#ov-bar').style.width = progress == null ? '40%' : Math.round(progress * 100) + '%';
  $('#ov-bar').parentElement.classList.toggle('indeterminate', progress == null);
  const retryBtn = $('#ov-retry');
  retryBtn.classList.toggle('hidden', !retry);
  retryBtn.onclick = retry || null;
  const cancelBtn = $('#ov-cancel');
  cancelBtn.classList.toggle('hidden', !cancel);
  cancelBtn.onclick = cancel || null;
  const closeBtn = $('#ov-close');
  closeBtn.classList.toggle('hidden', !close);
  closeBtn.onclick = close || hideOverlay;
}

function updateOverlay({ detail, progress }) {
  if (detail !== undefined) $('#ov-detail').textContent = detail;
  if (progress !== undefined) {
    $('#ov-bar').style.width = progress == null ? '40%' : Math.round(progress * 100) + '%';
    $('#ov-bar').parentElement.classList.toggle('indeterminate', progress == null);
  }
}

function hideOverlay() {
  $('#overlay').classList.add('hidden');
  state.overlayMode = null;
  state.retryFn = null;
}

function hideEngineOverlay() {
  if (state.overlayMode === 'engine') hideOverlay();
}

function makeHooks(job) {
  return {
    isCancelled: () => job.cancelRequested || state.cancelAll,
    onStage: (text) => {
      hideEngineOverlay();
      job.stage = text;
      updateLive(job);
    },
    onProgress: (p) => {
      job.progress = p == null ? null : Math.max(0, Math.min(1, p));
      updateLive(job);
    },
    engineStage: (text) => {
      if (state.overlayMode === 'engine') updateOverlay({ detail: text });
      else showOverlay({ title: '正在加载音视频引擎', detail: text, progress: null, mode: 'engine', close: () => hideOverlay() });
    },
    engineProgress: (received, total) => {
      if (state.overlayMode !== 'engine') return;
      if (total) updateOverlay({ progress: received / total, detail: `下载单线程核心 ${fmtSize(received)} / ${fmtSize(total)}` });
      else updateOverlay({ progress: null, detail: '正在初始化核心（约 32 MB）…' });
    },
  };
}

function addHistory(job, outputs) {
  const hid = uid();
  const entry = {
    id: hid,
    name: job.file.name,
    category: job.category,
    target: job.target,
    targetLabel: targetOf(job.category, job.target)?.label || job.target,
    outputs: outputs.map((o) => ({ name: o.name, size: o.size })),
    time: Date.now(),
  };
  state.history.unshift(entry);
  state.historyBlobs.set(hid, outputs);
  while (state.history.length > 20) {
    const dropped = state.history.pop();
    state.historyBlobs.delete(dropped.id);
  }
  persistHistory();
  renderHistory();
}

function persistHistory() {
  saveJSON(LS.history, state.history);
}

/** 工具箱类结果：同时进入「最近生成」与历史 */
function pushExtra(title, outputs, targetLabel = 'PDF 工具') {
  const entry = {
    id: uid(),
    name: title,
    category: 'pdf',
    target: 'tool',
    targetLabel,
    outputs: outputs.map((o) => ({ name: o.name, size: o.size })),
    time: Date.now(),
  };
  state.history.unshift(entry);
  state.historyBlobs.set(entry.id, outputs);
  while (state.history.length > 20) {
    const dropped = state.history.pop();
    state.historyBlobs.delete(dropped.id);
  }
  state.extra.unshift({ id: entry.id, title, outputs, time: Date.now() });
  state.extra = state.extra.slice(0, 3);
  persistHistory();
  renderHistory();
  renderExtra();
  renderToolbar();
  return entry;
}

async function convertOne(job, internal = false) {
  if (!job) return;
  if (!internal) {
    if (state.running) { toast('已有转换任务正在进行', 'warn'); return; }
    state.running = true;
    state.cancelAll = false;
    state.batchTotal = 1;
    state.batchIndex = 0;
    renderToolbar();
  }
  job.status = 'running';
  job.progress = 0;
  job.stage = '准备中…';
  job.error = null;
  job.outputs = null;
  job.cancelRequested = false;
  refreshJob(job);
  renderStats();

  const hooks = makeHooks(job);
  try {
    state.batchIndex = state.batchIndex || 1;
    const outputs = await runJob(job, hooks);
    if (job.cancelRequested || state.cancelAll) {
      job.status = 'canceled';
      job.stage = '已取消';
    } else {
      job.status = 'done';
      job.progress = 1;
      job.stage = '';
      job.outputs = outputs;
      addHistory(job, outputs);
      toast(`${job.file.name} 转换完成`, 'ok');
    }
  } catch (e) {
    const canceled = job.cancelRequested || state.cancelAll || (e && e.name === 'AbortError');
    if (canceled) {
      job.status = 'canceled';
      job.stage = '已取消';
    } else {
      job.status = 'error';
      job.stage = '';
      job.error = (e && e.message) || String(e);
      console.error(e);
      if ((job.category === 'audio' || job.category === 'video') && !isFFmpegLoaded()) {
        showOverlay({
          title: '音视频引擎加载失败',
          detail: job.error,
          progress: null,
          mode: 'error',
          retry: () => { hideOverlay(); convertOne(job); },
          close: () => hideOverlay(),
        });
      } else {
        toast('转换失败：' + job.error, 'err', 5000);
      }
    }
  } finally {
    job.progress = job.status === 'done' ? 1 : null;
    refreshJob(job);
    if (!internal) {
      state.running = false;
      state.batchIndex = 0;
      state.batchTotal = 0;
      renderToolbar();
    }
  }
}

async function convertAll(onlyFailed = false) {
  if (state.running) return;
  const targets = state.jobs.filter((j) => (onlyFailed
    ? j.status === 'error'
    : (j.status === 'idle' || j.status === 'error' || j.status === 'canceled')));
  if (!targets.length) {
    toast(onlyFailed ? '没有失败项需要重试' : '没有待转换的文件', 'warn');
    return;
  }
  state.running = true;
  state.cancelAll = false;
  state.paused = false;
  state.batchTotal = targets.length;
  state.batchIndex = 0;
  state.batchDone = 0;
  state.batchFailed = 0;
  renderToolbar();
  renderQueue();

  for (const job of targets) {
    if (state.cancelAll) break;
    await waitIfPaused();
    if (state.cancelAll) break;
    state.batchIndex++;
    renderStats();
    await convertOne(job, true);
    if (job.status === 'done') state.batchDone++;
    else if (job.status === 'error') state.batchFailed++;
    renderBatchProgress();
  }

  const canceled = state.cancelAll;
  const okCount = state.batchDone;
  const failCount = state.batchFailed;
  state.running = false;
  state.paused = false;
  state.batchTotal = 0;
  state.batchIndex = 0;
  state.batchDone = 0;
  state.batchFailed = 0;
  renderToolbar();
  renderStats();
  if (canceled) toast('批量转换已停止，可对未完成项重新开始', 'warn', 3600);
  else if (failCount) toast(`批量转换结束：完成 ${okCount} 个，失败 ${failCount} 个，可点「重试失败项」单独重试`, 'warn', 5000);
  else toast(`批量转换结束，已完成 ${okCount} 个文件`, 'ok', 3600);
}

function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;
  toast(state.paused ? '当前文件完成后暂停' : '已继续批量转换', state.paused ? 'warn' : 'ok');
  renderToolbar();
  renderStats();
}

async function waitIfPaused() {
  while (state.paused && !state.cancelAll) {
    await new Promise((resolve) => setTimeout(resolve, 140));
  }
}

function stopAll() {
  if (!state.running) return;
  state.cancelAll = true;
  state.paused = false;
  const current = state.jobs.find((j) => j.status === 'running');
  if (current) {
    current.cancelRequested = true;
    current.stage = '正在取消…';
    updateLive(current);
  }
  terminateFFmpeg();
  toast('正在停止…', 'warn');
}

async function downloadOutputs(outputs, base) {
  if (!outputs || !outputs.length) return;
  if (outputs.length === 1) {
    downloadBlob(outputs[0].blob, outputs[0].name);
    return;
  }
  toast('正在打包 ZIP…');
  const zip = await makeZip(outputs);
  downloadBlob(zip, `${base || '空天转换结果'}-${zipStamp()}.zip`);
}

async function downloadAll() {
  const outputs = [];
  for (const job of state.jobs) if (job.status === 'done' && job.outputs) outputs.push(...job.outputs);
  for (const ex of state.extra) outputs.push(...ex.outputs);
  if (!outputs.length) { toast('还没有可下载的结果', 'warn'); return; }
  await downloadOutputs(outputs, '空天转换结果');
}

async function mergeSelectedPdfs() {
  const pdfJobs = state.jobs.filter((j) => j.category === 'pdf');
  if (pdfJobs.length < 2) { toast('队列中至少需要 2 个 PDF', 'warn'); return; }
  showOverlay({ title: `正在合并 ${pdfJobs.length} 个 PDF`, detail: '准备中…', progress: 0, mode: 'busy' });
  const hooks = {
    onStage: (s) => updateOverlay({ detail: s }),
    onProgress: (p) => updateOverlay({ progress: p }),
  };
  try {
    const outputs = await mergePdfs(pdfJobs.map((j) => j.file), hooks);
    const entry = {
      id: uid(),
      name: `合并 ${pdfJobs.length} 份 PDF`,
      category: 'pdf',
      target: 'merge',
      targetLabel: 'PDF 合并',
      outputs: outputs.map((o) => ({ name: o.name, size: o.size })),
      time: Date.now(),
    };
    state.history.unshift(entry);
    state.historyBlobs.set(entry.id, outputs);
    while (state.history.length > 20) {
      const dropped = state.history.pop();
      state.historyBlobs.delete(dropped.id);
    }
    state.extra.unshift({ id: entry.id, title: `合并 ${pdfJobs.length} 份 PDF`, outputs, time: Date.now() });
    state.extra = state.extra.slice(0, 3);
    persistHistory();
    renderHistory();
    renderExtra();
    hideOverlay();
    renderToolbar();
    toast('PDF 合并完成，可在「最近生成」或历史中下载', 'ok', 4000);
  } catch (e) {
    hideOverlay();
    toast('合并失败：' + ((e && e.message) || e), 'err', 5000);
  }
}

/* ---------- 批量设置与预设 ---------- */
function openBatchDialog() {
  const present = CATEGORIES.map((c) => c.id).filter((id) => state.jobs.some((j) => j.category === id));
  const catId = present.includes(state.settingsCat) ? state.settingsCat : (present[0] || state.settingsCat);
  setBatchCategory(catId);
  renderBatch();
  $('#batch-dialog').showModal();
}

function setBatchCategory(catId) {
  state.batch.cat = catId;
  const first = state.jobs.find((j) => j.category === catId && j.status !== 'done');
  const def = state.defaults[catId];
  state.batch.target = first ? first.target : def.target;
  state.batch.params = first ? { ...first.params } : { ...def.params };
}

function renderBatch() {
  const catId = state.batch.cat;
  const cat = CATEGORY_MAP[catId];
  const count = state.jobs.filter((j) => j.category === catId && j.status !== 'running' && j.status !== 'done').length;

  $('#batch-tabs').innerHTML = CATEGORIES.map((c) => {
    const n = state.jobs.filter((j) => j.category === c.id).length;
    return `<button class="cat-tab${c.id === catId ? ' active' : ''}" data-bcat="${c.id}" type="button">
      <span class="cat-dot" style="background:${c.color}"></span>${c.label}${n ? `<b class="tab-count">${n}</b>` : ''}</button>`;
  }).join('');

  const descriptors = paramDescriptors(catId, state.batch.target, '');
  $('#batch-body').innerHTML = `
    <label class="field"><span>输出格式（${cat.label}）</span><select id="batch-target">${settingsTargetOptions(catId, state.batch.target)}</select></label>
    ${renderParamsHtml(descriptors, state.batch.params, 'data-bparam')}
    <p class="hint small">${escapeHtml(cat.hint || '')}${count ? '' : '（队列中暂无可应用的本类文件）'}</p>`;
  $('#batch-count').textContent = count
    ? `队列中 ${count} 个${cat.label}文件会套用此设置（已完成的保留原结果）`
    : `队列中暂无待处理的${cat.label}文件`;

  $('#batch-tabs').querySelectorAll('.cat-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setBatchCategory(btn.dataset.bcat);
      renderBatch();
    });
  });

  $('#batch-target').addEventListener('change', (e) => {
    state.batch.target = e.target.value;
    state.batch.params = { ...defaultParamsFor(catId, state.batch.target, '') };
    renderBatch();
  });

  $('#batch-body').oninput = (e) => {
    const input = e.target.closest('[data-bparam]');
    if (!input) return;
    state.batch.params[input.dataset.bparam] = input.value;
    if (input.type === 'range') {
      const out = input.closest('.field').querySelector('.range-val');
      if (out) out.textContent = input.value + '%';
    }
  };

  renderPresetList();
}

function applyBatchSettings() {
  const catId = state.batch.cat;
  const target = state.batch.target;
  const params = paramsForBatch(catId, target, state.batch.params);
  let changed = 0;
  for (const job of state.jobs) {
    if (job.category !== catId || job.status === 'running' || job.status === 'done') continue;
    job.target = target;
    job.params = { ...params };
    changed++;
  }
  const def = state.defaults[catId];
  def.target = target;
  def.params = { ...params };
  def.byTarget = def.byTarget || {};
  def.byTarget[target] = { ...params };
  saveJSON(LS.defaults, state.defaults);
  renderQueue();
  renderToolbar();
  renderSettings();
  const cat = CATEGORY_MAP[catId];
  $('#batch-count').textContent = changed
    ? `已应用到 ${changed} 个${cat.label}文件，并保存为默认设置`
    : `队列中暂无待处理的${cat.label}文件，已保存为默认设置`;
  if (changed) toast(`已将设置应用到 ${changed} 个${cat.label}文件`, 'ok');
  else toast('已保存为默认设置，队列中没有该类别待处理文件', 'warn', 4000);
}

function renderPresetList() {
  const box = $('#preset-list');
  if (!state.presets.length) {
    box.innerHTML = '<p class="hint small">还没有预设。填写名称后点「保存当前设置」，下次可一键载入。</p>';
    return;
  }
  box.innerHTML = state.presets.map((p) => {
    const cat = CATEGORY_MAP[p.cat];
    const label = targetOf(p.cat, p.target)?.label || p.target;
    return `<div class="preset-item" data-pid="${p.id}">
      <div class="preset-main">
        <span class="preset-name">${escapeHtml(p.name)}</span>
        <span class="preset-meta">${cat.label} · ${escapeHtml(label)}</span>
      </div>
      <button class="btn btn-secondary btn-xs" type="button" data-preset-load="${p.id}">载入</button>
      <button class="btn btn-ghost btn-xs" type="button" data-preset-del="${p.id}">删除</button>
    </div>`;
  }).join('');
}

function saveBatchPreset() {
  const catId = state.batch.cat;
  const target = state.batch.target;
  const targetLabel = targetOf(catId, target)?.label || target;
  const typed = $('#preset-name').value.trim();
  const name = (typed || `${CATEGORY_MAP[catId].label} → ${targetLabel}`).slice(0, 28);
  const params = paramsForBatch(catId, target, state.batch.params);
  state.presets = state.presets.filter((p) => !(p.name === name && p.cat === catId));
  state.presets.unshift({ id: uid(), name, cat: catId, target, params });
  state.presets = state.presets.slice(0, 12);
  savePresets();
  renderPresetList();
  $('#preset-name').value = '';
  toast(`预设「${name}」已保存`, 'ok');
}

function loadPreset(id) {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return;
  state.batch.cat = preset.cat;
  state.batch.target = preset.target;
  state.batch.params = paramsForBatch(preset.cat, preset.target, preset.params);
  renderBatch();
  toast(`已载入预设「${preset.name}」，点「应用到该类全部文件」生效`, 'ok', 4200);
}

function deletePreset(id) {
  state.presets = state.presets.filter((p) => p.id !== id);
  savePresets();
  renderPresetList();
  toast('预设已删除');
}

/* ---------- 图片合成 PDF ---------- */
function imageJobs() {
  return state.jobs.filter((j) => j.category === 'image');
}

function openImgPdfDialog() {
  reloadImgPdf();
  $('#imgpdf-dialog').showModal();
}

function reloadImgPdf() {
  const jobs = imageJobs();
  state.imgPdf.ids = jobs.map((j) => j.id);
  state.imgPdf.selected = new Set(state.imgPdf.ids);
  renderImgPdfList();
}

function imgPdfSelectedCount() {
  return state.imgPdf.ids.filter((id) => state.imgPdf.selected.has(id)).length;
}

function imgPdfPageCount() {
  const n = imgPdfSelectedCount();
  const per = Number($('#ip-perpage').value) || 1;
  return Math.ceil(n / per);
}

function renderImgPdfList() {
  const jobs = state.imgPdf.ids.map(jobById).filter(Boolean);
  const list = $('#imgpdf-list');
  if (!jobs.length) {
    list.innerHTML = '<p class="hint">队列中没有图片文件。先在上方拖入 JPG / PNG / WebP 等图片再回来。</p>';
    $('#imgpdf-count').textContent = '';
    return;
  }
  const ordered = state.imgPdf.ids.filter((id) => state.imgPdf.selected.has(id));
  list.innerHTML = jobs.map((job, i) => {
    const on = state.imgPdf.selected.has(job.id);
    const idx = ordered.indexOf(job.id);
    return `<div class="imgpdf-row${on ? '' : ' off'}" data-ipid="${job.id}">
      <label class="check ip-check"><input type="checkbox" data-ipcheck="${job.id}"${on ? ' checked' : ''} aria-label="选择 ${escapeHtml(job.file.name)}"></label>
      <span class="ip-index">${on ? idx + 1 : '–'}</span>
      <span class="ip-name" title="${escapeHtml(job.file.name)}">${escapeHtml(job.file.name)}</span>
      <span class="ip-size">${fmtSize(job.file.size)}</span>
      <span class="ip-order">
        <button class="btn btn-ghost btn-xs" type="button" data-ipup="${job.id}" aria-label="上移"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="btn btn-ghost btn-xs" type="button" data-ipdown="${job.id}" aria-label="下移"${i === jobs.length - 1 ? ' disabled' : ''}>↓</button>
      </span>
    </div>`;
  }).join('');
  const n = imgPdfSelectedCount();
  $('#imgpdf-count').textContent = n ? `已选 ${n} 张 · 共 ${imgPdfPageCount()} 页` : '尚未选择图片';
}

function moveImgPdf(id, dir) {
  const arr = state.imgPdf.ids;
  const i = arr.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderImgPdfList();
}

async function createImgPdf() {
  const jobs = state.imgPdf.ids.map(jobById).filter((j) => j && state.imgPdf.selected.has(j.id));
  if (!jobs.length) { toast('请至少勾选 1 张图片', 'warn'); return; }
  const params = {
    pdfPage: $('#ip-mode').value,
    pdfOrientation: $('#ip-orient').value,
    pdfMargin: $('#ip-margin').value,
    pdfPerPage: $('#ip-perpage').value,
    imageQuality: $('#ip-quality').value,
  };
  const cancelRef = { value: false };
  showOverlay({
    title: `正在合成 ${jobs.length} 张图片`,
    detail: '准备中…',
    progress: 0,
    mode: 'busy',
    cancel: () => { cancelRef.value = true; updateOverlay({ detail: '正在取消…' }); },
  });
  const hooks = {
    isCancelled: () => cancelRef.value,
    onStage: (text) => updateOverlay({ detail: text }),
    onProgress: (p) => updateOverlay({ progress: p }),
  };
  try {
    const outputs = await imagesToPdf(jobs.map((j) => j.file), params, hooks);
    hideOverlay();
    const entry = {
      id: uid(),
      name: `合成 ${jobs.length} 张图片`,
      category: 'image',
      target: 'pdf',
      targetLabel: 'PDF（图片合成）',
      outputs: outputs.map((o) => ({ name: o.name, size: o.size })),
      time: Date.now(),
    };
    state.history.unshift(entry);
    state.historyBlobs.set(entry.id, outputs);
    while (state.history.length > 20) {
      const dropped = state.history.pop();
      state.historyBlobs.delete(dropped.id);
    }
    state.extra.unshift({ id: entry.id, title: `合成 ${jobs.length} 张图片 → PDF`, outputs, time: Date.now() });
    state.extra = state.extra.slice(0, 3);
    persistHistory();
    renderHistory();
    renderExtra();
    $('#imgpdf-dialog').close();
    renderToolbar();
    toast(`PDF 已生成：${outputs[0].name}（${fmtSize(outputs[0].size)}），可在「最近生成」下载`, 'ok', 4600);
  } catch (e) {
    hideOverlay();
    if (cancelRef.value) toast('已取消合成', 'warn');
    else toast('合成失败：' + ((e && e.message) || e), 'err', 5000);
  }
}

/* ---------- PDF 工具箱（可视化页面管理 + 比较） ---------- */
function pdfToolItems() {
  return state.pdfTool.items;
}

function pdfToolSelected() {
  return state.pdfTool.items.filter((it) => state.pdfTool.selected.has(it.key));
}

function pdfToolPlan(items) {
  return items.map((it) => (it.blank
    ? { blank: true, width: it.width, height: it.height }
    : { src: it.src, rotate: it.rotate }));
}

function pdfToolThumbHtml(it, index) {
  if (it.blank) return '<span class="pp-blank">空白页</span>';
  if (it.thumb) {
    return `<img src="${it.thumb}" alt="第 ${it.src + 1} 页" style="transform:rotate(${it.rotate}deg)">`;
  }
  return '<span class="pp-loading">渲染中…</span>';
}

function renderPdfToolGrid(list) {
  const grid = $('#pdftool-grid');
  const items = list || pdfToolItems();
  if (!items.length) {
    grid.innerHTML = '<p class="hint">在队列中加入 PDF 后，这里会显示每一页的缩略图；用 ↑ / ↓ 调整顺序。</p>';
    return;
  }
  grid.innerHTML = items.map((it, i) => {
    const on = state.pdfTool.selected.has(it.key);
    return `<div class="pdfpage${on ? ' sel' : ''}" data-pkey="${it.key}">
      <div class="pp-top">
        <label class="check"><input type="checkbox" data-pptick="${it.key}"${on ? ' checked' : ''} aria-label="选择第 ${i + 1} 页"></label>
        <span class="pp-no">#${i + 1}</span>
        ${it.blank ? '<span class="pp-src">新增</span>' : `<span class="pp-src">原 ${it.src + 1}</span>`}
      </div>
      <div class="pp-canvas">${pdfToolThumbHtml(it, i)}</div>
      <div class="pp-actions">
        <button class="btn btn-ghost btn-xs" data-ppact="up" type="button" title="上移"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="btn btn-ghost btn-xs" data-ppact="down" type="button" title="下移"${i === items.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="btn btn-ghost btn-xs" data-ppact="rotl" type="button" title="逆时针旋转">⟲</button>
        <button class="btn btn-ghost btn-xs" data-ppact="rotr" type="button" title="顺时针旋转">⟳</button>
        <button class="btn btn-ghost btn-xs" data-ppact="dup" type="button" title="复制此页">⧉</button>
        <button class="btn btn-ghost btn-xs" data-ppact="del" type="button" title="删除此页">✕</button>
      </div>
    </div>`;
  }).join('');
  $('#pdftool-count').textContent = `${items.length} 页 · 选中 ${pdfToolSelected().length} 页`;
}

async function renderPdfToolThumbs() {
  const st = state.pdfTool;
  if (!st.pdf) return;
  for (const it of st.items) {
    if (it.blank || it.thumb) continue;
    try {
      const canvas = await renderThumb(st.pdf, it.src + 1, 150);
      it.thumb = canvas.toDataURL('image/jpeg', 0.72);
    } catch (_) {
      it.thumb = '';
    }
    if (state.pdfTool === st) {
      const card = document.querySelector(`.pdfpage[data-pkey="${it.key}"] .pp-canvas`);
      if (card) card.innerHTML = pdfToolThumbHtml(it);
    }
  }
}

function pdfJobs() {
  return state.jobs.filter((j) => j.category === 'pdf');
}

function pdfJobLabel(job) {
  const size = fmtSize(job.file.size);
  return `${job.file.name} · ${size}`;
}

/** 队列变化时同步来源下拉框，始终从队列取文件 */
let pdfWbSig = '';
function refreshPdfWorkbench() {
  const jobs = pdfJobs();
  const panel = $('#pdf-workbench');
  if (!panel) return;
  if (!jobs.length) {
    panel.classList.add('hidden');
    pdfWbSig = '';
    if (state.pdfTool.jobId) {
      state.pdfTool.jobId = null;
      state.pdfTool.file = null;
      state.pdfTool.items = [];
      state.pdfTool.selected = new Set();
      $('#pdftool-info').textContent = '从队列中选择一份 PDF';
      $('#pdftool-count').textContent = '';
      renderPdfToolGrid([]);
    }
    return;
  }
  const sig = jobs.map((j) => `${j.id}:${j.file.name}:${j.file.size}`).join('|');
  if (sig === pdfWbSig) return;
  pdfWbSig = sig;
  const fill = (sel, keep) => {
    const el = $(sel);
    if (!el) return;
    const prev = keep || el.value;
    el.innerHTML = jobs.map((j) => `<option value="${j.id}">${escapeHtml(pdfJobLabel(j))}</option>`).join('');
    if (jobs.some((j) => j.id === prev)) el.value = prev;
    else el.value = jobs[0].id;
  };
  fill('#pdfwb-source', state.pdfTool.jobId);
  fill('#pdfwb-a');
  fill('#pdfwb-b');
  if (jobs.length > 1 && $('#pdfwb-a').value === $('#pdfwb-b').value) {
    $('#pdfwb-b').value = jobs.find((j) => j.id !== $('#pdfwb-a').value).id;
  }
  const src = $('#pdfwb-source').value;
  if (!panel.classList.contains('hidden') && src && src !== state.pdfTool.jobId) {
    loadPdfToolJob(src);
  }
}

async function loadPdfToolJob(jobId, force = false) {
  const job = jobById(jobId);
  if (!job || job.category !== 'pdf') {
    state.pdfTool.jobId = null;
    state.pdfTool.file = null;
    state.pdfTool.pdf = null;
    state.pdfTool.items = [];
    state.pdfTool.selected = new Set();
    $('#pdftool-info').textContent = '从队列中选择一份 PDF';
    $('#pdftool-count').textContent = '';
    renderPdfToolGrid([]);
    return;
  }
  const st = state.pdfTool;
  if (!force && st.jobId === job.id && st.file === job.file && st.items.length) return;
  st.loading = true;
  st.jobId = job.id;
  st.file = job.file;
  $('#pdftool-info').textContent = '正在解析 ' + job.file.name + ' …';
  try {
    if (st.pdf) { try { st.pdf.destroy(); } catch (_) {} }
    const info = await pdfInfo(job.file);
    const pdf = await openPdfForPreview(job.file);
    if (state.pdfTool !== st) { try { pdf.destroy(); } catch (_) {} return; }
    st.pdf = pdf;
    st.items = info.pages.map((p, i) => ({
      key: uid(), src: i, rotate: 0, blank: false, width: p.width, height: p.height, thumb: '',
    }));
    st.selected = new Set(st.items.map((it) => it.key));
    $('#pdftool-info').textContent = `${job.file.name} · ${info.pageCount} 页${info.metadata.title ? ' · ' + info.metadata.title : ''}`;
    renderPdfToolGrid();
    renderPdfToolThumbs();
  } catch (e) {
    $('#pdftool-info').textContent = '解析失败：' + ((e && e.message) || e);
    toast('PDF 解析失败：' + ((e && e.message) || e), 'err', 4600);
  } finally {
    st.loading = false;
  }
}

function pdfToolAction(act, key) {
  const st = state.pdfTool;
  const items = st.items;
  if (!items.length) return;
  const idx = key ? items.findIndex((it) => it.key === key) : -1;

  if (act === 'select-all') {
    st.selected = new Set(items.map((it) => it.key));
    renderPdfToolGrid();
    return;
  }
  if (act === 'select-none') {
    st.selected = new Set();
    renderPdfToolGrid();
    return;
  }
  if (act === 'rotate-left' || act === 'rotate-right') {
    const delta = act === 'rotate-right' ? 90 : -90;
    const targets = pdfToolSelected();
    if (!targets.length) { toast('请先勾选要旋转的页面', 'warn'); return; }
    for (const it of targets) it.rotate = it.rotate + delta;
    renderPdfToolGrid();
    return;
  }
  if (act === 'delete') {
    const targets = new Set(pdfToolSelected().map((it) => it.key));
    if (!targets.size) { toast('请先勾选要删除的页面', 'warn'); return; }
    const next = items.filter((it) => !targets.has(it.key));
    if (!next.length) { toast('不能删除全部页面', 'warn'); return; }
    st.items = next;
    st.selected = new Set(next.map((it) => it.key));
    renderPdfToolGrid();
    return;
  }
  if (act === 'blank') {
    const first = items.find((it) => !it.blank) || { width: 595.28, height: 841.89 };
    const entry = { key: uid(), src: 0, rotate: 0, blank: true, width: first.width, height: first.height, thumb: '' };
    const at = idx >= 0 ? idx + 1 : items.length;
    items.splice(at, 0, entry);
    st.selected.add(entry.key);
    renderPdfToolGrid();
    return;
  }
  if (act === 'duplicate') {
    const targets = pdfToolSelected();
    if (!targets.length) { toast('请先勾选要复制的页面', 'warn'); return; }
    let offset = 0;
    for (const it of targets) {
      const at = items.findIndex((x) => x.key === it.key) + 1 + offset;
      const copy = { ...it, key: uid() };
      items.splice(at, 0, copy);
      st.selected.add(copy.key);
      offset++;
    }
    renderPdfToolGrid();
    return;
  }
  if (idx < 0) return;
  const it = items[idx];
  if (act === 'up' && idx > 0) {
    [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
    renderPdfToolGrid();
  } else if (act === 'down' && idx < items.length - 1) {
    [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
    renderPdfToolGrid();
  } else if (act === 'rotl') {
    it.rotate -= 90;
    renderPdfToolGrid();
  } else if (act === 'rotr') {
    it.rotate += 90;
    renderPdfToolGrid();
  } else if (act === 'dup') {
    items.splice(idx + 1, 0, { ...it, key: uid() });
    st.selected.add(items[idx + 1].key);
    renderPdfToolGrid();
  } else if (act === 'del') {
    if (items.length <= 1) { toast('至少保留一页', 'warn'); return; }
    st.selected.delete(it.key);
    items.splice(idx, 1);
    renderPdfToolGrid();
  }
}

async function exportPdfTool() {
  const st = state.pdfTool;
  if (!st.file) { toast('请先选择一份 PDF', 'warn'); return; }
  const mode = $('#pdftool-export').value;
  let items = pdfToolItems();
  if (mode === 'selected') {
    items = pdfToolSelected();
    if (!items.length) { toast('请先勾选要导出的页面', 'warn'); return; }
  }
  const cancelRef = { value: false };
  const title = mode === 'split' ? `逐页拆分（${items.length} 页）` : `导出整理结果（${items.length} 页）`;
  showOverlay({
    title,
    detail: '准备中…',
    progress: 0,
    mode: 'busy',
    cancel: () => { cancelRef.value = true; updateOverlay({ detail: '正在取消…' }); },
  });
  const hooks = {
    isCancelled: () => cancelRef.value,
    onStage: (t) => updateOverlay({ detail: t }),
    onProgress: (p) => updateOverlay({ progress: p }),
  };
  try {
    let outputs;
    if (mode === 'split') {
      const parts = [];
      for (let i = 0; i < items.length; i++) {
        if (cancelRef.value) throw new DOMException('已取消', 'AbortError');
        updateOverlay({ detail: `生成第 ${i + 1}/${items.length} 页` });
        updateOverlay({ progress: (i + 1) / items.length });
        const one = await applyPagePlan(st.file, pdfToolPlan([items[i]]));
        parts.push({ name: `${baseName(st.file.name)}-p${String(i + 1).padStart(3, '0')}.pdf`, blob: one[0].blob });
      }
      const zip = await makeZip(parts);
      outputs = [{ name: `${baseName(st.file.name)}-逐页拆分.zip`, blob: zip, size: zip.size, extra: parts.length }];
    } else {
      outputs = await applyPagePlan(st.file, pdfToolPlan(items), hooks);
    }
    hideOverlay();
    pushExtra(title, outputs, 'PDF 页面管理');
    toast(`已生成 ${outputs[0].name}（${fmtSize(outputs[0].size)}），可在「最近生成」下载`, 'ok', 4600);
  } catch (e) {
    hideOverlay();
    if (cancelRef.value) toast('已取消导出', 'warn');
    else toast('导出失败：' + ((e && e.message) || e), 'err', 5000);
  }
}

async function runPdfCompare() {
  const jobA = jobById($('#pdfwb-a').value);
  const jobB = jobById($('#pdfwb-b').value);
  if (!jobA || !jobB) { toast('请从队列中选择 A、B 两份 PDF', 'warn'); return; }
  if (jobA.id === jobB.id) { toast('请选择两份不同的 PDF', 'warn'); return; }
  const a = jobA.file;
  const b = jobB.file;
  const cancelRef = { value: false };
  showOverlay({
    title: '正在比较两份 PDF',
    detail: '逐页渲染中…',
    progress: 0,
    mode: 'busy',
    cancel: () => { cancelRef.value = true; },
  });
  const hooks = {
    isCancelled: () => cancelRef.value,
    onStage: (t) => updateOverlay({ detail: t }),
    onProgress: (p) => updateOverlay({ progress: p }),
  };
  try {
    const outputs = await comparePdfs(a, b, {}, hooks);
    hideOverlay();
    pushExtra(`比较：${a.name} ↔ ${b.name}`, outputs, 'PDF 比较报告');
    toast('比较完成，报告已生成', 'ok', 4200);
  } catch (e) {
    hideOverlay();
    if (cancelRef.value) toast('已取消比较', 'warn');
    else toast('比较失败：' + ((e && e.message) || e), 'err', 5000);
  }
}

function initPdfTool() {
  const panel = $('#pdf-workbench');
  const open = () => {
    panel.classList.remove('hidden');
    refreshPdfWorkbench();
    if (!state.pdfTool.jobId) loadPdfToolJob($('#pdfwb-source').value);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  $('#btn-pdf-workbench').addEventListener('click', () => {
    if (panel.classList.contains('hidden')) open();
    else panel.classList.add('hidden');
  });
  $('#btn-pdfwb-close').addEventListener('click', () => panel.classList.add('hidden'));
  $('#pdfwb-source').addEventListener('change', (e) => loadPdfToolJob(e.target.value));

  $('.pdfwb-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pdfwb-tab]');
    if (!btn) return;
    $$('.pdfwb-tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('[data-pdfwb-pane]').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.pdfwbPane !== btn.dataset.pdfwbTab);
    });
    if (btn.dataset.pdfwbTab === 'pages' && $('#pdfwb-source').value) {
      loadPdfToolJob($('#pdfwb-source').value);
    }
  });

  $('#btn-pdftool-reset').addEventListener('click', () => {
    const id = $('#pdfwb-source').value;
    if (id) loadPdfToolJob(id, true);
  });
  $('.pdftool-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-pdfact]');
    if (btn) pdfToolAction(btn.dataset.pdfact);
  });
  $('#pdftool-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ppact]');
    if (!btn) return;
    const card = btn.closest('.pdfpage');
    pdfToolAction(btn.dataset.ppact, card.dataset.pkey);
  });
  $('#pdftool-grid').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-pptick]');
    if (!cb) return;
    if (cb.checked) state.pdfTool.selected.add(cb.dataset.pptick);
    else state.pdfTool.selected.delete(cb.dataset.pptick);
    renderPdfToolGrid();
  });
  $('#btn-pdftool-apply').addEventListener('click', exportPdfTool);
  $('#btn-pdf-compare').addEventListener('click', runPdfCompare);
  $('#btn-about').addEventListener('click', () => $('#about-dialog').showModal());
}

/* ---------- 历史 ---------- */
function loadHistory() {
  const saved = loadJSON(LS.history, []);
  if (Array.isArray(saved)) state.history = saved.filter((h) => h && h.id && Array.isArray(h.outputs));
}

function renderHistory() {
  const box = $('#history');
  if (!state.history.length) {
    box.innerHTML = '<p class="hint">暂无记录。转换完成后会显示在这里（刷新页面后仅保留记录信息）。</p>';
    return;
  }
  box.innerHTML = state.history.map((h) => {
    const hasBlob = state.historyBlobs.has(h.id);
    const when = new Date(h.time);
    const timeText = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    const outNames = h.outputs.map((o) => escapeHtml(o.name)).join('、');
    return `<div class="history-row">
      <div class="history-main">
        <div class="history-title" title="${escapeHtml(h.name)}">${escapeHtml(h.name)} <span class="arrow">→</span> ${escapeHtml(h.targetLabel)}</div>
        <div class="history-sub">${timeText} · ${h.outputs.length} 个文件 · ${outNames.length > 60 ? outNames.slice(0, 60) + '…' : outNames}</div>
      </div>
      <button class="btn ${hasBlob ? 'btn-secondary' : 'btn-ghost'} btn-sm" data-hid="${h.id}" ${hasBlob ? '' : 'disabled title="刷新后结果已释放，请重新转换"'}>${hasBlob ? '下载' : '已过期'}</button>
    </div>`;
  }).join('');
}

function renderExtra() {
  const card = $('#extra-outputs');
  card.classList.toggle('hidden', !state.extra.length);
  $('#extra-list').innerHTML = state.extra.map((ex) => {
    const out = ex.outputs[0];
    return `<div class="extra-row">
      <span class="out-name">${escapeHtml(ex.title)}</span>
      <span class="muted">${escapeHtml(out ? out.name : '')} · ${out ? fmtSize(out.size) : ''}</span>
      <button class="btn btn-secondary btn-xs" data-xid="${ex.id}">下载</button>
    </div>`;
  }).join('');
}

/* ---------- 工具箱 ---------- */
function initToolbox() {
  const dlg = $('#toolbox-dialog');
  $('#btn-toolbox').addEventListener('click', () => dlg.showModal());
  $$('.tool-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tool-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      $$('#tool-panels section').forEach((s) => s.classList.toggle('hidden', s.dataset.panel !== btn.dataset.tool));
    });
  });

  $('#btn-hash').addEventListener('click', async () => {
    const file = $('#hash-file').files[0];
    if (!file) { toast('请选择文件', 'warn'); return; }
    const algos = $$('#hash-algos input:checked').map((c) => c.value);
    if (!algos.length) { toast('请至少选择一种算法', 'warn'); return; }
    try {
      const res = await hashFile(file, algos);
      $('#hash-result').value = res.text;
      $('#btn-hash-download').dataset.name = res.name;
      toast('哈希计算完成', 'ok');
    } catch (e) {
      toast('计算失败：' + e.message, 'err');
    }
  });
  $('#btn-hash-copy').addEventListener('click', async () => {
    const text = $('#hash-result').value;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast('已复制', 'ok'); } catch (_) { toast('复制失败', 'err'); }
  });
  $('#btn-hash-download').addEventListener('click', () => {
    const text = $('#hash-result').value;
    if (!text) return;
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), $('#btn-hash-download').dataset.name || 'hash.txt');
  });

  $('#btn-enc').addEventListener('click', async () => {
    const file = $('#enc-file').files[0];
    if (!file) { toast('请选择文本文件', 'warn'); return; }
    const from = $('#enc-from').value;
    const to = $('#enc-to').value;
    try {
      const res = await encodingConvert(file, from, to);
      $('#enc-status').textContent = `已生成：${res.name}（${res.text.length} 字符）`;
      downloadBlob(res.blob, res.name);
    } catch (e) {
      $('#enc-status').textContent = '转换失败：' + e.message;
      toast('编码转换失败', 'err');
    }
  });

  $('#json-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { $('#json-input').value = await readText(f, 'utf-8'); } catch (_) {}
  });
  $('#btn-json').addEventListener('click', () => {
    const indent = Number($('#json-indent').value);
    try {
      const out = jsonFormat($('#json-input').value, indent);
      $('#json-output').value = out;
      toast('格式化完成', 'ok');
    } catch (e) {
      $('#json-output').value = '';
      toast(e.message, 'err');
    }
  });
  $('#btn-json-download').addEventListener('click', () => {
    if (!$('#json-output').value) return;
    downloadBlob(new Blob([$('#json-output').value], { type: 'application/json' }), 'formatted.json');
  });

  $('#btn-b64-encode').addEventListener('click', () => {
    try { $('#b64-output').value = base64Encode($('#b64-input').value); } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-b64-decode').addEventListener('click', () => {
    try { $('#b64-output').value = base64Decode($('#b64-input').value); } catch (e) { toast(e.message, 'err'); }
  });
  $('#btn-b64-copy').addEventListener('click', async () => {
    if (!$('#b64-output').value) return;
    try { await navigator.clipboard.writeText($('#b64-output').value); toast('已复制', 'ok'); } catch (_) {}
  });
}

/* ---------- 格式矩阵 ---------- */
function buildMatrix() {
  const catHtml = CATEGORIES.map((cat) => {
    const rows = cat.targets.map((t) => {
      const status = t.partial ? '<span class="pill warn">部分</span>' : '<span class="pill ok">支持</span>';
      return `<tr><td>${escapeHtml(t.label)} <code>.${t.id}</code></td><td>${status}</td><td>${escapeHtml(t.note || (t.partial ? '功能受限，详见说明' : '浏览器内可完整完成'))}</td></tr>`;
    }).join('');
    return `<section class="matrix-cat">
      <h3><span class="cat-dot" style="background:${cat.color}"></span>${cat.label}<span class="muted">　输入：${cat.exts.map((e) => '.' + e).join(' ')}</span></h3>
      <table><thead><tr><th>输出</th><th>状态</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
      ${cat.id === 'image' ? `<p class="hint">AVIF 输出：${AVIF_ENCODE_SUPPORTED ? '当前浏览器支持编码' : '当前浏览器不支持 Canvas 编码 AVIF，仅能作为输入'}；GIF 动图输入仅取首帧。</p>` : ''}
    </section>`;
  }).join('');

  const notes = `<section class="matrix-notes"><h3>技术说明与限制</h3>${CAPABILITY_NOTES.map(([k, v]) => `<p><b>${k}</b>：${escapeHtml(v)}</p>`).join('')}</section>`;
  $('#matrix-content').innerHTML = notes + catHtml;
}

function initMatrix() {
  const dlg = $('#matrix-dialog');
  $('#btn-matrix').addEventListener('click', () => dlg.showModal());
}

function initDialogs() {
  $$('dialog').forEach((dlg) => {
    $$('[data-close]', dlg).forEach((btn) => btn.addEventListener('click', () => dlg.close()));
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
  });
}

/* ---------- 示例文件 ---------- */
function makeWav(seconds = 1.6, freq = 440) {
  const rate = 44100;
  const samples = Math.floor(rate * seconds);
  const bytesPerSample = 2;
  const dataSize = samples * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * bytesPerSample, true);
  dv.setUint16(32, bytesPerSample, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const fade = Math.min(1, t * 4, (seconds - t) * 4);
    const v = Math.sin(2 * Math.PI * freq * t) * 0.5 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.15;
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * fade * 0.8 * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function makePngBlob(opts = {}) {
  const title = opts.title || 'KONG TIAN';
  const subtitle = opts.subtitle || '空天文件转换 · 示例图片';
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 560;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 900, 560);
  g.addColorStop(0, '#0b1530');
  g.addColorStop(0.45, '#173a72');
  g.addColorStop(1, '#0f7f9c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 900, 560);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.6 + 0.1})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 900, Math.random() * 560, Math.random() * 1.6 + 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(86,190,255,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(450, 300, 150, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(450, 300, 240, 70, -0.35, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(120,220,255,0.9)';
  ctx.beginPath();
  ctx.arc(330, 240, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.font = '600 46px "Microsoft YaHei", "Segoe UI", sans-serif';
  ctx.fillText(title, 330, 310);
  ctx.font = '300 22px "Microsoft YaHei", "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(210,235,255,0.75)';
  ctx.fillText(subtitle, 330, 352);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function makeSamplePdf(title, subtitle, color) {
  const { PDFDocument, StandardFonts, rgb } = await ensurePdfLib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 0, y: 700, width: 595, height: 142, color: rgb(color[0], color[1], color[2]) });
  page.drawText(title, { x: 48, y: 770, size: 26, font, color: rgb(1, 1, 1) });
  page.drawText(subtitle, { x: 48, y: 735, size: 12, font: body, color: rgb(0.92, 0.96, 1) });
  const lines = [
    'KongTian File Converter sample document.',
    'All conversions run locally in your browser.',
    'This PDF can be used to test text extraction,',
    'page rendering, splitting and merging.',
  ];
  lines.forEach((line, i) => page.drawText(line, { x: 56, y: 600 - i * 22, size: 13, font: body, color: rgb(0.15, 0.18, 0.24) }));
  page.drawText('Page 1 of 1', { x: 48, y: 48, size: 9, font: body, color: rgb(0.45, 0.5, 0.58) });
  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

async function loadSamples() {
  const btn = $('#btn-samples');
  btn.disabled = true;
  btn.textContent = '正在生成示例…';
  try {
    const files = [];
    const png = await makePngBlob();
    files.push(new File([png], '示例-星空.png', { type: 'image/png' }));
    const png2 = await makePngBlob({ title: 'ORBIT LAB', subtitle: '空天文件转换 · 第二张示例图片' });
    files.push(new File([png2], '示例-轨道.png', { type: 'image/png' }));
    files.push(new File([
      '# 空天文件转换\n\n这是一个用于测试的 Markdown 示例。\n\n## 支持的能力\n\n- Markdown → HTML / TXT / DOCX\n- 音频、视频、图片互转\n- PDF 合并与拆分\n\n```js\nconsole.log("hello kongtian");\n```\n',
    ], '示例-说明.md', { type: 'text/markdown' }));
    files.push(new File([
      '名称,类型,尺寸,备注\n', '星空图,图片,900x560,PNG 示例\n', '说明文档,文档,12 KB,Markdown 示例\n', '采样音频,音频,1.6 秒,WAV 示例\n',
    ], '示例-清单.csv', { type: 'text/csv' }));
    files.push(new File([makeWav()], '示例-音频.wav', { type: 'audio/wav' }));
    files.push(new File([
      '1\n00:00:00,500 --> 00:00:02,000\n空天文件转换：所有处理都在浏览器本地完成。\n\n',
      '2\n00:00:02,200 --> 00:00:04,400\n字幕支持 SRT、WebVTT 与 ASS 互转。\n\n',
      '3\n00:00:04,600 --> 00:00:06,500\n试试把这条字幕导出为 VTT。\n',
    ], '示例-字幕.srt', { type: 'application/x-subrip' }));
    const pdfA = await makeSamplePdf('KongTian Sample A', 'PDF sample · page one', [0.06, 0.18, 0.38]);
    const pdfB = await makeSamplePdf('KongTian Sample B', 'PDF sample · merge & split test', [0.02, 0.42, 0.52]);
    files.push(new File([pdfA], '示例-PDF-A.pdf', { type: 'application/pdf' }));
    files.push(new File([pdfB], '示例-PDF-B.pdf', { type: 'application/pdf' }));
    const zip = await makeZip([
      { name: 'readme.txt', blob: new Blob(['空天文件转换示例压缩包\n'], { type: 'text/plain' }) },
      { name: 'hello.md', blob: new Blob(['# Hello\n\n来自 ZIP 的文件。\n'], { type: 'text/markdown' }) },
    ]);
    files.push(new File([zip], '示例-压缩包.zip', { type: 'application/zip' }));
    addFiles(files);
  } catch (e) {
    console.error(e);
    toast('示例生成失败：' + e.message, 'err', 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '载入示例文件';
  }
}

/* ---------- 事件绑定 ---------- */
function bindQueueEvents() {
  const queue = $('#queue');

  queue.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.job');
    const job = card ? jobById(card.dataset.id) : null;
    if (!job) return;
    const act = btn.dataset.act;

    if (act === 'toggle-params') {
      job.expanded = !job.expanded;
      refreshJob(job);
    } else if (act === 'reset-params') {
      job.params = defaultParamsForJob(job.category, job.target, job.ext);
      refreshJob(job);
      toast('已恢复该文件的默认参数', 'ok');
    } else if (act === 'convert') {
      convertOne(job);
    } else if (act === 'cancel') {
      job.cancelRequested = true;
      job.stage = '正在取消…';
      updateLive(job);
      if (job.category === 'audio' || job.category === 'video') terminateFFmpeg();
    } else if (act === 'remove') {
      if (job.status === 'running') { toast('请先取消当前转换', 'warn'); return; }
      state.jobs = state.jobs.filter((j) => j.id !== job.id);
      renderQueue();
      renderToolbar();
    } else if (act === 'download') {
      await downloadOutputs(job.outputs, baseName(job.file.name));
    } else if (act === 'download-one') {
      const out = (job.outputs || [])[Number(btn.dataset.index)];
      if (out) downloadBlob(out.blob, out.name);
    }
  });

  queue.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-role="target"]');
    if (!sel) return;
    const job = jobById(sel.closest('.job').dataset.id);
    if (!job) return;
    job.target = sel.value;
    job.params = defaultParamsForJob(job.category, job.target, job.ext);
    refreshJob(job);
  });

  queue.addEventListener('input', (e) => {
    const input = e.target.closest('[data-param]');
    if (!input) return;
    const job = jobById(input.closest('.job').dataset.id);
    if (!job) return;
    job.params[input.dataset.param] = input.value;
    if (input.type === 'range') {
      const out = input.closest('.field').querySelector('.range-val');
      if (out) out.textContent = input.value + '%';
    }
    const summary = input.closest('.job').querySelector('.job-summary');
    if (summary) summary.textContent = paramSummary(job);
  });
}

function bindGlobal() {
  $('#btn-convert-all').addEventListener('click', () => convertAll());
  $('#btn-stop').addEventListener('click', stopAll);
  $('#btn-download-all').addEventListener('click', downloadAll);
  $('#btn-clear').addEventListener('click', () => {
    if (state.running) return;
    state.jobs = [];
    renderQueue();
    renderToolbar();
    toast('队列已清空');
  });
  $('#btn-merge-pdf').addEventListener('click', mergeSelectedPdfs);
  $('#btn-pause').addEventListener('click', togglePause);
  $('#btn-retry-failed').addEventListener('click', () => convertAll(true));
  $('#btn-batch-settings').addEventListener('click', openBatchDialog);
  $('#btn-batch-apply').addEventListener('click', applyBatchSettings);
  $('#btn-preset-save').addEventListener('click', saveBatchPreset);
  $('#preset-list').addEventListener('click', (e) => {
    const load = e.target.closest('button[data-preset-load]');
    if (load) { loadPreset(load.dataset.presetLoad); return; }
    const del = e.target.closest('button[data-preset-del]');
    if (del) deletePreset(del.dataset.presetDel);
  });
  $('#btn-images-pdf').addEventListener('click', openImgPdfDialog);
  $('#btn-imgpdf-all').addEventListener('click', () => {
    state.imgPdf.selected = new Set(state.imgPdf.ids);
    renderImgPdfList();
  });
  $('#btn-imgpdf-none').addEventListener('click', () => {
    state.imgPdf.selected = new Set();
    renderImgPdfList();
  });
  $('#btn-imgpdf-reload').addEventListener('click', reloadImgPdf);
  $('#btn-imgpdf-create').addEventListener('click', createImgPdf);
  $('#ip-perpage').addEventListener('change', () => renderImgPdfList());
  $('#imgpdf-list').addEventListener('click', (e) => {
    const up = e.target.closest('button[data-ipup]');
    if (up) { moveImgPdf(up.dataset.ipup, -1); return; }
    const down = e.target.closest('button[data-ipdown]');
    if (down) moveImgPdf(down.dataset.ipdown, 1);
  });
  $('#imgpdf-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-ipcheck]');
    if (!cb) return;
    if (cb.checked) state.imgPdf.selected.add(cb.dataset.ipcheck);
    else state.imgPdf.selected.delete(cb.dataset.ipcheck);
    renderImgPdfList();
  });
  $('#btn-clear-history').addEventListener('click', () => {
    state.history = [];
    state.historyBlobs.clear();
    persistHistory();
    renderHistory();
    state.extra = [];
    renderExtra();
    toast('历史已清空');
  });
  $('#btn-apply-defaults').addEventListener('click', () => {
    const catId = state.settingsCat;
    const def = state.defaults[catId];
    let changed = 0;
    for (const job of state.jobs) {
      if (job.category !== catId || job.status === 'running') continue;
      job.target = def.target;
      job.params = { ...def.params };
      changed++;
    }
    renderQueue();
    renderToolbar();
    toast(changed ? `已更新 ${changed} 个${CATEGORY_MAP[catId].label}文件的设置` : '队列中没有该类别文件', changed ? 'ok' : 'warn');
  });

  $('#btn-samples').addEventListener('click', (e) => {
    e.stopPropagation();
    loadSamples();
  });

  $('#extra-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-xid]');
    if (!btn) return;
    const ex = state.extra.find((x) => x.id === btn.dataset.xid);
    if (ex) downloadOutputs(ex.outputs, '空天合并结果');
  });

  $('#history').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-hid]');
    if (!btn || btn.disabled) return;
    const entry = state.history.find((h) => h.id === btn.dataset.hid);
    const outputs = state.historyBlobs.get(btn.dataset.hid);
    if (!entry) return;
    if (!outputs) { toast('结果已释放，请重新转换', 'warn'); return; }
    downloadOutputs(outputs, baseName(entry.name));
  });

  $('#btn-extra-clear')?.addEventListener('click', () => {
    state.extra = [];
    renderExtra();
  });

  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  let dragDepth = 0;
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragenter') dragDepth++;
    dropzone.classList.add('dragging');
  }));
  ['dragleave', 'dragend'].forEach((ev) => dropzone.addEventListener(ev, () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('dragging');
  }));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target.closest && e.target.closest('#dropzone')) return;
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  $('.overlay').addEventListener('click', (e) => {
    if (e.target === $('#overlay') && state.overlayMode !== 'engine') hideOverlay();
  });
}

/* ---------- 启动 ---------- */
function initToolSelects() {
  const encOdds = [
    ['utf-8', 'UTF-8'], ['gbk', 'GBK / GB18030'], ['big5', 'Big5'], ['shift_jis', 'Shift-JIS'],
    ['windows-1252', 'Windows-1252'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'],
  ];
  const toOpts = [['utf-8', 'UTF-8'], ['utf-8-bom', 'UTF-8 (带 BOM)'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']];
  $('#enc-from').innerHTML = encOdds.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('#enc-to').innerHTML = toOpts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
}

function init() {
  initTheme();
  initDefaults();
  initPresets();
  loadHistory();
  buildMatrix();
  initMatrix();
  initToolbox();
  initToolSelects();
  initPdfTool();
  initDialogs();
  renderSettings();
  renderQueue();
  renderHistory();
  renderExtra();
  renderToolbar();
  bindQueueEvents();
  bindGlobal();
  requestAnimationFrame(() => document.body.classList.add('ready'));
}

document.addEventListener('DOMContentLoaded', init);
