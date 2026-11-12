// Booking page front end. Talks to the Apps Script web app at API.
const API = 'https://script.google.com/macros/s/AKfycbx7Za4vSfKa8jnASbrGqLuH6IzAcwaqScrbC_MaxeUFmWntWsTvLRveksmCZbIk7SHw/exec';
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
  custom: { minMinutes: 10, maxMinutes: 600, stepMinutes: 5 },
  view: 'month',        // 'month' | 'week' | 'list'
  anchor: null,         // 'yyyy-mm-dd' in the viewer's time zone that the current view is built around
  customMode: false,    // the person is typing their own start and end
  customTouched: false,
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
  // Network blips and Google hiccups are retried. Bookings carry a requestId, so a retry
  // returns the first booking instead of making a second one.
  const tries = 3;
  for (let i = 0; i < tries; i++) {
    let data = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: ctrl.signal });
      clearTimeout(timer);
      data = JSON.parse(await res.text());
    } catch (e) {
      data = null; // offline, timed out, or Google answered with a page instead of data
    }
    if (data && data.ok) return data;
    if (data && data.error) throw new Error(data.error); // a real answer, e.g. "that time was just taken"
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error('The booking page can\'t reach the calendar right now. Please check your connection and try again in a minute.');
}

function newRequestId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
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
const hhmm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: state.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const longDate = (ms) => fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(ms);
function lengthLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  if (!m) return `${h} h`;
  if (m === 30) return `${h}½ h`;
  return `${h} h ${m} min`;
}
function whenLabel(start, end) {
  return `${longDate(start)}, ${timeLabel(start)} – ${timeLabel(end)}`;
}

// Calendar maths on 'yyyy-mm-dd' keys (no time zone involved).
const keyMs = (k) => Date.parse(k + 'T00:00:00Z');
const addDays = (k, n) => new Date(keyMs(k) + n * 86400000).toISOString().slice(0, 10);
const weekdayOfKey = (k) => new Date(keyMs(k)).getUTCDay();
const keyLabel = (k, opts) => new Date(keyMs(k) + 12 * 3600000).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });

// Wall-clock time on a day in the viewer's zone -> epoch ms.
function zonedMs(k, time) {
  const wall = Date.parse(`${k}T${time}:00Z`);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: state.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - ms;
  };
  return wall - offsetAt(wall - offsetAt(wall));
}

// ---------- lengths ----------

function renderDurations() {
  const chips = state.durations.map((d) =>
    `<button type="button" class="chip" role="radio" aria-checked="${!state.customMode && d === state.duration}" data-d="${d}">${lengthLabel(d)}</button>`);
  if (!state.rescheduling) {
    chips.push(`<button type="button" class="chip" role="radio" aria-checked="${state.customMode}" data-d="custom">Custom (up to 10 h)</button>`);
  }
  $('durations').innerHTML = chips.join('');
  $('durations').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    if (state.rescheduling) return;
    if (b.dataset.d === 'custom') {
      state.customMode = true;
      const d = customLength();
      if (d.ok) state.duration = d.minutes;
    } else {
      state.customMode = false;
      state.duration = Number(b.dataset.d);
    }
    renderDurations();
    loadRange();
  }));
}

function customLength() {
  const a = $('c-start').value, b = $('c-end').value;
  if (!a || !b) return { ok: false, error: 'Type a start and an end time.' };
  const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
  const minutes = (bh * 60 + bm) - (ah * 60 + am);
  const c = state.custom;
  if (minutes <= 0) return { ok: false, error: 'The end needs to be after the start.' };
  if (minutes < c.minMinutes) return { ok: false, error: `Make it at least ${c.minMinutes} minutes.` };
  if (minutes > c.maxMinutes) return { ok: false, error: `That's longer than ${lengthLabel(c.maxMinutes)}. Please shorten it.` };
  if (minutes % c.stepMinutes || am % c.stepMinutes) return { ok: false, error: `Please use times on ${c.stepMinutes}-minute steps (like 2:05 or 2:10).` };
  return { ok: true, minutes };
}

