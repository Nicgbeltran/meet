// Everything about how the booking page behaves. Times are in CONFIG.timeZone.
var CONFIG = {
  ownerName: 'Nico',
  timeZone: 'America/Los_Angeles',
  pageUrl: 'https://nicgbeltran.github.io/meet/',

  // Bookings are created here ('primary' is Misc Events).
  bookingCalendarId: 'primary',
  // Every calendar on the account counts as busy except these (matched by name).
  ignoreCalendars: /^(Blocks|Todoist|Virtual Binder|.*\(Canvas\))/i,

  durations: [15, 30, 45, 60, 90, 120, 150, 180, 240],
  defaultDuration: 30,
  // Sunday first, like Date.getDay(); null means closed.
  hours: [
    ['07:00', '21:30'], // Sun
    ['07:00', '21:30'], // Mon
    ['07:00', '21:30'], // Tue
    ['07:00', '21:30'], // Wed
    ['07:00', '21:30'], // Thu
    ['07:00', '21:30'], // Fri
    ['07:00', '21:30'], // Sat
  ],
  slotStepMinutes: 15,
  bufferMinutes: 10,      // kept free before and after every booking
  minNoticeMinutes: 120,  // no bookings starting sooner than this
  maxDaysAhead: 60,
  maxBookingsPerDay: 20,  // simple spam brake
};
