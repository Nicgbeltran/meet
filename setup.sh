#!/usr/bin/env bash
# One-time setup: creates the Apps Script backend on the personal Google account,
# deploys it as a web app, points the page at it, and publishes the page on GitHub Pages.
# Run after: clasp --user personal login   (sign in as nicgbeltran1@gmail.com)
set -euo pipefail
cd "$(dirname "$0")"

echo "== Google account clasp will use:"
clasp --user personal show-authorized-user

cd apps-script
if [ ! -f .clasp.json ]; then
  cp appsscript.json /tmp/meet-appsscript.json   # clasp create can overwrite the manifest
  clasp --user personal create --type standalone --title "Meet with Nico" --rootDir .
  cp /tmp/meet-appsscript.json appsscript.json
fi
clasp --user personal push --force

if grep -q REPLACE_WITH_DEPLOYMENT_ID ../docs/app.js; then
  DEPLOY_JSON=$(clasp --user personal --json deploy --description "v1")
  DEPLOY_ID=$(printf '%s' "$DEPLOY_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("deploymentId") or d.get("id") or d["deployment"]["deploymentId"])')
  sed -i '' "s/REPLACE_WITH_DEPLOYMENT_ID/$DEPLOY_ID/" ../docs/app.js
  echo "== Web app deployed: $DEPLOY_ID"
fi
cd ..

git add docs/app.js apps-script/.clasp.json && git commit -q -m "Point the page at the deployed backend" -- docs/app.js apps-script/.clasp.json || true

if ! gh repo view Nicgbeltran/meet >/dev/null 2>&1; then
  gh repo create Nicgbeltran/meet --public --source . --push --description "Meet with Nico: personal booking page"
  gh api -X POST repos/Nicgbeltran/meet/pages -f "source[branch]=main" -f "source[path]=/docs" >/dev/null
else
  git push -u origin main
fi

echo
echo "== Done. Last step: authorize the script and switch on reminders:"
echo "   clasp --user personal -P apps-script open-script"
echo "   then pick installReminderTrigger in the function menu, press Run, and approve the Google prompt."
echo "== Page (live in a minute or two): https://nicgbeltran.github.io/meet/"
