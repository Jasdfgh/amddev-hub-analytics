const DAY = 86400000;

export function parseDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('请选择完整的开始日期和结束日期。');
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('日期无效，请重新选择。');
  return time;
}

export function addDays(value, count) {
  return new Date(parseDay(value) + count * DAY).toISOString().slice(0, 10);
}

export function range(start, end) {
  const begin = parseDay(start), finish = parseDay(end);
  if (finish < begin) throw new Error('结束日期不能早于开始日期。');
  return { start, end, days: Math.round((finish - begin) / DAY) + 1 };
}

export function previousRange(current) {
  const checked = range(current.start, current.end);
  return range(addDays(checked.start, -checked.days), addDays(checked.start, -1));
}

export function todayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  return part('year') + '-' + part('month') + '-' + part('day');
}

export function presetRange(preset, today = todayShanghai()) {
  const date = new Date(parseDay(today));
  const monday = addDays(today, -((date.getUTCDay() + 6) % 7));
  const first = today.slice(0, 8) + '01';
  if (preset === 'thisweek') return range(monday, today);
  if (preset === 'lastweek') return range(addDays(monday, -7), addDays(monday, -1));
  if (preset === 'thismonth') return range(first, today);
  if (preset === 'lastmonth') {
    const last = addDays(first, -1);
    return range(last.slice(0, 8) + '01', last);
  }
  return range(addDays(today, -6), today);
}
