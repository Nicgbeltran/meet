// Live stress test against the deployed engine. Creates real bookings titled "[TEST] …"
// far in the future and cancels every one of them before it exits.
//   node test/live-stress.mjs <yourEmail> [outsideGuestEmail]
// Emails come from the command line so no address is stored in this public repo.
import { readFileSync } from 'node:fs';

const API = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8').match(/const API = '([^']+)'/)[1];
const SELF = process.argv[2];
const GUEST = process.argv[3] || '';
if (!SELF) { console.error('usage: node test/live-stress.mjs <yourEmail> [outsideGuestEmail]'); process.exit(2); }
const TZ = 'America/Los_Angeles';
const MIN = 60000, H = 3600000, D = 86400000;
const results = [];
const tokens = new Set();

async function get(params) {
  const t0 = Date.now();
  const res = await fetch(API + '?' + new URLSearchParams(params));
  const data = JSON.parse(await res.text());
  data._ms = Date.now() - t0;
  return data;
}
async function post(body, raw) {
  const t0 = Date.now();
  const res = await fetch(API, { method: 'POST', body: raw ?? JSON.stringify(body) });
  const data = JSON.parse(await res.text());
  data._ms = Date.now() - t0;
  if (data.token) tokens.add(data.token);
  return data;
}
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const local = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .formatToParts(ms).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
const uid = () => crypto.randomUUID();
const base = (over = {}) => ({ action: 'book', name: 'Stress Test', title: '[TEST] stress', email: '', phone: '+1 403 555 0100',
  locationType: 'meet', duration: 30, timeZone: 'America/Edmonton', requestId: uid(), ...over });

async function main() {
  console.log('API', API.slice(0, 60) + '…');
  const health = await get({ action: 'health' });
  check('health answers', health.ok, JSON.stringify({ ...health, _ms: undefined }));
  check('reminder timer installed', health.reminderTriggers === 1, `triggers=${health.reminderTriggers}`);
  check('10 calendars counted as busy', health.busyCalendars === 10, `busyCalendars=${health.busyCalendars}`);

  const cfg = await get({ action: 'config' });
  check('config', cfg.ok && cfg.durations.length === 9 && cfg.durations.at(-1) === 240);

  // ---- every length, the whole 60-day window, all rules ----
  const now = Date.now();
  const byDur = {};
  let worstMs = 0;
  for (const d of cfg.durations) {
    const a = await get({ action: 'slots', duration: d, start: now, end: now + 31 * D });
    const b = await get({ action: 'slots', duration: d, start: now + 31 * D, end: now + 62 * D });
    worstMs = Math.max(worstMs, a._ms, b._ms);
    const slots = [...a.slots, ...b.slots];
    byDur[d] = slots;
    const bad = slots.filter((t) => {
      const s = local(t), e = local(t + d * MIN);
      const startMin = +s.hour * 60 + +s.minute, endMin = +e.hour * 60 + +e.minute;
      return s.weekday === 'Sat' || startMin < 420 || endMin > 1290 || endMin < startMin || t % (15 * MIN) !== 0
        || t < now + 2 * H - MIN || t > now + 60 * D;
    });
    check(`slots ${d} min obey hours/Saturday/notice/window`, a.ok && b.ok && slots.length > 0 && bad.length === 0,
      `${slots.length} slots, ${bad.length} bad`);
  }
  check('slot lookups stay fast', worstMs < 15000, `slowest ${worstMs} ms`);
  check('longer meetings never have more slots than shorter ones',
    cfg.durations.every((d, i) => i === 0 || byDur[d].length <= byDur[cfg.durations[i - 1]].length));

  // ---- bad requests never create anything ----
  // Each test gets its own open day 45+ days out, at 10:00 Pacific, so tests can't collide.
  const dayKey = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(t);
  const tenAm = (dur) => byDur[dur].filter((t) => t > now + 30 * D && local(t).hour === '10' && local(t).minute === '00');
  const days = [...new Set(tenAm(240).map(dayKey))];
  const at = (i, dur = 30) => tenAm(dur).find((t) => dayKey(t) === days[i]);
  check('enough free test days', days.length >= 7, `${days.length} days`);
  const pick = (i) => at(i);
  const s0 = at(6);
  const expectErr = async (name, body, re) => {
    const r = await post(body);
    check(name, !r.ok && re.test(r.error || ''), r.error || 'NO ERROR');
  };
  await expectErr('rejects no email and no phone', base({ start: s0, phone: '' }), /email or a phone/);
  await expectErr('rejects bad email', base({ start: s0, email: 'not-an-email' }), /email address/);
  await expectErr('rejects bad phone', base({ start: s0, phone: '12' }), /phone number/);
  await expectErr('rejects missing name', base({ start: s0, name: ' ' }), /name/);
  await expectErr('rejects missing meeting name', base({ start: s0, title: '' }), /meeting a name/);
  await expectErr('rejects a length not offered', base({ start: s0, duration: 20 }), /lengths/);
  await expectErr('rejects custom place with no text', base({ start: s0, locationType: 'custom' }), /where/);
  await expectErr('rejects 151-char meeting name', base({ start: s0, title: 'x'.repeat(151) }), /meeting a name/);
  await expectErr('spam trap field blocks', base({ start: s0, website: 'http://spam' }), /went wrong/);
  await expectErr('rejects a time in the past', base({ start: Math.floor((now - D) / (15 * MIN)) * 15 * MIN }), /taken/);
  await expectErr('rejects a time inside the 2-hour notice', base({ start: Math.ceil((now + 30 * MIN) / (15 * MIN)) * 15 * MIN }), /taken/);
  const sat = byDur[30].find((t) => local(t).weekday === 'Fri');
  await expectErr('rejects a Saturday', base({ start: sat + D }), /taken/);
  await expectErr('rejects 11pm', base({ start: s0 - (s0 % D) + 7 * H }), /taken/); // 07:00Z = 11pm/midnight PT
  await expectErr('rejects 70 days out', base({ start: Math.floor((now + 70 * D) / D) * D + 18 * H }), /taken/);
  await expectErr('rejects off-grid minute', base({ start: s0 + 7 * MIN }), /taken|pick a time/i);
  await expectErr('rejects non-number start', base({ start: 'tomorrow' }), /pick a time/i);
  const junk = await post(null, 'this is not json');
  check('survives a garbage body', junk.ok === false && !!junk.error, junk.error);
  const unknown = await get({ action: 'drop tables' });
  check('unknown action refused', !unknown.ok, unknown.error);
  const badTok = await get({ action: 'booking', token: 'abc' });
  check('bad booking link refused', !badTok.ok && /isn't valid/.test(badTok.error), badTok.error);
  const goneTok = await get({ action: 'booking', token: uid() });
  check('unknown booking link refused', !goneTok.ok && /no longer exists/.test(goneTok.error), goneTok.error);

  // ---- real bookings: every contact and place combination ----
  const A = await post(base({ start: at(0, 15), duration: 15, email: SELF, phone: '', title: '[TEST] email only, Meet' }));
  check('books email only + Google Meet', A.ok && A.booking.meetUrl.startsWith('https://meet.google.com/'), A.error || A.booking?.meetUrl);
  const pB = at(1, 60);
  const B = await post(base({ start: pB, duration: 60, phone: '+1 (403) 555-0100', locationType: 'custom', locationText: 'Blue Bottle, Hayes St', title: '[TEST] phone only, custom place' }));
  check('books phone only + custom place', B.ok && B.booking.where === 'Blue Bottle, Hayes St' && !B.booking.meetUrl, B.error || B.booking?.where);
  const pC = at(2, 240);
  const C = await post(base({ start: pC, duration: 240, email: SELF, locationType: 'custom', locationText: 'Café ☕ Zürich — 4th floor',
    title: '[TEST] <img src=x onerror=alert(1)> 4h 🚀' }));
  check('books 4 h with emoji, accents and HTML in the name', C.ok && C.booking.duration === 240 && C.booking.title.includes('<img'), C.error || C.booking?.title);
  if (GUEST) {
    const G = await post(base({ start: pick(3), duration: 30, email: GUEST, phone: '', title: '[TEST] invite to a real outside address' }));
    check(`books with an outside guest (${GUEST})`, G.ok, G.error || 'invite sent');
  }

  // ---- double booking ----
  const raceSlot = pick(4);
  const race = await Promise.all([1, 2, 3, 4, 5].map((i) => post(base({ start: raceSlot, title: `[TEST] race ${i}` }))));
  const wins = race.filter((r) => r.ok).length;
  check('5 people grabbing the same time: exactly 1 wins', wins === 1, `${wins} won; others: ${[...new Set(race.filter((r) => !r.ok).map((r) => r.error))].join(' / ')}`);
  const touching = await post(base({ start: raceSlot + 30 * MIN, title: '[TEST] starts as the race winner ends' }));
  check('no back-to-back booking without the 10-minute gap', !touching.ok, touching.error || 'BOOKED');
  const gap = await post(base({ start: raceSlot + 45 * MIN, title: '[TEST] 15 minutes after the race winner' }));
  check('a booking 15 minutes later is fine', gap.ok, gap.error);

  // ---- retries never double book ----
  const rid = uid();
  const retry = await Promise.all([0, 1].map(() => post(base({ start: pick(5), title: '[TEST] same request sent twice', requestId: rid }))));
  check('the same request sent twice makes one booking', retry.every((r) => r.ok) && retry[0].token === retry[1].token,
    retry.map((r) => r.token || r.error).join(' / '));

  // ---- reschedule and cancel ----
  if (A.ok) {
    const taken = await post({ action: 'reschedule', token: A.token, start: raceSlot });
    check('cannot move onto someone else\'s booking', !taken.ok, taken.error || 'MOVED');
    const nudge = await post({ action: 'reschedule', token: A.token, start: at(0, 15) + 15 * MIN });
    check('can move 15 minutes later, overlapping itself', nudge.ok && nudge.booking.start === at(0, 15) + 15 * MIN, nudge.error);
    const look = await get({ action: 'booking', token: A.token });
    check('booking link shows the new time', look.ok && look.booking.start === at(0, 15) + 15 * MIN);
    const c1 = await post({ action: 'cancel', token: A.token });
    const c2 = await post({ action: 'cancel', token: A.token });
    check('cancel works, and a second cancel is refused politely', c1.ok && !c2.ok && /no longer exists/.test(c2.error), c2.error);
    tokens.delete(A.token);
    const freed = await get({ action: 'slots', duration: 15, start: at(0, 15) - H, end: at(0, 15) + 2 * H });
    check('a cancelled time opens up again', freed.ok && freed.slots.includes(at(0, 15)));
  }
}

async function cleanup() {
  let left = 0;
  for (const t of tokens) {
    const r = await post({ action: 'cancel', token: t }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok && !/no longer exists/.test(r.error || '')) { left++; console.log('could not cancel', t, r.error); }
  }
  check('every test booking cancelled', left === 0, `${tokens.size} cleaned up`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
}

main().catch((e) => { check('test run crashed', false, e.stack); }).finally(cleanup);