function wireCustom() {
  const onChange = () => {
    state.customTouched = true;
    const d = customLength();
    $('c-len').textContent = d.ok ? lengthLabel(d.minutes) : '';
    $('c-error').textContent = d.ok ? '' : d.error;
    if (d.ok && d.minutes !== state.duration) { state.duration = d.minutes; loadRange(); }
  };
  $('c-start').addEventListener('change', onChange);
  $('c-end').addEventListener('change', onChange);
  $('c-go').addEventListener('click', async () => {
    const d = customLength();
    if (!d.ok) { $('c-error').textContent = d.error; return; }
    if (!state.day) { $('c-error').textContent = 'Pick a day first.'; return; }
    const ms = zonedMs(state.day, $('c-start').value);
    $('c-go').disabled = true;
    $('c-error').textContent = '';
    try {
      const { open } = await api({ action: 'check', start: ms, duration: d.minutes });
      if (!open) {
        $('c-error').textContent = 'That time isn\'t free. It overlaps something, needs a 10-minute gap, or falls outside 7:00am–9:30pm Pacific. Try one of the times below.';
        return;
      }
      state.duration = d.minutes;
      pickSlot(ms);
    } catch (err) {
      $('c-error').textContent = err.message;
    } finally {
      $('c-go').disabled = false;
    }
  });
}

function renderCustomBox() {
  const showIt = state.customMode && !!state.day;
  $('custom-box').classList.toggle('hidden', !showIt);
  if (!showIt) return;
  const first = (state.byDay.get(state.day) || [])[0];
  if (!state.customTouched && first) {
    $('c-start').value = hhmm(first);
    $('c-end').value = hhmm(first + state.duration * 60000);
  }
  const d = customLength();
  $('c-len').textContent = d.ok ? lengthLabel(d.minutes) : '';
}

// ---------- views ----------

function renderTz() {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { zones = [state.tz]; }
  if (!zones.includes(state.tz)) zones.unshift(state.tz);
  $('tz').innerHTML = zones.map((z) => `<option ${z === state.tz ? 'selected' : ''}>${z}</option>`).join('');
  $('tz').addEventListener('change', () => { state.tz = $('tz').value; state.anchor = clampAnchor(state.anchor); loadRange(); });
}

function wireViews() {
  document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    document.querySelectorAll('.views button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    if (state.day) state.anchor = state.day;
    loadRange();
  }));
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
}

const today = () => dayKey(Date.now());
const lastDay = () => dayKey(Date.now() + state.maxDaysAhead * 86400000);
function clampAnchor(k) {
  if (!k || k < today()) return today();
  return k > lastDay() ? lastDay() : k;
}

// The days the current view covers.
function viewDays() {
  const a = state.anchor;
  if (state.view === 'week') {
    const first = addDays(a, -weekdayOfKey(a));
    return Array.from({ length: 7 }, (_, i) => addDays(first, i));
  }
  if (state.view === 'list') return Array.from({ length: 14 }, (_, i) => addDays(a, i));
  const first = a.slice(0, 8) + '01';
  const n = new Date(Date.UTC(+a.slice(0, 4), +a.slice(5, 7), 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => addDays(first, i));
}

function step(dir) {
  const a = state.anchor;
  if (state.view === 'week') state.anchor = addDays(a, 7 * dir);
  else if (state.view === 'list') state.anchor = addDays(a, 14 * dir);
  else {
    const d = new Date(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1 + dir, 1));
    state.anchor = d.toISOString().slice(0, 10);
  }
  state.anchor = clampAnchor(state.anchor);
  state.day = null;
  loadRange();
}

function rangeTitle(days) {
  if (state.view === 'month') return keyLabel(days[0], { month: 'long', year: 'numeric' });
  const a = keyLabel(days[0], { month: 'short', day: 'numeric' });
  const b = keyLabel(days[days.length - 1], { month: 'short', day: 'numeric' });
  return `${a} – ${b}`;
}

