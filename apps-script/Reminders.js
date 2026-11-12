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
  var sent = 0;
  (res.items || []).forEach(function (ev) {
    try {
      if (ev.status === 'cancelled') return;
      var p = privateProps_(ev);
      var kind = reminderKind(p, bookingInterval_(ev).start, now);
      if (!kind) return;
      // Mark first, so a failed email is never sent twice by the next run.
      var marked = Object.assign({}, p);
      marked[kind] = String(now);
      if (kind === 'r1' && !marked.r24) marked.r24 = 'skipped';
      Calendar.Events.patch({ extendedProperties: { private: marked } }, CONFIG.bookingCalendarId, ev.id);
      if (p.email) emailReminder_(ev, p, kind);
      else if (kind === 'r1' && p.phone) remindOwnerToCall_(ev, p);
      sent++;
    } catch (err) {
      console.error('reminder failed for ' + ev.id + ': ' + (err && err.stack ? err.stack : err));
    }
  });
  PropertiesService.getScriptProperties().setProperty('lastReminderRun', JSON.stringify({ at: now, sent: sent }));
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
