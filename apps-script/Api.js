// Web app entry points. Reads are GET, writes are POST with a JSON text body
// (text/plain keeps the browser from sending a CORS preflight).

function doGet(e) {
  return respond_(function () { return route_((e && e.parameter) || {}); });
}

function doPost(e) {
  return respond_(function () { return route_(JSON.parse((e && e.postData && e.postData.contents) || '{}')); });
}

function route_(p) {
  switch (p.action) {
    case 'config': return publicConfig_();
    case 'slots': return { slots: slotsBetween_(Number(p.start), Number(p.end), Number(p.duration), p.token) };
    case 'book': return book_(p);
    case 'booking': return { booking: describeBooking_(findBooking_(p.token)) };
    case 'cancel': return cancel_(p);
    case 'reschedule': return reschedule_(p);
  }
  throw userError('Unknown request.');
}

function respond_(fn) {
  var out;
  try {
    out = Object.assign({ ok: true }, fn());
  } catch (err) {
    if (!err.userMessage) console.error(err && err.stack ? err.stack : err);
    out = { ok: false, error: err.userMessage || 'Something went wrong on our side. Please try again in a minute.' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function publicConfig_() {
  return {
    ownerName: CONFIG.ownerName,
    durations: CONFIG.durations,
    defaultDuration: CONFIG.defaultDuration,
    maxDaysAhead: CONFIG.maxDaysAhead,
  };
}

// ---- availability ----

function slotsBetween_(startMs, endMs, duration, token) {
  if (CONFIG.durations.indexOf(duration) === -1) throw userError('Please pick one of the meeting lengths.');
  var now = Date.now();
  var latest = now + CONFIG.maxDaysAhead * 86400000;
  startMs = Math.max(startMs || now, now);
  endMs = Math.min(endMs || latest, latest + 86400000, startMs + 45 * 86400000);
  if (!(endMs > startMs)) return [];
  var busy = busyAround_(startMs, endMs, false);
  if (token) busy = subtractInterval(busy, bookingInterval_(findBooking_(token)));
  return slotsFor_(datesBetween(ownerDate_(startMs), ownerDate_(endMs)), duration, busy)
    .filter(function (t) { return t >= startMs && t < endMs; });
}

function slotIsOpen_(start, duration, ignore) {
  var busy = busyAround_(start, start + duration * 60000, true);
  if (ignore) busy = subtractInterval(busy, ignore);
  return slotsFor_([ownerDate_(start)], duration, busy).indexOf(start) !== -1;
}

function slotsFor_(dates, duration, busy) {
  var now = Date.now();
  return buildSlots({
    dates: dates,
    toUtcMs: ownerTimeToMs_,
    hours: CONFIG.hours,
    durationMin: duration,
    stepMin: CONFIG.slotStepMinutes,
    bufferMin: CONFIG.bufferMinutes,
    earliestMs: now + CONFIG.minNoticeMinutes * 60000,
    latestMs: now + CONFIG.maxDaysAhead * 86400000,
    busy: busy,
  });
}

// Busy times from every counted calendar, padded so slots near the edges are judged correctly.
function busyAround_(fromMs, toMs, fresh) {
  var pad = 26 * 3600000;
  fromMs = Math.floor((fromMs - pad) / 60000) * 60000;
  toMs = Math.ceil((toMs + pad) / 60000) * 60000;
  var cache = CacheService.getScriptCache();
  var key = 'fb:' + fromMs + ':' + toMs;
  if (!fresh) {
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  }
  var res = Calendar.Freebusy.query({
    timeMin: new Date(fromMs).toISOString(),
    timeMax: new Date(toMs).toISOString(),
    items: busyCalendarIds_().map(function (id) { return { id: id }; }),
  });
  var busy = [];
  Object.keys(res.calendars || {}).forEach(function (id) {
    var cal = res.calendars[id];
    if (cal.errors && cal.errors.length) console.warn('freebusy error for ' + id + ': ' + JSON.stringify(cal.errors));
    (cal.busy || []).forEach(function (b) { busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) }); });
  });
  try { cache.put(key, JSON.stringify(busy), 60); } catch (ignored) { /* too big to cache */ }
  return busy;
}

function busyCalendarIds_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('busyIds');
  if (hit) return JSON.parse(hit);
  var ids = CalendarApp.getAllCalendars()
    .filter(function (c) { return !CONFIG.ignoreCalendars.test(c.getName().trim()); })
    .map(function (c) { return c.getId(); });
  cache.put('busyIds', JSON.stringify(ids), 6 * 3600);
  return ids;
}

// ---- bookings ----

function book_(p) {
  var b = cleanBooking(p, CONFIG);
  checkDailyLimit_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!slotIsOpen_(b.start, b.duration)) throw userError('Sorry, that time was just taken. Please pick another one.');
    var token = Utilities.getUuid();
    var ev = Calendar.Events.insert(eventResource_(b, token), CONFIG.bookingCalendarId,
      { conferenceDataVersion: 1, sendUpdates: b.email ? 'all' : 'none' });
    countBooking_();
    notifyOwner_('New booking', ev);
    return { booking: describeBooking_(ev), token: token };
  } finally {
    lock.releaseLock();
  }
}

function cancel_(p) {
  var ev = findBooking_(p.token);
  if (bookingInterval_(ev).start < Date.now()) throw userError('This meeting has already started, so it can\'t be cancelled here.');
  Calendar.Events.remove(CONFIG.bookingCalendarId, ev.id, { sendUpdates: 'all' });
  notifyOwner_('Cancelled', ev);
  return { cancelled: true };
}

