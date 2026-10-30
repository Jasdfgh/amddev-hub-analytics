import { range, previousRange, presetRange, todayShanghai } from './dates.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const number = value => numeric(value) ? value.toLocaleString('zh-CN') : '暂无数据';
const shortDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value).replaceAll('-', '.') : '—';
const storageKey = 'amdHubAnalyticsQueryV1';
const cardDefaults = [
  { id:'platform', title:'平台链接' },
  { id:'zhihu_article', title:'知乎文章' },
  { id:'bilibili_video', title:'B站视频' },
  { id:'xiaohongshu_content', title:'小红书内容' }
];
const presetOptions = [['last7','近 7 天'],['thisweek','本周'],['lastweek','上周'],['thismonth','本月'],['lastmonth','上月']];
const emptyQuery = () => ({ ...presetRange('last7'), categories:[], topics:[], targets:[], q:'', compare:true, grain:'day' });
let state = {
  overview:emptyQuery(),
  cards:cardDefaults.map(item => ({ ...emptyQuery(), categories:[item.id], expanded:false })),
  detail:{ ...emptyQuery(), includeZero:false, minClicks:0, sort:'date', direction:'desc', page:1, pageSize:25 },
  overviewScroll:0
};
let catalog = null;
let session = null;
let previousPage = null;
let initialized = false;
const targetById = new Map();
const categoryById = new Map();
const requests = new Map();
const reports = new Map();
const charts = new Map();

function restoreQuery(raw, fallback) {
  if (!raw || typeof raw !== 'object') return fallback;
  try {
    const dates = range(raw.start, raw.end);
    const output = { ...fallback, ...dates };
    for (const key of ['categories','topics','targets']) output[key] = Array.isArray(raw[key]) ? raw[key].filter(item => typeof item === 'string').slice(0, 200) : fallback[key];
    output.q = typeof raw.q === 'string' ? raw.q.slice(0, 256) : '';
    output.compare = raw.compare !== false;
    output.grain = ['day','week','month'].includes(raw.grain) ? raw.grain : 'day';
    if ('expanded' in fallback) output.expanded = raw.expanded === true;
    if ('page' in fallback) {
      output.includeZero = raw.includeZero === true;
      output.minClicks = Number.isSafeInteger(raw.minClicks) && raw.minClicks >= 0 ? raw.minClicks : 0;
      output.sort = ['date','clicks','delta','percent','name'].includes(raw.sort) ? raw.sort : 'date';
      output.direction = raw.direction === 'asc' ? 'asc' : 'desc';
      output.page = Number.isSafeInteger(raw.page) && raw.page > 0 ? raw.page : 1;
      output.pageSize = raw.pageSize === 50 ? 50 : 25;
    }
    return output;
  } catch { return fallback; }
}

try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
  if (saved?.version === 1) {
    state.overview = restoreQuery(saved.overview, state.overview);
    state.cards = state.cards.map((card, index) => restoreQuery(saved.cards?.[index], card));
    state.detail = restoreQuery(saved.detail, state.detail);
    state.overviewScroll = Math.max(0, Number(saved.overviewScroll) || 0);
  }
} catch { /* Storage is optional; queries remain independent in memory. */ }

function saveState() {
  try { sessionStorage.setItem(storageKey, JSON.stringify({ version:1, ...state })); }
  catch { /* No data or credentials are stored here. */ }
}

function abortReports() {
  for (const request of requests.values()) request.controller.abort();
  requests.clear();
  reports.clear();
  charts.clear();
  document.querySelectorAll('.report-area,.card-report').forEach(node => { node.replaceChildren(); node.removeAttribute('aria-busy'); });
}

function setLoginMetadata(metadata) {
  if (typeof metadata?.username !== 'string' || !metadata.username || metadata.username.length > 100) return;
  $('login-username').value = metadata.username;
  $('login-username-label').hidden = false;
}

function showLogin(message = '', metadata = null) {
  session = null;
  initialized = false;
  abortReports();
  $('startup').hidden = true;
  $('application').hidden = true;
  $('login-screen').hidden = false;
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
  $('login-form').querySelector('button').disabled = false;
  setLoginMetadata(metadata);
  if (!metadata && !$('login-username').value) request('/api/session').catch(error => setLoginMetadata(error.login));
  requestAnimationFrame(() => $('login-password').focus());
}

