const test = require('node:test');
const assert = require('node:assert');
const { datesBetween, weekdayOf, buildSlots, subtractInterval, cleanBooking } = require('../apps-script/Slots.js');

const TZ = 'America/Los_Angeles';

// Node stand-in for Utilities.parseDate: local wall time in TZ -> epoch ms.
function toUtcMs(date, time) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(ms);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - ms;
  };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

const hours = [['07:00', '21:30'], ['07:00', '21:30'], ['07:00', '21:30'], ['07:00', '21:30'], ['07:00', '21:30'],
  ['07:00', '21:30'], null];
const base = { toUtcMs, hours, stepMin: 15, bufferMin: 10, earliestMs: 0, latestMs: Infinity, busy: [] };
const at = (date, time) => toUtcMs(date, time);

test('datesBetween and weekdayOf', () => {
  assert.deepStrictEqual(datesBetween('2026-10-31', '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.strictEqual(weekdayOf('2026-11-14'), 6); // Saturday
  assert.strictEqual(weekdayOf('2026-11-15'), 0);
});

test('open day runs 7:00 to 21:30 local, every 15 minutes', () => {
  const s = buildSlots({ ...base, dates: ['2026-11-12'], durationMin: 30 });
  assert.strictEqual(s[0], at('2026-11-12', '07:00'));
  assert.strictEqual(s[s.length - 1], at('2026-11-12', '21:00'));
  assert.strictEqual(s.length, (14 * 60) / 15 + 1);
});

test('4-hour meeting must end by 21:30', () => {
  const s = buildSlots({ ...base, dates: ['2026-11-12'], durationMin: 240 });
  assert.strictEqual(s[s.length - 1], at('2026-11-12', '17:30'));
});

test('Saturday is closed', () => {
  assert.deepStrictEqual(buildSlots({ ...base, dates: ['2026-11-14'], durationMin: 30 }), []);
});

test('daylight saving change keeps 7:00 local', () => {
  const s = buildSlots({ ...base, dates: ['2026-11-01'], durationMin: 30 }); // PDT -> PST that morning
  assert.strictEqual(new Date(s[0]).toISOString(), '2026-11-01T15:00:00.000Z');
});

test('10-minute gap on both sides of a busy event', () => {
  const busy = [{ start: at('2026-11-12', '13:30'), end: at('2026-11-12', '13:45') }];
  const s = buildSlots({ ...base, dates: ['2026-11-12'], durationMin: 45, busy });
  assert.ok(s.includes(at('2026-11-12', '12:30'))); // ends 13:15, 15 min before
  assert.ok(!s.includes(at('2026-11-12', '12:45'))); // ends 13:30, no gap
  assert.ok(!s.includes(at('2026-11-12', '13:45'))); // starts right as the event ends
  assert.ok(s.includes(at('2026-11-12', '14:00')));
});

test('minimum notice and window are respected', () => {
  const s = buildSlots({ ...base, dates: ['2026-11-12'], durationMin: 30,
    earliestMs: at('2026-11-12', '12:05'), latestMs: at('2026-11-12', '13:00') });
  assert.deepStrictEqual(s, [at('2026-11-12', '12:15'), at('2026-11-12', '12:30'), at('2026-11-12', '12:45'),
    at('2026-11-12', '13:00')]);
});

test('subtractInterval frees a booking being moved', () => {
  const busy = [{ start: 0, end: 100 }, { start: 200, end: 300 }];
  assert.deepStrictEqual(subtractInterval(busy, { start: 50, end: 250 }), [{ start: 0, end: 50 }, { start: 250, end: 300 }]);
  assert.deepStrictEqual(subtractInterval(busy, { start: 0, end: 100 }), [{ start: 200, end: 300 }]);
});

test('cleanBooking: email, phone, or both', () => {
  const cfg = { durations: [15, 30] };
  const ok = { name: ' Sam ', title: 'Coffee', duration: 30, start: 1800000000000 - (1800000000000 % 60000),
    locationType: 'meet' };
  assert.strictEqual(cleanBooking({ ...ok, email: 'Sam@Example.com' }, cfg).email, 'sam@example.com');
  assert.strictEqual(cleanBooking({ ...ok, phone: '+1 (403) 555-0100' }, cfg).phone, '+1 (403) 555-0100');
  const both = cleanBooking({ ...ok, email: 'sam@example.com', phone: '4035550100' }, cfg);
  assert.strictEqual(both.name, 'Sam');
  assert.throws(() => cleanBooking(ok, cfg), /email or a phone/);
  assert.throws(() => cleanBooking({ ...ok, email: 'nope' }, cfg), /email address/);
  assert.throws(() => cleanBooking({ ...ok, phone: '12' }, cfg), /phone number/);
  assert.throws(() => cleanBooking({ ...ok, email: 'a@b.co', duration: 20 }, cfg), /lengths/);
  assert.throws(() => cleanBooking({ ...ok, email: 'a@b.co', locationType: 'custom' }, cfg), /where/);
  assert.strictEqual(cleanBooking({ ...ok, email: 'a@b.co', locationType: 'custom', locationText: 'Blue Bottle' }, cfg)
    .location.text, 'Blue Bottle');
  assert.throws(() => cleanBooking({ ...ok, email: 'a@b.co', website: 'spam' }, cfg));
});