function reschedule_(p) {
  var ev = findBooking_(p.token);
  var old = bookingInterval_(ev);
  if (old.start < Date.now()) throw userError('This meeting has already started, so it can\'t be moved here.');
  var duration = (old.end - old.start) / 60000;
  var start = Number(p.start);
  if (!isFinite(start) || start % 60000 !== 0) throw userError('Please pick a time.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (!slotIsOpen_(start, duration, old)) throw userError('Sorry, that time was just taken. Please pick another one.');
    var priv = privateProps_(ev);
    priv.r24 = '';
    priv.r1 = '';
    priv.bookedAt = String(Date.now());
    var updated = Calendar.Events.patch({
      start: { dateTime: new Date(start).toISOString(), timeZone: CONFIG.timeZone },
      end: { dateTime: new Date(start + duration * 60000).toISOString(), timeZone: CONFIG.timeZone },
      extendedProperties: { private: priv },
    }, CONFIG.bookingCalendarId, ev.id, { sendUpdates: 'all' });
    notifyOwner_('Moved', updated);
    return { booking: describeBooking_(updated) };
  } finally {
    lock.releaseLock();
  }
}

function eventResource_(b, token) {
  var end = b.start + b.duration * 60000;
  var lines = ['Booked through ' + CONFIG.ownerName + '\'s booking page.', '', 'Who: ' + b.name];
  if (b.email) lines.push('Email: ' + b.email);
  if (b.phone) lines.push('Phone: ' + b.phone);
  lines.push('Where: ' + (b.location.type === 'meet' ? 'Google Meet (link in this invite)' : b.location.text));
  if (b.notes) lines.push('', 'Notes:', b.notes);
  lines.push('', 'Need to cancel or reschedule? ' + manageUrl_(token));
  var ev = {
    summary: b.title,
    description: lines.join('\n'),
    start: { dateTime: new Date(b.start).toISOString(), timeZone: CONFIG.timeZone },
    end: { dateTime: new Date(end).toISOString(), timeZone: CONFIG.timeZone },
    attendees: b.email ? [{ email: b.email, displayName: b.name }] : [],
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    reminders: { useDefault: true },
    extendedProperties: { private: {
      meetBooking: '1', token: token, name: b.name, email: b.email, phone: b.phone,
      timeZone: b.timeZone, bookedAt: String(Date.now()), r24: '', r1: '',
    } },
  };
  if (b.location.type === 'meet') {
    ev.conferenceData = { createRequest: { requestId: token, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  } else {
    ev.location = b.location.text;
  }
  return ev;
}

function findBooking_(token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) throw userError('That booking link isn\'t valid.');
  var res = Calendar.Events.list(CONFIG.bookingCalendarId,
    { privateExtendedProperty: 'token=' + token, maxResults: 1, singleEvents: true });
  var ev = (res.items || [])[0];
  if (!ev || ev.status === 'cancelled') throw userError('This booking was cancelled or no longer exists.');
  return ev;
}

function describeBooking_(ev) {
  var t = bookingInterval_(ev);
  return {
    title: ev.summary,
    start: t.start,
    end: t.end,
    duration: (t.end - t.start) / 60000,
    where: ev.hangoutLink ? 'Google Meet' : (ev.location || ''),
    meetUrl: ev.hangoutLink || '',
    name: privateProps_(ev).name || '',
  };
}

function bookingInterval_(ev) {
  return { start: Date.parse(ev.start.dateTime), end: Date.parse(ev.end.dateTime) };
}

function privateProps_(ev) {
  return Object.assign({}, (ev.extendedProperties && ev.extendedProperties.private) || {});
}

// ---- helpers ----

function ownerTimeToMs_(date, time) {
  return Utilities.parseDate(date + ' ' + time, CONFIG.timeZone, 'yyyy-MM-dd HH:mm').getTime();
}

function ownerDate_(ms) {
  return Utilities.formatDate(new Date(ms), CONFIG.timeZone, 'yyyy-MM-dd');
}

function manageUrl_(token) {
  return CONFIG.pageUrl + '?booking=' + token;
}

function whenText_(ms, tz) {
  var zone = tz || CONFIG.timeZone;
  try {
    return Utilities.formatDate(new Date(ms), zone, 'EEE MMM d, h:mm a z');
  } catch (e) {
    return Utilities.formatDate(new Date(ms), CONFIG.timeZone, 'EEE MMM d, h:mm a z');
  }
}

function checkDailyLimit_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('count:' + ownerDate_(Date.now())) || 0);
  if (n >= CONFIG.maxBookingsPerDay) throw userError('The booking page is taking a break for today. Please try again tomorrow.');
}

function countBooking_() {
  var props = PropertiesService.getScriptProperties();
  var key = 'count:' + ownerDate_(Date.now());
  props.setProperty(key, String(Number(props.getProperty(key) || 0) + 1));
}

function notifyOwner_(what, ev) {
  var p = privateProps_(ev);
  var t = bookingInterval_(ev);
  var body = [
    what + ': ' + ev.summary,
    'When: ' + whenText_(t.start) + ' (' + (t.end - t.start) / 60000 + ' min)',
    'Who: ' + (p.name || ''),
    'Email: ' + (p.email || '-'),
    'Phone: ' + (p.phone || '-'),
    'Where: ' + (ev.hangoutLink || ev.location || ''),
    '',
    'Calendar: ' + (ev.htmlLink || ''),
  ].join('\n');
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: what + ': ' + ev.summary + ' (' + whenText_(t.start) + ')',
    body: body,
    name: 'Booking page',
  });
}
