// Curated CC0 albums. Commons categories are not generally ordered albums: only
// these known filename patterns establish a complete, unambiguous track order.
export const COMMONS_ALBUMS = [
  { id: 'goldberg', title: 'Open Goldberg Variations', by: 'Kimiko Ishizaka', count: 32,
    category: 'The Open Goldberg Variations by Kimiko Ishizaka (album)',
    pattern: /^File:Kimiko Ishizaka - (\d+) - (.+)\.ogg$/ },
  { id: 'clavier', title: 'Well-Tempered Clavier, Book I', by: 'Kimiko Ishizaka', count: 48,
    category: 'Audio files of Open Well-Tempered Clavier, Book 1',
    pattern: /^File:Kimiko Ishizaka - Bach - Well-Tempered Clavier, Book 1 - (\d+) (.+)\.ogg$/ },
];

export const albumSource = (album) => 'https://commons.wikimedia.org/wiki/Category:' + encodeURIComponent(album.category);

export async function loadCommonsAlbum(album, signal) {
  const tracks = new Map();
  let continuation = {};
  do {
    const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', origin: '*',
      generator: 'categorymembers', gcmtitle: 'Category:' + album.category, gcmtype: 'file', gcmlimit: '50',
      prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', ...continuation });
    const response = await fetch('https://commons.wikimedia.org/w/api.php?' + params, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error('Commons is unavailable. Try the album again.');
    const data = await response.json();
    if (data.error) throw new Error('Commons could not list this album. Try again later.');
    for (const page of data.query?.pages || []) {
      const match = page.title.match(album.pattern), info = page.imageinfo?.[0];
      if (!match || !info) continue;
      // Read the recording's license, not the license of Commons page text.
      if (info.extmetadata?.License?.value !== 'cc0') continue;
      const url = new URL(info.url);
      if (url.protocol !== 'https:' || url.hostname !== 'upload.wikimedia.org') continue;
      if (!['application/ogg', 'audio/ogg'].includes(info.mime) || info.duration <= 0 || info.duration > 900 || info.size > 40e6) continue;
      const number = +match[1];
      tracks.set(number, { number, title: match[2], url: url.href, duration: info.duration,
        source: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(page.title) });
    }
    continuation = data.continue;
  } while (continuation);
  const ordered = [...tracks.values()].sort((a, b) => a.number - b.number);
  if (ordered.length !== album.count || ordered.some((track, i) => track.number !== i + 1)) {
    throw new Error('Commons no longer lists the complete CC0 album. Choose another album.');
  }
  return ordered;
}

// Prepare one whole track, independently of the file-import worker. Only the
// playing disc and one upcoming disc are retained; an album is never decoded at once.
export async function prepareCommonsTrack(track, cond, signal, progress = () => {}) {
  signal.throwIfAborted();
  progress('Downloading ' + track.title + '…');
  const response = await fetch(track.url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('Could not download this track. Select it to retry.');
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  progress('Decoding ' + track.title + '…');
  const audio = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes);
  signal.throwIfAborted();
  if (audio.duration > 900) throw new Error('This track is too long for one record.');
  const L = audio.getChannelData(0).slice(), R = audio.numberOfChannels > 1 ? audio.getChannelData(1).slice() : L.slice();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./master-worker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      signal.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('Could not cut this track. Select it to retry.'));
    worker.onmessage = ({ data }) => {
      if (data.t === 'status') progress(data.msg + '…');
      else if (data.t === 'error') finish(new Error('Could not cut this track. Select it to retry.'));
      else if (data.t === 'done') {
        if (data.rec.truncated) finish(new Error('This track does not fit on one record. Choose another track.'));
        else finish(null, data);
      }
    };
    worker.postMessage({ t: 'tracks', tracks: [{ L, R, title: track.title }], fs: 48000, cond }, [L.buffer, R.buffer]);
  });
}
