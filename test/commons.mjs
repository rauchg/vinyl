import assert from 'node:assert/strict';
import { COMMONS_ALBUMS, loadCommonsAlbum } from '../src/commons.js';

// Exercise the API boundary: Commons returns unordered pages, pagination, mixed
// file formats, and per-file licenses. None of these should corrupt album order.
const album = COMMONS_ALBUMS[0];
const pages = Array.from({ length: 32 }, (_, i) => ({
  title: `File:Kimiko Ishizaka - ${String(i + 1).padStart(2, '0')} - Track ${i + 1}.ogg`,
  imageinfo: [{ url: `https://upload.wikimedia.org/wikipedia/commons/test/${i}.ogg`,
    duration: 120, size: 2000000, mime: 'application/ogg', extmetadata: { License: { value: 'cc0' } } }],
}));
const originalFetch = globalThis.fetch;
const signal = new AbortController().signal;
try {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const params = new URL(url).searchParams;
    assert.equal(options.signal, signal);
    assert.equal(options.credentials, 'omit');
    assert.equal(params.get('origin'), '*');
    requests.push(params);
    return Response.json(params.has('gcmcontinue')
      ? { query: { pages: pages.slice(16).reverse() } }
      : { query: { pages: [...pages.slice(0, 16).reverse(), { title: 'File:Cover.jpg' }] }, continue: { gcmcontinue: 'next', continue: 'gcmcontinue||' } });
  };
  const tracks = await loadCommonsAlbum(album, signal);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].get('gcmcontinue'), 'next');
  assert.deepEqual(tracks.map(t => t.number), Array.from({ length: 32 }, (_, i) => i + 1));
  assert.equal(tracks[0].title, 'Track 1');

  for (const replacement of [
    { ...pages[0].imageinfo[0], extmetadata: { License: { value: 'cc-by-sa-4.0' } } },
    { ...pages[0].imageinfo[0], url: 'https://example.com/music.ogg' },
  ]) {
    globalThis.fetch = async () => Response.json({ query: { pages: [{ ...pages[0], imageinfo: [replacement] }, ...pages.slice(1)] } });
    await assert.rejects(loadCommonsAlbum(album, signal), /complete CC0 album/);
  }
  globalThis.fetch = async () => Response.json({ error: { code: 'ratelimited' } });
  await assert.rejects(loadCommonsAlbum(album, signal), /could not list/);
  globalThis.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(loadCommonsAlbum(album, signal), /unavailable/);
  console.log('Commons: pagination, ordering, license/source admission, and API failures passed');
} finally { globalThis.fetch = originalFetch; }