async function loadRange() {
  const id = ++state.loadId;
  state.anchor = clampAnchor(state.anchor);
  const days = viewDays();
  $('range-title').textContent = rangeTitle(days);
  $('prev').disabled = days[0] <= today();
  $('next').disabled = days[days.length - 1] >= lastDay();
  ['month', 'week', 'list'].forEach((v) => $(`${v}-view`).classList.toggle('hidden', v !== state.view));
  state.byDay = new Map();
  render(days);
  $('pick-status').textContent = 'Finding open times…';
  try {
    const data = await api({
      action: 'slots', duration: state.duration, token: state.rescheduling ? state.token : '',
      start: keyMs(days[0]) - 86400000, end: keyMs(days[days.length - 1]) + 2 * 86400000,
    });
    if (id !== state.loadId) return;
    data.slots.forEach((ms) => {
      const k = dayKey(ms);
      if (k < days[0] || k > days[days.length - 1]) return;
      if (!state.byDay.has(k)) state.byDay.set(k, []);
      state.byDay.get(k).push(ms);
    });
    $('pick-status').textContent = state.byDay.size ? '' : `No open times ${state.view === 'month' ? 'this month' : 'in these days'} for ${lengthLabel(state.duration)}. Try ${state.view === 'month' ? 'the next month' : 'later dates'} or a shorter length.`;
    if (!state.day || !state.byDay.has(state.day)) state.day = [...state.byDay.keys()].sort()[0] || null;
    render(days);
  } catch (err) {
    if (id !== state.loadId) return;
    $('pick-status').textContent = err.message + ' ';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'link';
    again.textContent = 'Try again';
    again.addEventListener('click', loadRange);
    $('pick-status').appendChild(again);
  }
}

function render(days) {
  if (state.view === 'month') renderMonth(days);
  if (state.view === 'week') renderWeek(days);
  if (state.view === 'list') renderList(days);
  const inlineTimes = state.view !== 'month';
  const slots = state.day ? state.byDay.get(state.day) || [] : [];
  $('day-title').textContent = state.day && (state.customMode || !inlineTimes) && slots.length ? longDate(slots[0]) : '';
  $('times').classList.toggle('hidden', inlineTimes);
  if (!inlineTimes) $('times').innerHTML = timeButtons(slots);
  $('c-or').textContent = inlineTimes ? 'Or tap a start time above for that length.' : 'Or tap a start time below for that length.';
  renderCustomBox();
  wireTimes();
}

const timeButtons = (slots) => slots.map((ms) => `<button type="button" class="time" data-ms="${ms}">${timeLabel(ms)}</button>`).join('');
function wireTimes() {
  document.querySelectorAll('#pick .time').forEach((b) => b.addEventListener('click', () => pickSlot(Number(b.dataset.ms))));
  document.querySelectorAll('#pick [data-k]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    state.day = b.dataset.k;
    render(viewDays());
  }));
}

function renderMonth(days) {
  const t = today();
  let html = '<span></span>'.repeat(weekdayOfKey(days[0]));
  days.forEach((k) => {
    const open = state.byDay.has(k);
    const cls = ['day', open && 'open', k === state.day && open && 'selected', k === t && 'today'].filter(Boolean).join(' ');
    html += `<button type="button" class="${cls}" data-k="${k}" ${open ? '' : 'disabled'} aria-label="${keyLabel(k, { weekday: 'long', month: 'long', day: 'numeric' })}${open ? ', open' : ''}">${+k.slice(8)}</button>`;
  });
  $('grid').innerHTML = html;
}

function renderWeek(days) {
  $('week-view').innerHTML = days.map((k) => {
    const slots = state.byDay.get(k) || [];
    const head = `<button type="button" class="whead${k === state.day && slots.length ? ' selected' : ''}" data-k="${k}" ${slots.length ? '' : 'disabled'}>${keyLabel(k, { weekday: 'short' })}<span>${+k.slice(8)}</span></button>`;
    const body = slots.length ? `<div class="wtimes">${timeButtons(slots)}</div>` : '<div class="wempty">No times</div>';
    return `<div class="wcol">${head}${body}</div>`;
  }).join('');
}

