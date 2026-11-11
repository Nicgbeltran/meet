// Booking page front end. Talks to the Apps Script web app at API.
const API = 'https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec';
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const MOCK = LOCAL && new URLSearchParams(location.search).has('mock');
const NOT_READY = !MOCK && API.includes('REPLACE_WITH');

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = {
  durations: [15, 30, 45, 60, 90, 120, 150, 180, 240],
  duration: 30,
  maxDaysAhead: 60,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
  month: null,          // { y, m } in the viewer's time zone
  byDay: new Map(),     // 'yyyy-mm-dd' -> [ms]
  day: null,
  slot: null,
  token: params.get('booking'),
  booking: null,        // the booking being managed
  rescheduling: false,
  loadId: 0,
};

// ---------- API ----------

async function api(params, body) {
  if (MOCK) return mockApi(params, body);
  if (NOT_READY) throw new Error('This booking page is still being set up. Please check back soon.');
  const url = body ? API : API + '?' + new URLSearchParams(params);
  const res = await fetch(url, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- dates in the viewer's time zone ----------

const fmtCache = {};
function fmt(opts) {
  const key = state.tz + JSON.stringify(opts);
  return fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat(undefined, { timeZone: state.tz, ...opts }));
}
function dayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
const timeLabel = (ms) => fmt({ hour: 'numeric', minute: '2-digit' }).format(ms);
const longDate = (ms) => fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(ms);
const lengthLabel = (min) => (min < 60 ? `${min} min` : `${min / 60} h`.replace('.5 h', '½ h').replace(/^0½/, '½'));
function whenLabel(start, end) {
  return `${longDate(start)}, ${timeLabel(start)} – ${timeLabel(end)}`;
}

// ---------- picker ----------

function renderDurations() {
  $('durations').innerHTML = state.durations.map((d) =>
    `<button type="button" class="chip" role="radio" aria-checked="${d === state.duration}" data-d="${d}">${lengthLabel(d)}</button>`
  ).join('');
  $('durations').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    if (state.rescheduling) return;
    state.duration = Number(b.dataset.d);
    renderDurations();
    loadMonth();
  }));
}

function renderTz() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { zones = [state.tz]; }
  if (!zones.includes(state.tz)) zones.unshift(state.tz);
  $('tz').innerHTML = zones.map((z) => `<option ${z === state.tz ? 'selected' : ''}>${z}</option>`).join('');
  $('tz').addEventListener('change', () => { state.tz = $('tz').value; loadMonth(); });
}

function thisMonth() {
  const [y, m] = dayKey(Date.now()).split('-').map(Number);
  return { y, m: m - 1 };
}

