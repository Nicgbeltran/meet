// Pure booking maths, shared by the Apps Script backend and the Node tests.
// Times are epoch milliseconds; dates are 'yyyy-MM-dd' strings in the owner's time zone.

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function userError(message) {
  var err = new Error(message);
  err.userMessage = message;
  return err;
}

function datesBetween(firstDate, lastDate) {
  var out = [];
  var day = Date.parse(firstDate + 'T00:00:00Z');
  var end = Date.parse(lastDate + 'T00:00:00Z');
  for (; day <= end; day += 86400000) out.push(new Date(day).toISOString().slice(0, 10));
  return out;
}

function weekdayOf(date) {
  return new Date(date + 'T12:00:00Z').getUTCDay();
}

// p: { dates, toUtcMs(date, 'HH:mm'), hours[weekday] = ['07:00', '21:30'] | null,
//      durationMin, stepMin, bufferMin, earliestMs, latestMs, busy: [{ start, end }] }
function buildSlots(p) {
  var out = [];
  var dur = p.durationMin * 60000;
  var step = p.stepMin * 60000;
  var buf = p.bufferMin * 60000;
  p.dates.forEach(function (date) {
    var h = p.hours[weekdayOf(date)];
    if (!h) return;
    var open = p.toUtcMs(date, h[0]);
    var close = p.toUtcMs(date, h[1]);
    for (var t = open; t + dur <= close; t += step) {
      if (t < p.earliestMs || t > p.latestMs) continue;
      var end = t + dur;
      var clash = p.busy.some(function (b) { return b.start < end + buf && b.end > t - buf; });
      if (!clash) out.push(t);
    }
  });
  return out;
}

// Removes one interval (a booking being moved) from a list of busy intervals.
function subtractInterval(busy, cut) {
  var out = [];
  busy.forEach(function (b) {
    if (b.end <= cut.start || b.start >= cut.end) { out.push(b); return; }
    if (b.start < cut.start) out.push({ start: b.start, end: cut.start });
    if (b.end > cut.end) out.push({ start: cut.end, end: b.end });
  });
  return out;
}

function cleanBooking(b, cfg) {
  var s = function (v) { return typeof v === 'string' ? v.trim() : ''; };
  if (s(b.website)) throw userError('Something went wrong. Please try again.'); // hidden spam trap
  var name = s(b.name);
  var title = s(b.title);
  var email = s(b.email).toLowerCase();
  var phone = s(b.phone);
  var notes = s(b.notes);
  var tz = s(b.timeZone);
  if (!name || name.length > 100) throw userError('Please enter your name.');
  if (!title || title.length > 150) throw userError('Please give the meeting a name.');
  if (!email && !phone) throw userError('Please give an email or a phone number (or both).');
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) throw userError('That email address doesn\'t look right.');
  var digits = phone.replace(/\D/g, '');
  if (phone && (digits.length < 7 || digits.length > 15 || phone.length > 40)) throw userError('That phone number doesn\'t look right.');
  var duration = Number(b.duration);
  if (cfg.durations.indexOf(duration) === -1) throw userError('Please pick one of the meeting lengths.');
  var start = Number(b.start);
  if (!isFinite(start) || start % 60000 !== 0) throw userError('Please pick a time.');
  var location;
  if (b.locationType === 'meet') {
    location = { type: 'meet' };
  } else if (b.locationType === 'custom') {
    var text = s(b.locationText);
    if (!text || text.length > 200) throw userError('Please say where you\'d like to meet.');
    location = { type: 'custom', text: text };
  } else {
    throw userError('Please choose where to meet.');
  }
  if (notes.length > 2000) throw userError('Please keep the notes under 2,000 characters.');
  if (tz.length > 60 || !/^[A-Za-z_+\-\/0-9]*$/.test(tz)) tz = '';
  return { name: name, title: title, email: email, phone: phone, notes: notes, duration: duration,
    start: start, location: location, timeZone: tz };
}

if (typeof module !== 'undefined') {
  module.exports = { datesBetween: datesBetween, weekdayOf: weekdayOf, buildSlots: buildSlots,
    subtractInterval: subtractInterval, cleanBooking: cleanBooking };
}