function renderList(days) {
  const open = days.filter((k) => state.byDay.has(k));
  $('list-view').innerHTML = open.map((k) => {
    const slots = state.byDay.get(k);
    return `<div class="lday"><button type="button" class="lhead${k === state.day ? ' selected' : ''}" data-k="${k}">${keyLabel(k, { weekday: 'long' })}<small>${keyLabel(k, { month: 'long', day: 'numeric' })} · ${slots.length} times</small></button>`
      + `<div class="ltimes">${timeButtons(slots)}</div></div>`;
  }).join('');
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
    $('addr').classList.toggle('hidden', !custom);
    if (custom) { f.elements.locationText.focus(); loadPlaces(); }
  }));
  wireAddressFinder(f.elements.locationText);
  $('back').addEventListener('click', () => show('pick'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f).entries());
    v.knownContact = f.elements.knownContact.checked;
    const problem = checkForm(v);
    $('form-error').textContent = problem || '';
    if (problem) return;
    $('submit').disabled = true;
    $('submit').textContent = 'Booking…';
    try {
      const key = `${state.slot}|${state.duration}|${v.name}|${v.title}|${v.email}|${v.phone}|${v.knownContact}|${v.locationType}|${v.locationText}`;
      if (state.requestKey !== key) { state.requestKey = key; state.requestId = newRequestId(); }
      const data = await api(null, { action: 'book', ...v, duration: state.duration, start: state.slot, timeZone: state.tz, requestId: state.requestId });
      showDone(data.booking, data.token, v);
    } catch (err) {
      $('form-error').textContent = err.message;
      if (/taken/.test(err.message)) loadRange();
    } finally {
      $('submit').disabled = false;
      $('submit').textContent = 'Book it';
    }
  });
}

function checkForm(v) {
  if (!v.name.trim()) return 'Please enter your name.';
  if (!v.title.trim()) return 'Please give the meeting a name.';
  if (!v.email.trim() && !v.phone.trim() && !v.knownContact) return 'Please give an email or a phone number, or tick the box if Nico already has your contact info.';
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
  const phone = v ? v.phone.trim() : '';
  $('done-note').textContent = state.rescheduling
    ? 'Done. If you gave an email, your calendar invite has been updated.'
    : email
      ? `A calendar invite is on its way to ${email}, and you'll get email reminders a day and an hour before.`
      : phone
        ? 'Reminders and invites only go by email, so you won\'t get any. Nico has your number. Save the link below to change or cancel.'
        : 'No email given, so there\'s no invite or reminder. Nico will use the contact info he already has. Save the link below to change or cancel.';
  $('manage-link').href = `?booking=${token || state.token}`;
  const dt = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
  $('gcal-link').href = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(b.title)}&dates=${dt(b.start)}/${dt(b.end)}`
    + `&location=${encodeURIComponent(b.meetUrl || b.where || '')}`;
  show('done');
}

// ---------- address finder (Google Places) ----------
// Loaded only when someone picks "Somewhere else", and only if a key is set in maps-key.js.
// Suggestions are just text: picking one fills the field, and anything typed by hand still works.

const places = { lib: null, loading: null, token: null, items: [], active: -1, seq: 0 };

function loadPlaces() {
  if (!window.MAPS_KEY) return Promise.resolve(null);
  if (places.loading) return places.loading;
  places.loading = new Promise((resolve) => {
    window.gm_authFailure = () => { places.lib = null; hideSuggestions(); }; // bad or unauthorised key
    window.__placesReady = async () => {
      try { places.lib = await google.maps.importLibrary('places'); } catch (e) { places.lib = null; }
      resolve(places.lib);
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(window.MAPS_KEY)}&v=weekly&loading=async&callback=__placesReady`;
    s.async = true;
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return places.loading;
}