async function loadMonth() {
  const id = ++state.loadId;
  const { y, m } = state.month;
  $('month-title').textContent = new Date(Date.UTC(y, m, 15)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const now = thisMonth();
  $('prev').disabled = y === now.y && m === now.m;
  const lastAllowed = dayKey(Date.now() + state.maxDaysAhead * 86400000);
  $('next').disabled = `${y}-${String(m + 1).padStart(2, '0')}` >= lastAllowed.slice(0, 7);
  state.byDay = new Map();
  renderGrid();
  $('pick-status').textContent = 'Finding open times…';
  $('times').innerHTML = '';
  $('day-title').textContent = '';
  try {
    const data = await api({
      action: 'slots', duration: state.duration, token: state.rescheduling ? state.token : '',
      start: Date.UTC(y, m, 1) - 86400000, end: Date.UTC(y, m + 1, 1) + 86400000,
    });
    if (id !== state.loadId) return;
    const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
    data.slots.forEach((ms) => {
      const k = dayKey(ms);
      if (!k.startsWith(prefix)) return;
      if (!state.byDay.has(k)) state.byDay.set(k, []);
      state.byDay.get(k).push(ms);
    });
    $('pick-status').textContent = state.byDay.size ? '' : 'No open times this month. Try the next one.';
    if (!state.day || !state.byDay.has(state.day)) state.day = [...state.byDay.keys()].sort()[0] || null;
    renderGrid();
    renderTimes();
  } catch (err) {
    if (id === state.loadId) $('pick-status').textContent = err.message;
  }
}

function renderGrid() {
  const { y, m } = state.month;
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const today = dayKey(Date.now());
  let html = '<span></span>'.repeat(first);
  for (let d = 1; d <= days; d++) {
    const k = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const open = state.byDay.has(k);
    const cls = ['day', open && 'open', k === state.day && open && 'selected', k === today && 'today'].filter(Boolean).join(' ');
    html += `<button type="button" class="${cls}" data-k="${k}" ${open ? '' : 'disabled'} aria-label="${k}${open ? ', open' : ''}">${d}</button>`;
  }
  $('grid').innerHTML = html;
  $('grid').querySelectorAll('.day.open').forEach((b) => b.addEventListener('click', () => {
    state.day = b.dataset.k;
    renderGrid();
    renderTimes();
  }));
}

function renderTimes() {
  const slots = state.day ? state.byDay.get(state.day) || [] : [];
  $('day-title').textContent = slots.length ? longDate(slots[0]) : '';
  $('times').innerHTML = slots.map((ms) => `<button type="button" class="time" data-ms="${ms}">${timeLabel(ms)}</button>`).join('');
  $('times').querySelectorAll('.time').forEach((b) => b.addEventListener('click', () => pickSlot(Number(b.dataset.ms))));
}

function pickSlot(ms) {
  state.slot = ms;
  if (state.rescheduling) return reschedule(ms);
  $('when').textContent = `${whenLabel(ms, ms + state.duration * 60000)} · ${lengthLabel(state.duration)}`;
  show('details');
  $('form').elements.name.focus();
}

// ---------- booking form ----------

function wireForm() {
  const f = $('form');
  f.querySelectorAll('input[name=locationType]').forEach((r) => r.addEventListener('change', () => {
    const custom = f.elements.locationType.value === 'custom';
    f.elements.locationText.classList.toggle('hidden', !custom);
    if (custom) f.elements.locationText.focus();
  }));
  $('back').addEventListener('click', () => show('pick'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    const problem = checkForm(v);
    $('form-error').textContent = problem || '';
    if (problem) return;
    $('submit').disabled = true;
    $('submit').textContent = 'Booking…';
    try {
      const data = await api(null, { action: 'book', ...v, duration: state.duration, start: state.slot, timeZone: state.tz });
      showDone(data.booking, data.token, v);
    } catch (err) {
      $('form-error').textContent = err.message;
      if (/taken/.test(err.message)) loadMonth();
    } finally {
      $('submit').disabled = false;
      $('submit').textContent = 'Book it';
    }
  });
}

function checkForm(v) {
  if (!v.name.trim()) return 'Please enter your name.';
  if (!v.title.trim()) return 'Please give the meeting a name.';
  if (!v.email.trim() && !v.phone.trim()) return 'Please give an email or a phone number (or both).';
  if (v.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email.trim())) return 'That email address doesn\'t look right.';
  if (v.phone.trim() && v.phone.replace(/\D/g, '').length < 7) return 'That phone number doesn\'t look right.';
  if (v.locationType === 'custom' && !v.locationText.trim()) return 'Please say where you\'d like to meet.';
  return '';
}

function summaryHtml(b) {
  const rows = [['What', b.title], ['When', whenLabel(b.start, b.end)], ['Length', lengthLabel(b.duration)],
    ['Where', b.meetUrl ? `<a href="${esc(b.meetUrl)}" target="_blank" rel="noopener">Google Meet</a>` : esc(b.where)]];
  return rows.map(([k, val], i) => `<dt>${k}</dt><dd>${i === 3 ? val : esc(val)}</dd>`).join('');
}

