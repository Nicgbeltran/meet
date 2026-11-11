# Meet with Nico

Nico's own booking page. People pick a length (15 min to 4 h), a time, a meeting
name and a place, and give an email, a phone number, or both. The booking lands
on Nico's Google Calendar.

- `docs/` is the page, served by GitHub Pages at https://nicgbeltran.github.io/meet/
- `apps-script/` is the backend, a Google Apps Script web app on nicgbeltran1@gmail.com.
  It reads busy times from every calendar except the ones in `CONFIG.ignoreCalendars`,
  creates the event (with a Google Meet link when asked), emails the guest an invite,
  emails Nico a notice, and sends reminder emails 24 h and 1 h before.
- Settings (hours, lengths, gaps, notice) live in `apps-script/Config.js`.

## Test

    node --test test/slots.test.js

Preview the page without Google: serve `docs/` locally and open `/?mock`
(mock mode only works on localhost).

## Deploy the backend

    cd apps-script
    clasp --user personal push --force
    clasp --user personal deploy --deploymentId <id> --description "update"

The first deployment's URL goes into `API` at the top of `docs/app.js`.
Reminders need a timer: open the script in the editor and run `installReminderTrigger` once.