function wireAddressFinder(input) {
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { hideSuggestions(); return; }
    timer = setTimeout(() => suggest(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if ($('addr-list').classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = places.items.length;
      places.active = (places.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintSuggestions();
    } else if (e.key === 'Enter' && places.active >= 0) {
      e.preventDefault();
      choose(places.active);
    } else if (e.key === 'Escape') {
      hideSuggestions();
    }
  });
  input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
}

async function suggest(q) {
  const lib = await loadPlaces();
  if (!lib) return;
  const seq = ++places.seq;
  try {
    if (!places.token) places.token = new lib.AutocompleteSessionToken();
    const { suggestions } = await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: q, sessionToken: places.token });
    if (seq !== places.seq) return;
    places.items = (suggestions || []).map((x) => x.placePrediction).filter(Boolean).slice(0, 6).map((p) => ({
      text: p.text.toString(),
      main: p.mainText ? p.mainText.toString() : p.text.toString(),
      rest: p.secondaryText ? p.secondaryText.toString() : '',
    }));
    places.active = -1;
    paintSuggestions();
  } catch (e) {
    hideSuggestions(); // quota, network or key trouble: the plain text box still works
  }
}

function paintSuggestions() {
  const list = $('addr-list');
  if (!places.items.length) { hideSuggestions(); return; }
  list.innerHTML = places.items.map((it, i) =>
    `<li role="option" id="addr-${i}" aria-selected="${i === places.active}" data-i="${i}">${esc(it.main)}${it.rest ? `<small>${esc(it.rest)}</small>` : ''}</li>`
  ).join('') + '<li class="by-google" aria-hidden="true">powered by Google</li>';
  list.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(Number(li.dataset.i)); }));
  list.classList.remove('hidden');
  const input = $('form').elements.locationText;
  input.setAttribute('aria-expanded', 'true');
  if (places.active >= 0) input.setAttribute('aria-activedescendant', `addr-${places.active}`);
}

function choose(i) {
  const it = places.items[i];
  if (!it) return;
  $('form').elements.locationText.value = it.text;
  places.token = null; // a pick ends the billing session
  hideSuggestions();
}

function hideSuggestions() {
  $('addr-list').classList.add('hidden');
  const input = $('form') && $('form').elements.locationText;
  if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  places.items = [];
  places.active = -1;
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
    state.customMode = false;
    state.duration = state.booking.duration;
    renderDurations();
    show('pick');
    loadRange();
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
    loadRange();
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
  state.anchor = today();
  wireViews();
  wireCustom();
  wireForm();
  try {
    const cfg = await api({ action: 'config' });
    state.durations = cfg.durations;
    state.duration = cfg.defaultDuration;
    state.maxDaysAhead = cfg.maxDaysAhead;
    if (cfg.custom) state.custom = cfg.custom;
  } catch (e) { /* keep the defaults */ }
  renderDurations();
  if (state.token) return openManage();
  loadRange();
}

// ---------- mock backend for local previews (?mock) ----------

function mockApi(p, body) {
  const wait = (v) => new Promise((r) => setTimeout(() => r({ ok: true, ...v }), 250));
  const req = body || p;
  if (req.action === 'config') return wait({ durations: state.durations, defaultDuration: 30, maxDaysAhead: 60, custom: state.custom });
  if (req.action === 'check') return wait({ open: true });
  if (req.action === 'slots') {
    const out = [];
    const step = 15 * 60000, dur = Number(req.duration) * 60000;
    for (let t = Math.ceil((Date.now() + 2 * 3600000) / step) * step; t < Number(req.end); t += step) {
      const la = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const mins = la.getHours() * 60 + la.getMinutes();
      if (t >= Number(req.start) && mins >= 420 && mins * 60000 + dur <= 1290 * 60000 && !(mins >= 720 && mins < 780)) out.push(t);
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