async function request(path, { body, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once:true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  try {
    const response = await fetch(path, {
      method:body === undefined ? 'GET' : 'POST',
      credentials:'same-origin',
      cache:'no-store',
      redirect:'error',
      headers:body === undefined ? { Accept:'application/json' } : { Accept:'application/json', 'Content-Type':'application/json' },
      body:body === undefined ? undefined : JSON.stringify(body),
      signal:controller.signal
    });
    if (!response.ok) {
      const error = new Error(
        response.status === 401 ? (path === '/api/login' ? '密码不正确，请重新输入。' : '登录已过期，请重新登录。') :
        response.status === 403 ? '当前账号无权查看这些数据。' :
        response.status === 429 ? '尝试过于频繁，请稍后再试。' :
        response.status >= 500 ? '统计服务暂时不可用，请稍后重试。' : '查询未能完成，请检查筛选条件后重试。'
      );
      error.status = response.status;
      if (response.status === 401 && path === '/api/session') {
        try { error.login = (await response.json()).login; } catch { /* Optional public login metadata. */ }
      }
      if (response.status === 401 && path !== '/api/login' && path !== '/api/session') showLogin(error.message);
      throw error;
    }
    if (response.status === 204) return null;
    if (!(response.headers.get('content-type') || '').includes('application/json')) throw new Error('统计服务返回了无法识别的结果，请稍后重试。');
    return await response.json();
  } catch (error) {
    if (timedOut) throw new Error('查询超时，请稍后重试。');
    if (error.name === 'TypeError') throw new Error('无法连接统计服务，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function queryFor(scope) {
  if (scope === 'overview') return state.overview;
  if (scope === 'detail') return state.detail;
  return state.cards[Number(scope.slice(5))];
}

function setQuery(scope, query) {
  if (scope === 'overview') state.overview = query;
  else if (scope === 'detail') state.detail = query;
  else state.cards[Number(scope.slice(5))] = query;
  saveState();
}

function formFor(scope) { return $(scope === 'overview' ? 'overview-form' : scope === 'detail' ? 'detail-form' : scope + '-form'); }
function outputFor(scope) { return $(scope === 'overview' ? 'overview-report' : scope === 'detail' ? 'detail-report' : scope + '-report'); }

function queryString(query, daily = false, wholeHub = false) {
  const params = new URLSearchParams({ start:query.start, end:query.end, compare:String(query.compare) });
  if (!wholeHub) {
    for (const name of ['categories','topics','targets']) if (query[name]?.length) params.set(name, query[name].join(','));
    if (query.q) params.set('q', query.q);
  }
  if (daily) {
    for (const name of ['minClicks','includeZero','sort','direction','page','pageSize']) params.set(name, String(query[name]));
  } else params.set('grain', query.grain);
  return params.toString();
}

function presetMarkup(compact = false) {
  return '<div class="presets" aria-label="日期快捷选择">' + presetOptions.filter(item => !compact || item[0] !== 'last7').map(item =>
    '<button type="button" data-preset="' + item[0] + '">' + item[1] + '</button>').join('') + '</div>';
}

function dateMarkup(scope, query, { daily = false } = {}) {
  return '<div class="date-controls">' +
    '<label>开始日期<input name="start" type="date" required value="' + escape(query.start) + '"></label>' +
    '<label>结束日期<input name="end" type="date" required value="' + escape(query.end) + '"></label>' +
    (!daily ? '<label>趋势<select name="grain"><option value="day"' + (query.grain === 'day' ? ' selected' : '') + '>按日</option><option value="week"' + (query.grain === 'week' ? ' selected' : '') + '>按周</option><option value="month"' + (query.grain === 'month' ? ' selected' : '') + '>按月</option></select></label>' : '') +
    '<label class="compare-field">对比<select name="compare"><option value="true"' + (query.compare ? ' selected' : '') + '>前一等长区间</option><option value="false"' + (!query.compare ? ' selected' : '') + '>不对比</option></select></label>' +
    '<button type="submit" class="primary-button">查询</button></div>' +
    '<div class="range-description" data-range-description></div>' +
    '<p class="form-error error-message" role="alert" hidden></p>' +
    '<p class="form-dirty neutral" hidden>筛选已修改，点击「查询」更新结果。</p>';
}

function pickerMarkup(name, label, items, selected) {
  return '<details class="picker" data-picker="' + name + '"><summary><span>' + escape(label) + '</span></summary><div class="picker-options">' +
    '<button type="button" data-clear-picker="' + name + '">全部' + escape(label) + '</button>' +
    (items.length ? items.map(item => '<label><input type="checkbox" name="' + name + '" value="' + escape(item.id) + '"' + (selected.includes(item.id) ? ' checked' : '') + '><span>' + escape(item.name) + '</span></label>').join('') : '<span class="picker-empty">暂无可选' + escape(label) + '</span>') +
    '<button type="button" class="picker-done" data-close-picker>完成选择</button></div></details>';
}

function objectMarkup(query) {
  return '<fieldset class="object-row"><legend>分析对象</legend>' +
    pickerMarkup('categories', '类型', catalog.categories, query.categories) +
    pickerMarkup('topics', '话题', catalog.topics, query.topics) +
    pickerMarkup('targets', '目标', catalog.targets, query.targets) +
    '</fieldset>';
}

function setupForms() {
  $('overview-form').innerHTML = '<div class="query-heading"><div><strong>整个 Hub</strong><small>独立日期 · 北京时间</small></div>' + presetMarkup() + '</div>' + dateMarkup('overview', state.overview);
  $('analysis-cards').innerHTML = state.cards.map((query, index) => {
    const scope = 'card-' + index;
    return '<article class="panel analysis-card' + (query.expanded ? ' expanded' : '') + '" id="' + scope + '">' +
      '<div class="card-heading"><h2 id="' + scope + '-title">' + escape(cardDefaults[index].title) + '</h2><div class="card-actions">' +
      '<button class="text-button" type="button" data-open-detail="' + index + '">查看明细 ↗</button>' +
      '<button class="text-button" type="button" data-expand="' + index + '" aria-expanded="' + query.expanded + '">' + (query.expanded ? '收起' : '展开') + '</button></div></div>' +
      '<form class="card-query" id="' + scope + '-form">' + objectMarkup(query) +
      '<div class="card-date-heading">' + presetMarkup(true) + '<button class="text-button" type="button" data-copy-dates>复制总览日期</button></div>' +
      dateMarkup(scope, query) + '</form><div class="card-report" id="' + scope + '-report" aria-live="polite"></div></article>';
  }).join('');
  $('detail-form').innerHTML = '<div class="query-heading"><div><strong>每日 × 目标</strong><small>筛选结果独立于总览</small></div>' + presetMarkup() + '</div>' +
    '<div class="detail-filters">' + objectMarkup(state.detail) +
    '<label class="field-label">内容关键词<input type="search" name="q" maxlength="256" placeholder="搜索目标名称或链接" value="' + escape(state.detail.q) + '"></label></div>' +
    dateMarkup('detail', state.detail, { daily:true }) +
    '<div class="detail-options"><label class="checkbox-label"><input type="checkbox" name="positiveOnly"' + (!state.detail.includeZero ? ' checked' : '') + '>只看有点击的记录</label>' +
    '<label class="field-label">最低点击<input type="number" name="minClicks" min="0" step="1" value="' + state.detail.minClicks + '"></label>' +
    '<label class="field-label">排序<select name="sort">' + [['date','日期'],['clicks','有效点击'],['delta','增减量'],['percent','变化比例'],['name','目标名称']].map(item => '<option value="' + item[0] + '"' + (state.detail.sort === item[0] ? ' selected' : '') + '>' + item[1] + '</option>').join('') + '</select></label>' +
    '<label class="field-label">顺序<select name="direction"><option value="desc"' + (state.detail.direction === 'desc' ? ' selected' : '') + '>从高到低 / 从新到旧</option><option value="asc"' + (state.detail.direction === 'asc' ? ' selected' : '') + '>从低到高 / 从旧到新</option></select></label>' +
    '<label class="field-label">每页<select name="pageSize"><option value="25"' + (state.detail.pageSize === 25 ? ' selected' : '') + '>25 条</option><option value="50"' + (state.detail.pageSize === 50 ? ' selected' : '') + '>50 条</option></select></label></div>';
  for (const scope of ['overview', ...state.cards.map((_, i) => 'card-' + i), 'detail']) bindForm(scope);
}

function updatePickerLabels(form) {
  const labels = { categories:'类型', topics:'话题', targets:'目标' };
  for (const details of form.querySelectorAll('.picker')) {
    const name = details.dataset.picker;
    const checked = [...details.querySelectorAll('input:checked')];
    const label = checked.length === 0 ? '全部' + labels[name] : checked.length === 1 ? checked[0].nextElementSibling.textContent : checked.length + ' 个' + labels[name];
    details.querySelector('summary span').textContent = label;
  }
}

function updateRangeDescription(form, query) {
  const checked = range(query.start, query.end);
  const prior = query.compare ? previousRange(checked) : null;
  form.querySelector('[data-range-description]').innerHTML =
    '<span>当前结果：' + shortDate(checked.start) + ' — ' + shortDate(checked.end) + ' · ' + checked.days + ' 天</span>' +
    '<span>' + (prior ? '对比：' + shortDate(prior.start) + ' — ' + shortDate(prior.end) + ' · ' + prior.days + ' 天' : '未开启对比') + '</span>';
}

function readForm(scope, resetPage = true) {
  const form = formFor(scope), data = new FormData(form), existing = queryFor(scope);
  const dates = range(String(data.get('start') || ''), String(data.get('end') || ''));
  const query = { ...existing, ...dates, compare:data.get('compare') === 'true' };
  if (scope !== 'overview') {
    for (const key of ['categories','topics','targets']) query[key] = data.getAll(key).map(String);
    query.q = String(data.get('q') || '').trim();
  }
  if (scope === 'detail') {
    const minimum = Number(data.get('minClicks'));
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('最低点击应为大于或等于 0 的整数。');
    query.includeZero = !data.has('positiveOnly');
    query.minClicks = minimum;
    query.sort = String(data.get('sort'));
    query.direction = String(data.get('direction'));
    query.pageSize = Number(data.get('pageSize'));
    if (resetPage) query.page = 1;
  } else query.grain = String(data.get('grain'));
  return query;
}

function formError(scope, error) {
  const node = formFor(scope).querySelector('.form-error');
  node.textContent = error?.message || '';
  node.hidden = !error;
}

function applyForm(scope) {
  try {
    const query = readForm(scope);
    setQuery(scope, query);
    const form = formFor(scope);
    formError(scope, null);
    form.querySelector('.form-dirty').hidden = true;
    form.querySelectorAll('details').forEach(details => { details.open = false; });
    updateRangeDescription(form, query);
    if (scope.startsWith('card-')) updateCardTitle(Number(scope.slice(5)));
    loadScope(scope);
    return query;
  } catch (error) { formError(scope, error); return null; }
}

function bindForm(scope) {
  const form = formFor(scope);
  form.addEventListener('submit', event => { event.preventDefault(); applyForm(scope); });
  form.addEventListener('input', () => { form.querySelector('.form-dirty').hidden = false; });
  form.addEventListener('change', event => {
    updatePickerLabels(form);
    if (['grain','compare','sort','direction','pageSize'].includes(event.target.name)) applyForm(scope);
    else form.querySelector('.form-dirty').hidden = false;
  });
  form.addEventListener('click', event => {
    const preset = event.target.closest('[data-preset]');
    const copy = event.target.closest('[data-copy-dates]');
    const clear = event.target.closest('[data-clear-picker]');
    const close = event.target.closest('[data-close-picker]');
    if (preset || copy) {
      const dates = copy ? { ...state.overview } : presetRange(preset.dataset.preset);
      form.elements.start.value = dates.start;
      form.elements.end.value = dates.end;
      applyForm(scope);
    }
    if (clear) {
      clear.closest('details').querySelectorAll('input').forEach(input => { input.checked = false; });
      updatePickerLabels(form);
      form.querySelector('.form-dirty').hidden = false;
    }
    if (close) {
      const details = close.closest('details');
      details.open = false;
      details.querySelector('summary').focus();
    }
  });
  updatePickerLabels(form);
  updateRangeDescription(form, queryFor(scope));
}

function updateCardTitle(index) {
  const query = state.cards[index];
  const title = query.targets.length === 1 ? targetById.get(query.targets[0])?.name || '目标分析' :
    query.categories.length === 1 ? categoryById.get(query.categories[0]) || cardDefaults[index].title :
    query.categories.length > 1 ? '多类型分析' : '全部出站';
  $('card-' + index + '-title').textContent = title;
}

function coverageMarkup(report, compare) {
  const status = report.coverage?.status;
  let message = '';
  if (status === 'none') message = '所选区间暂无采集数据，未采集的历史不会显示为零。';
  else if (status === 'partial') message = '所选区间只有部分日期有采集数据。当前显示已采集总量，暂不计算涨跌。';
  else if (status !== 'complete') message = '采集覆盖范围尚未确认，暂不计算涨跌。';
  else if (compare && report.coverage?.previousStatus !== 'complete') message = '上期暂无完整数据，当前区间正常展示，暂不计算涨跌。';
  return message ? '<div class="notice">' + escape(message) + '</div>' : '';
}

function comparable(report, query) { return query.compare && report.coverage?.status === 'complete' && report.coverage?.previousStatus === 'complete'; }

function change(current, previous, allowed) {
  if (!allowed || !numeric(current) || !numeric(previous)) return { text:'暂无完整对比', tone:'neutral' };
  if (previous === 0) return { text:current === 0 ? '与上期持平' : '上期为 0', tone:'neutral' };
  const percent = (current - previous) / previous * 100;
  return Math.abs(percent) < .05 ? { text:'与上期持平', tone:'neutral' } :
    { text:(percent > 0 ? '+' : '−') + Math.abs(percent).toFixed(1) + '%', tone:percent > 0 ? 'up' : 'down' };
}

function comparisonMarkup(current, previous, report, query) {
  if (!query.compare) return '<span class="neutral">未开启对比</span>';
  const result = change(current, previous, comparable(report, query));
  return '<span class="' + result.tone + '">' + result.text + '</span><small>上期 ' + number(previous) + '</small>';
}

function metricMarkup(label, icon, color, value, previous, help, report, query) {
  return '<section class="metric-card"><div class="metric-label"><span class="metric-icon ' + color + '">' + icon + '</span>' + label + '</div>' +
    '<div class="metric-row"><div class="metric-value' + (numeric(value) ? '' : ' missing') + '">' + number(value) + '</div>' +
    '<div class="metric-comparison">' + comparisonMarkup(value, previous, report, query) + '</div></div><p>' + help + '</p></section>';
}

function seriesConfig(whole, compare) {
  const list = whole ? [{ key:'visits', label:'有效访问', color:'#e51c3b' }, { key:'clicks', label:'有效出站', color:'#4777b5' }] :
    [{ key:'clicks', label:'有效出站', color:'#e51c3b' }];
  if (compare) list.push(...(whole ? [
    { key:'previousVisits', label:'上期访问', color:'#cb929e', dashed:true },
    { key:'previousClicks', label:'上期出站', color:'#93b1d3', dashed:true }
  ] : [{ key:'previousClicks', label:'上期出站', color:'#cb929e', dashed:true }]));
  return list;
}

function chartMarkup(scope, series, config, query) {
  const chartId = scope + '-chart';
  charts.set(chartId, { series, config, selected:0 });
  const legend = '<div class="legend">' + config.map(item => '<span><svg width="17" height="5" aria-hidden="true"><line x1="0" x2="17" y1="2" y2="2" stroke="' + item.color + '" stroke-width="2"' + (item.dashed ? ' stroke-dasharray="4 3"' : '') + '/></svg>' + item.label + '</span>').join('') + '</div>';
  if (!series.length || !series.some(row => config.some(item => numeric(row[item.key])))) return legend + '<div class="chart-empty">这个区间暂无趋势数据</div>';
  const W = 800, H = 245, left = 45, right = 18, top = 18, bottom = 36, pw = W - left - right, ph = H - top - bottom;
  const maximum = Math.max(1, ...series.flatMap(row => config.map(item => numeric(row[item.key]) ? row[item.key] : 0)));
  const step = maximum <= 20 ? 5 : maximum <= 100 ? 25 : Math.ceil(maximum / 200) * 50;
  const ceiling = Math.ceil(maximum / step) * step;
  const x = index => series.length === 1 ? left + pw / 2 : left + index / (series.length - 1) * pw;
  const y = value => top + ph - value / ceiling * ph;
  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const value = Math.round(ceiling * i / 4);
    svg += '<line x1="' + left + '" x2="' + (W - right) + '" y1="' + y(value) + '" y2="' + y(value) + '" stroke="#edf0f4" stroke-dasharray="3 5"/><text x="' + (left - 10) + '" y="' + (y(value) + 3) + '" text-anchor="end" fill="#9ba5b2" font-size="10">' + value + '</text>';
  }
  const ticks = Math.min(series.length, window.innerWidth < 660 ? 3 : 6);
  for (let i = 0; i < ticks; i++) {
    const index = ticks === 1 ? 0 : Math.round(i / (ticks - 1) * (series.length - 1));
    svg += '<text x="' + x(index) + '" y="' + (H - 12) + '" text-anchor="middle" fill="#9ba5b2" font-size="10">' + escape(String(series[index].start).slice(5).replace('-', '/')) + '</text>';
  }
  for (const item of config) {
    let path = '', continuing = false;
    series.forEach((row, index) => {
      const value = row[item.key];
      if (!numeric(value)) { continuing = false; return; }
      path += (continuing ? ' L' : ' M') + x(index).toFixed(2) + ',' + y(value).toFixed(2);
      continuing = true;
    });
    if (path) svg += '<path d="' + path + '" stroke="' + item.color + '" stroke-width="' + (item.dashed ? '1.6' : '2.2') + '"' + (item.dashed ? ' stroke-dasharray="5 5"' : '') + ' fill="none" stroke-linejoin="round"/>';
    series.forEach((row, index) => {
      if (numeric(row[item.key])) svg += '<circle cx="' + x(index) + '" cy="' + y(row[item.key]) + '" r="' + (series.length < 20 ? 2.7 : 1.3) + '" fill="' + item.color + '"/>';
    });
  }
  series.forEach((row, index) => {
    const width = pw / Math.max(series.length - 1, 1);
    svg += '<rect data-point="' + index + '" x="' + Math.max(left, x(index) - width / 2) + '" y="' + top + '" width="' + Math.max(3, Math.min(width, W - right - Math.max(left, x(index) - width / 2))) + '" height="' + ph + '" fill="transparent"/>';
  });
  return legend + '<div class="chart"><svg id="' + chartId + '" data-chart="' + chartId + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" tabindex="0" aria-label="' + escape(query.start + ' 至 ' + query.end + ' 趋势，使用左右方向键查看具体数据') + '">' + svg + '</svg>' +
    '<div class="chart-readout" id="' + chartId + '-readout">' + (query.compare ? '悬停或聚焦图表查看具体日期与数值；上期按前一等长区间对应展示。' : '悬停或聚焦图表查看具体日期与数值。') + '</div></div>';
}

function reportSeries(report) {
  return report.series.map(row => ({ ...row, start:row.start || row.date, end:row.end || row.start || row.date }));
}

function renderOverview(report, query) {
  const summary = report.summary;
  outputFor('overview').innerHTML = coverageMarkup(report, query.compare) +
    '<div class="kpi-grid">' +
    metricMarkup('输入 · 有效访问', '↘', 'red', summary.visits, summary.previousVisits, '按访次计数。', report, query) +
    metricMarkup('输出 · 有效出站', '↗', 'blue', summary.clicks, summary.previousClicks, '同次访问、同一目标计一次。', report, query) + '</div>' +
    '<section class="panel trend-panel"><div class="panel-title"><div><h2>整个 Hub 的访问与出站</h2><p>不受下方分析卡筛选影响</p></div></div>' +
    chartMarkup('overview', reportSeries(report), seriesConfig(true, query.compare), query) + '</section>';
}

function renderCard(index, report, query) {
  const scope = 'card-' + index;
  const top = report.top.slice(0, query.targets.length === 1 ? 1 : 3);
  const ranks = top.length ? top.map((row, rank) => {
    const target = targetById.get(row.targetId);
    const delta = change(row.count, row.previousCount, comparable(report, query));
    return '<button type="button" class="rank-item" data-rank-card="' + index + '" data-target="' + escape(row.targetId) + '">' +
      '<div class="rank-line"><span class="rank-name"><b>' + String(rank + 1).padStart(2, '0') + '</b>' + escape(target?.name || '未命名目标') + '</span><span class="rank-count">' + number(row.count) + '</span></div>' +
      (query.compare ? '<div class="rank-prior"><span>同目标上期 ' + number(row.previousCount) + '</span><span class="' + delta.tone + '">' + delta.text + '</span></div>' : '') + '</button>';
  }).join('') : '<div class="empty-state">' + (report.coverage?.status === 'none' ? '这个区间暂无数据' : '没有匹配的点击记录') + '</div>';
  outputFor(scope).innerHTML = coverageMarkup(report, query.compare) +
    '<div class="card-summary"><div><span>有效出站合计</span><div class="metric-value' + (numeric(report.summary.clicks) ? '' : ' missing') + '">' + number(report.summary.clicks) + '</div></div>' +
    '<div class="metric-comparison">' + comparisonMarkup(report.summary.clicks, report.summary.previousClicks, report, query) + '</div></div>' +
    chartMarkup(scope, reportSeries(report), seriesConfig(false, query.compare), query) +
    '<section class="ranking"><div class="ranking-heading"><h3>' + (query.targets.length === 1 ? '所选目标' : '本期 TOP 3') + '</h3><span>按本期有效点击排名</span></div>' + ranks + '</section>';
}

function signed(value) { return numeric(value) ? (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toLocaleString('zh-CN') : '—'; }

function sortHeading(label, field, query, numericColumn = false) {
  const active = query.sort === field;
  return '<th' + (numericColumn ? ' class="numeric"' : '') + (active ? ' aria-sort="' + (query.direction === 'asc' ? 'ascending' : 'descending') + '"' : '') + '><button type="button" data-sort="' + field + '">' + label + (active ? query.direction === 'asc' ? ' ↑' : ' ↓' : '') + '</button></th>';
}

function renderDetail(report, query) {
  const allowed = comparable(report, query);
  const rows = report.rows.map(row => {
    const target = targetById.get(row.targetId);
    const category = target ? categoryById.get(target.category) : '';
    const delta = allowed ? row.delta : null;
    const percent = allowed && numeric(row.percent) ? signed(Math.round(row.percent * 10) / 10) + '%' :
      !query.compare ? '—' : allowed && row.previousCount === 0 ? '上期为 0' : '暂无完整对比';
    return '<tr><td>' + shortDate(row.date) + '</td><td><strong>' + escape(target?.name || '未命名目标') + '</strong><small>' + escape([category, target?.channel].filter(Boolean).join(' · ')) + '</small></td>' +
      '<td class="numeric">' + number(row.count) + '</td><td class="numeric">' + (query.compare ? number(row.previousCount) : '—') +
      (query.compare && row.previousDate ? '<small>' + shortDate(row.previousDate) + '</small>' : '') + '</td>' +
      '<td class="numeric">' + signed(delta) + '</td><td class="numeric ' + (numeric(delta) && delta > 0 ? 'up' : numeric(delta) && delta < 0 ? 'down' : 'neutral') + '">' + percent + '</td></tr>';
  }).join('');
  const pages = Math.max(1, Math.ceil(report.totalRows / report.pageSize));
  const series = report.series.map(row => ({
    start:row.date, end:row.date, clicks:row.count,
    previousStart:row.previousDate, previousEnd:row.previousDate, previousClicks:row.previousCount
  }));
  outputFor('detail').innerHTML = coverageMarkup(report, query.compare) +
    '<div class="panel detail-summary"><span><strong>' + number(report.summary.clicks) + '</strong>有效出站</span><span><strong>' + number(report.summary.targets) + '</strong>个目标</span><span>' + number(report.totalRows) + ' 条每日记录</span><small>合计覆盖全部匹配结果，不随翻页变化</small></div>' +
    '<section class="panel trend-panel"><div class="panel-title"><h2>筛选后的每日趋势</h2></div>' + chartMarkup('detail', series, seriesConfig(false, query.compare), query) + '</section>' +
    '<section class="panel table-panel"><div class="table-scroll"><table><thead><tr>' +
    sortHeading('日期','date',query) + sortHeading('目标','name',query) + sortHeading('有效点击','clicks',query,true) +
    '<th class="numeric">同目标对应上期</th>' + sortHeading('增减量','delta',query,true) + sortHeading('变化比例','percent',query,true) +
    '</tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="empty-state">' + (report.coverage?.status === 'none' ? '这个区间暂无采集数据。' : '没有匹配记录，请调整筛选条件。') + '</td></tr>') +
    '</tbody></table></div><div class="pagination"><span>共 ' + number(report.totalRows) + ' 条 · 每页 ' + report.pageSize + ' 条</span><div>' +
    '<button type="button" data-page-change="-1"' + (report.page <= 1 ? ' disabled' : '') + '>上一页</button><span>第 ' + report.page + ' / ' + pages + ' 页</span>' +
    '<button type="button" data-page-change="1"' + (report.page >= pages ? ' disabled' : '') + '>下一页</button></div></div></section>';
}

function checkReport(report, query, daily) {
  if (!report || !report.period || !report.summary || !Array.isArray(report.series) || report.period.start !== query.start || report.period.end !== query.end) {
    throw new Error('返回的统计区间或数据格式不完整，请重试。');
  }
  if (daily ? !Array.isArray(report.rows) || !Number.isInteger(report.totalRows) || !Number.isInteger(report.page) || !Number.isInteger(report.pageSize) :
    !Array.isArray(report.top)) throw new Error('统计结果格式不完整，请重试。');
  const count = value => value === null || (numeric(value) && value >= 0);
  if (!['live','demo'].includes(report.mode) || !count(report.summary.clicks) ||
    (daily ? !count(report.summary.targets) : !count(report.summary.visits)) ||
    (!daily && query.compare && (!count(report.summary.previousVisits) || !count(report.summary.previousClicks)))) {
    throw new Error('统计结果格式不完整，请重试。');
  }
}

async function loadScope(scope) {
  if (!session) return;
  requests.get(scope)?.controller.abort();
  const requestState = { controller:new AbortController() };
  requests.set(scope, requestState);
  const query = structuredClone(queryFor(scope));
  const output = outputFor(scope);
  output.setAttribute('aria-busy','true');
  output.innerHTML = '<div class="loading" role="status">正在查询…</div>';
  try {
    const daily = scope === 'detail';
    const report = await request((daily ? '/api/outbound/daily?' : '/api/report?') + queryString(query, daily, scope === 'overview'), { signal:requestState.controller.signal });
    if (requests.get(scope) !== requestState || !session) return;
    checkReport(report, query, daily);
    reports.set(scope, report);
    if (report.mode === 'demo') $('demo-notice').hidden = false;
    if (daily) {
      state.detail.page = report.page;
      saveState();
      renderDetail(report, query);
    } else if (scope === 'overview') renderOverview(report, query);
    else renderCard(Number(scope.slice(5)), report, query);
  } catch (error) {
    if (requests.get(scope) !== requestState || !session || error.name === 'AbortError') return;
    output.innerHTML = '<div class="error-state" role="alert"><p>' + escape(error.message) + '</p><button type="button" class="secondary-button" data-retry="' + scope + '">重新查询</button></div>';
  } finally {
    if (requests.get(scope) === requestState) {
      output.removeAttribute('aria-busy');
      requests.delete(scope);
    }
  }
}

function showChartPoint(chartId, index) {
  const entry = charts.get(chartId);
  if (!entry?.series.length) return;
  entry.selected = Math.max(0, Math.min(entry.series.length - 1, index));
  const row = entry.series[entry.selected];
  const currentDates = shortDate(row.start) + (row.end !== row.start ? ' — ' + shortDate(row.end) : '');
  const previousDates = entry.config.some(item => item.dashed) && row.previousStart ? shortDate(row.previousStart) + (row.previousEnd && row.previousEnd !== row.previousStart ? ' — ' + shortDate(row.previousEnd) : '') : '';
  const values = entry.config.map(item => item.label + ' ' + number(row[item.key])).join(' · ');
  const readout = $(chartId + '-readout');
  if (readout) readout.textContent = currentDates + '：' + values + (previousDates ? '；对应上期 ' + previousDates : '');
}

function syncDetailForm() {
  const form = formFor('detail'), query = state.detail;
  form.elements.start.value = query.start;
  form.elements.end.value = query.end;
  form.elements.compare.value = String(query.compare);
  form.elements.q.value = query.q;
  form.elements.minClicks.value = query.minClicks;
  form.elements.positiveOnly.checked = !query.includeZero;
  form.elements.sort.value = query.sort;
  form.elements.direction.value = query.direction;
  form.elements.pageSize.value = String(query.pageSize);
  for (const key of ['categories','topics','targets']) form.querySelectorAll('input[name="' + key + '"]').forEach(input => { input.checked = query[key].includes(input.value); });
  updatePickerLabels(form);
  updateRangeDescription(form, query);
  form.querySelector('.form-dirty').hidden = true;
  formError('detail', null);
}

function openCardDetail(index, targetId = null) {
  const scope = 'card-' + index;
  let query;
  try { query = readForm(scope); }
  catch (error) { formError(scope, error); return; }
  if (JSON.stringify(query) !== JSON.stringify(queryFor(scope))) query = applyForm(scope);
  if (!query) return;
  state.detail = { ...state.detail, ...structuredClone(query), targets:targetId ? [targetId] : [...query.targets],
    minClicks:0, includeZero:false, sort:'date', direction:'desc', page:1 };
  delete state.detail.expanded;
  saveState();
  syncDetailForm();
  location.hash = 'outbound';
  loadScope('detail');
}

function updateRoute() {
  if (!initialized) return;
  const page = location.hash === '#outbound' ? 'outbound' : 'overview';
  if (previousPage === 'overview' && page !== 'overview') state.overviewScroll = window.scrollY;
  $('overview-page').hidden = page !== 'overview';
  $('outbound-page').hidden = page !== 'outbound';
  $('page-title').textContent = page === 'overview' ? '总览' : '出站明细';
  $('page-description').textContent = page === 'overview' ? '有多少次有效访问，又分别去了哪些入口。' : '按日期和目标查看有效出站，筛选、比较与逐条核对。';
  document.querySelectorAll('[data-page]').forEach(link => {
    const active = link.dataset.page === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  });
  if (page === 'outbound' && !reports.has('detail') && !requests.has('detail')) loadScope('detail');
  requestAnimationFrame(() => window.scrollTo({ top:page === 'overview' ? state.overviewScroll : 0, behavior:'instant' }));
  previousPage = page;
  saveState();
}

async function enterApplication() {
  const metadata = await request('/api/session');
  if (metadata?.authenticated !== true || metadata.role !== 'viewer' || !['live','demo'].includes(metadata.mode)) throw new Error('登录状态无法确认，请重新登录。');
  const incoming = await request('/api/catalog');
  if (!incoming || !Array.isArray(incoming.categories) || !Array.isArray(incoming.topics) || !Array.isArray(incoming.targets)) throw new Error('目标信息暂时无法加载，请稍后重试。');
  session = metadata;
  catalog = incoming;
  targetById.clear(); categoryById.clear();
  for (const target of catalog.targets) targetById.set(target.id, target);
  for (const category of catalog.categories) categoryById.set(category.id, category.name);
  $('startup').hidden = true;
  $('login-screen').hidden = true;
  $('application').hidden = false;
  $('demo-notice').hidden = session.mode !== 'demo';
  $('app-error').hidden = true;
  setupForms();
  state.cards.forEach((_, index) => updateCardTitle(index));
  initialized = true;
  previousPage = null;
  updateRoute();
  loadScope('overview');
  state.cards.forEach((_, index) => loadScope('card-' + index));
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('login-error').hidden = true;
  try {
    await request('/api/login', { body:{ password:$('login-password').value } });
    $('login-password').value = '';
    await enterApplication();
  } catch (error) {
    $('login-error').textContent = error.message;
    $('login-error').hidden = false;
  } finally { button.disabled = false; }
});

$('logout-button').addEventListener('click', async () => {
  $('logout-button').disabled = true;
  try {
    await request('/api/logout', { body:{} });
    $('login-password').value = '';
    showLogin();
  } catch (error) {
    if (session) {
      $('app-error').textContent = '退出未能完成：' + error.message;
      $('app-error').hidden = false;
    }
  } finally { $('logout-button').disabled = false; }
});

document.addEventListener('click', event => {
  for (const details of document.querySelectorAll('details.picker[open]')) if (!details.contains(event.target)) details.open = false;
  const expand = event.target.closest('[data-expand]');
  if (expand) {
    const index = Number(expand.dataset.expand);
    state.cards[index].expanded = !state.cards[index].expanded;
    $('card-' + index).classList.toggle('expanded', state.cards[index].expanded);
    expand.setAttribute('aria-expanded', String(state.cards[index].expanded));
    expand.textContent = state.cards[index].expanded ? '收起' : '展开';
    saveState();
  }
  const detail = event.target.closest('[data-open-detail]');
  if (detail) openCardDetail(Number(detail.dataset.openDetail));
  const rank = event.target.closest('[data-rank-card]');
  if (rank) openCardDetail(Number(rank.dataset.rankCard), rank.dataset.target);
  const retry = event.target.closest('[data-retry]');
  if (retry) loadScope(retry.dataset.retry);
  const sorting = event.target.closest('[data-sort]');
  if (sorting) {
    const form = formFor('detail');
    const same = form.elements.sort.value === sorting.dataset.sort;
    form.elements.sort.value = sorting.dataset.sort;
    form.elements.direction.value = same && form.elements.direction.value === 'desc' ? 'asc' : 'desc';
    applyForm('detail');
  }
  const page = event.target.closest('[data-page-change]');
  if (page && !page.disabled) {
    state.detail.page = Math.max(1, state.detail.page + Number(page.dataset.pageChange));
    saveState();
    loadScope('detail');
  }
});

document.addEventListener('pointermove', event => {
  const point = event.target.closest?.('[data-point]');
  const chart = point?.closest('[data-chart]');
  if (chart) showChartPoint(chart.dataset.chart, Number(point.dataset.point));
});
document.addEventListener('focusin', event => {
  const chart = event.target.closest?.('[data-chart]');
  if (chart) showChartPoint(chart.dataset.chart, charts.get(chart.dataset.chart)?.selected || 0);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    const details = event.target.closest?.('details.picker[open]');
    if (details) { details.open = false; details.querySelector('summary').focus(); }
  }
  const chart = event.target.closest?.('[data-chart]');
  const entry = chart && charts.get(chart.dataset.chart);
  if (entry && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? entry.series.length - 1 : entry.selected + (event.key === 'ArrowRight' ? 1 : -1);
    showChartPoint(chart.dataset.chart, index);
  }
});
window.addEventListener('hashchange', updateRoute);
window.addEventListener('pagehide', saveState);

enterApplication().catch(error => showLogin(error.status === 401 ? '' : error.message, error.login));
