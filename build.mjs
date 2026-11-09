// Builds the static site into dist/: the page, its modules, the precompiled records (assets/) and their
// audio (records/). There is no bundler: the browser loads src/ as is. Records are cut ahead of time by
// lathe.mjs and committed, so this only checks that every record on the shelf has been cut.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORDS } from './src/records.js';

const root = fileURLToPath(new URL('.', import.meta.url)), dist = join(root, 'dist');

const missing = RECORDS.map((r) => (r.tracks ? `assets/${r.id}/record.json` : 'assets/record.json')).filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error(`not cut yet: ${missing.join(', ')}\nrun \`npm run lathe\` (needs ffmpeg) and commit assets/`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
const skip = (src) => !/(\.building|\.tmp)$/.test(src);
for (const f of ['index.html', 'sw.js', 'og.png', 'src', 'assets', 'records']) cpSync(join(root, f), join(dist, f), { recursive: true, filter: skip });
console.log(`dist/: index.html, src/, assets/ (${RECORDS.length} records), records/`);
