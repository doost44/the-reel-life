// The Chrome version's look (web/js/eye/look-settings.js), run in Node for
// tools/check_look.py. Not for running on its own: reads JSON on stdin, writes JSON.

import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const look = await import(`${root}web/js/eye/look-settings.js`);
let text = '';
for await (const chunk of process.stdin) text += chunk;
const { categories, weights, shares, names } = JSON.parse(text);
look.setCategories(categories);
const fresh = look.defaultLook();
const now = {};
for (const [name, [start, full]] of Object.entries(fresh.values)) if (!name.includes('/')) now[name] = start + (full - start) * 0.4;
look.pushedValues(now, fresh, 0.4, shares);
process.stdout.write(JSON.stringify({
  look: fresh, described: look.describedLook(), shares: look.categoryShares(weights),
  values: names.map((name) => look.lookValue(fresh, name, 0.4, shares)), pushed: names.map((name) => now[name]),
}));
