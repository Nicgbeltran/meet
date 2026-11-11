// Email reminders, 24 hours and 1 hour before each booking.
// Runs every 15 minutes once installReminderTrigger() has been run from the editor.

function sendReminders() {
  var now = Date.now();
  var res = Calendar.Events.list(CONFIG.bookingCalendarId, {
    privateExtendedProperty: 'meetBooking=1',
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + 25 * 3600000).toISOString(),
    singleEvents: true,
    maxResults: 100,
  });
  (res.items || []).forEach(function (ev) {
    if (ev.status === 'cancelled') return;
    var p = privateProps_(ev);
    var start = bookingInterval_(ev).start;
    var until = start - now;
    var lead = start - Number(p.bookedAt || 0);
    var kind = null;
    if (!p.r1 && until <= 75 * 60000 && lead > 2 * 3600000) kind = 'r1';
    else if (!p.r24 && until <= 24 * 3600000 && until > 75 * 60000 && lead > 25 * 3600000) kind = 'r24';
    if (!kind) return;
    if (p.email) emailReminder_(ev, p, kind);
    else if (kind === 'r1' && p.phone) remindOwnerToCall_(ev, p);
    p[kind] = String(now);
    if (kind === 'r1' && !p.r24) p.r24 = 'skipped';
    Calendar.Events.patch({ extendedProperties: { private: p } }, CONFIG.bookingCalendarId, ev.id);
  });
}

function emailReminder_(ev, p, kind) {
  var start = bookingInterval_(ev).start;
  var when = whenText_(start, p.timeZone);
  var soon = kind === 'r1' ? 'in about an hour' : 'tomorrow';
  var where = ev.hangoutLink ? 'Google Meet: ' + ev.hangoutLink : (ev.location || '');
  var body = [
    'Hi ' + (p.name || '').split(' ')[0] + ',',
    '',
    'A reminder that "' + ev.summary + '" with ' + CONFIG.ownerName + ' is ' + soon + '.',
    '',
    'When: ' + when,
    'Where: ' + where,
    '',
    'Need to cancel or reschedule? ' + manageUrl_(p.token),
  ].join('\n');
  MailApp.sendEmail({
    to: p.email,
    subject: 'Reminder: ' + ev.summary + ' ' + soon,
    body: body,
    name: CONFIG.ownerName,
  });
}

function remindOwnerToCall_(ev, p) {
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: 'In an hour: ' + ev.summary + ' (phone only: ' + p.phone + ')',
    body: p.name + ' booked with a phone number only, so they get no reminder email.\n' +
      'Phone: ' + p.phone + '\nWhen: ' + whenText_(bookingInterval_(ev).start),
    name: 'Booking page',
  });
}

// Run once from the Apps Script editor (Run > installReminderTrigger).
function installReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReminders').timeBased().everyMinutes(15).create();
}
