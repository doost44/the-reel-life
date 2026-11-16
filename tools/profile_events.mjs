// The Chrome version's visit profile (web/js/eye/profile.js), run in Node on
// the events from tools/check_profile.py. Not for running on its own.
//
// Reads one line of JSON from stdin ({ settings, events }) and writes one
// line of JSON: the profile's message after each event.

import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { Profile } = await import(`${root}web/js/eye/profile.js`);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { settings, events } = JSON.parse(input);
const profile = new Profile(settings);
const out = [];
for (const [kind, ...args] of events) {
  if (kind === 'begin') profile.begin();
  else if (kind === 'end') profile.end();
  else if (kind === 'clear') profile.clearReels();
  else if (kind === 'swipe') profile.onSwipe({ t: args[0], direction: args[1] });
  else if (kind === 'reel') profile.addReel(...args);
  else if (kind === 'like') out.push(['liked', profile.like(...args)?.reel ?? null]);
  else if (kind === 'unlike') profile.unlike();
  else if (kind === 'classify') profile.classify(...args);
  else if (kind === 'captured') profile.captured(...args);
  out.push(profile.message());
}
process.stdout.write(`${JSON.stringify(out)}\n`);