function showDone(b, token, v) {
  $('done-title').textContent = state.rescheduling ? 'Moved' : 'You\'re booked';
  $('summary').innerHTML = summaryHtml(b);
  const email = v ? v.email.trim() : '';
  $('done-note').textContent = state.rescheduling
    ? 'Your calendar invite has been updated.'
    : email
      ? `A calendar invite is on its way to ${email}. You'll also get a reminder a day and an hour before.`
      : 'You gave a phone number only, so there\'s no email invite. Nico will reach you by phone. Save the link below to change or cancel.';
  $('manage-link').href = `?booking=${token || state.token}`;
  const dt = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
  $('gcal-link').href = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(b.title)}&dates=${dt(b.start)}/${dt(b.end)}`
    + `&location=${encodeURIComponent(b.meetUrl || b.where || '')}`;
  show('done');
}

// ---------- manage (cancel / reschedule) ----------

async function openManage() {
  show('manage');
  $('manage-summary').innerHTML = '<dt></dt><dd>Loading…</dd>';
  try {
    const { booking } = await api({ action: 'booking', token: state.token });
    state.booking = booking;
    $('manage-summary').innerHTML = summaryHtml(booking);
  } catch (err) {
    $('manage-summary').innerHTML = '';
    $('manage-actions').classList.add('hidden');
    $('manage-error').textContent = err.message;
  }
  $('cancel').addEventListener('click', cancelBooking);
  $('resched').addEventListener('click', () => {
    state.rescheduling = true;
    state.duration = state.booking.duration;
    renderDurations();
    show('pick');
    loadMonth();
  });
}

async function cancelBooking() {
  if (!confirm('Cancel this meeting?')) return;
  $('cancel').disabled = true;
  try {
    await api(null, { action: 'cancel', token: state.token });
    $('manage-summary').innerHTML = '';
    $('manage-actions').classList.add('hidden');
    $('manage-error').textContent = '';
    document.querySelector('#manage h2').textContent = 'Cancelled. Thanks for letting me know.';
  } catch (err) {
    $('manage-error').textContent = err.message;
    $('cancel').disabled = false;
  }
}

async function reschedule(ms) {
  $('pick-status').textContent = 'Moving your meeting…';
  try {
    const { booking } = await api(null, { action: 'reschedule', token: state.token, start: ms });
    showDone(booking, state.token, null);
  } catch (err) {
    $('pick-status').textContent = err.message;
    loadMonth();
  }
}

// ---------- plumbing ----------

function show(id) {
  ['pick', 'details', 'done', 'manage'].forEach((p) => $(p).classList.toggle('hidden', p !== id));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function start() {
  renderTz();
  state.month = thisMonth();
  $('prev').addEventListener('click', () => { stepMonth(-1); });
  $('next').addEventListener('click', () => { stepMonth(1); });
  wireForm();
  try {
    const cfg = await api({ action: 'config' });
    state.durations = cfg.durations;
    state.duration = cfg.defaultDuration;
    state.maxDaysAhead = cfg.maxDaysAhead;
  } catch (e) { /* keep the defaults */ }
  renderDurations();
  if (state.token) return openManage();
  loadMonth();
}

function stepMonth(delta) {
  const d = new Date(Date.UTC(state.month.y, state.month.m + delta, 1));
  state.month = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  state.day = null;
  loadMonth();
}

// ---------- mock backend for local previews (?mock) ----------

function mockApi(p, body) {
  const wait = (v) => new Promise((r) => setTimeout(() => r({ ok: true, ...v }), 250));
  const req = body || p;
  if (req.action === 'config') return wait({ durations: state.durations, defaultDuration: 30, maxDaysAhead: 60 });
  if (req.action === 'slots') {
    const out = [];
    const step = 15 * 60000, dur = Number(req.duration) * 60000;
    for (let t = Math.ceil((Date.now() + 2 * 3600000) / step) * step; t < Number(req.end); t += step) {
      const la = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const mins = la.getHours() * 60 + la.getMinutes();
      if (t >= Number(req.start) && la.getDay() !== 6 && mins >= 420 && mins * 60000 + dur <= 1290 * 60000 && !(mins >= 720 && mins < 780)) out.push(t);
    }
    return wait({ slots: out });
  }
  const fake = { title: req.title || 'Coffee catch-up', start: Number(req.start) || Date.now() + 86400000, duration: Number(req.duration) || 30, where: req.locationText || 'Google Meet', meetUrl: req.locationType === 'custom' ? '' : 'https://meet.google.com/abc-defg-hij', name: req.name || 'Sam' };
  fake.end = fake.start + fake.duration * 60000;
  if (req.action === 'book') return wait({ booking: fake, token: '00000000-0000-0000-0000-000000000000' });
  if (req.action === 'booking') return wait({ booking: fake });
  if (req.action === 'reschedule') return wait({ booking: fake });
  if (req.action === 'cancel') return wait({ cancelled: true });
  return Promise.reject(new Error('Unknown request.'));
}

start();
