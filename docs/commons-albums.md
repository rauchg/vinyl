# Commons albums and local caching

Open Records, then select an album under **Albums from Wikimedia Commons**.
The player powers on, downloads and cuts the first track, and cues the needle.
Select any numbered track to jump to it or retry a failed download.
The next track is downloaded and cut while the current track plays. At the end
of each track the player changes the disc and cues it automatically. After the
last track it lifts the needle and stops the motor. Stop suppresses
automatic advancement; selecting a track explicitly starts it again.

## Sources and research

Commons is a file repository, not a streaming service with a universal album
model. This implementation starts with two curated, numbered recording sets:

- [The Open Goldberg Variations](https://commons.wikimedia.org/wiki/Category:The_Open_Goldberg_Variations_by_Kimiko_Ishizaka_(album)): 32 tracks, Kimiko Ishizaka.
- [Open Well-Tempered Clavier, Book 1](https://commons.wikimedia.org/wiki/Category:Audio_files_of_Open_Well-Tempered_Clavier,_Book_1): 48 tracks, Kimiko Ishizaka.

The [Aria recording](https://commons.wikimedia.org/wiki/File:Kimiko_Ishizaka_-_01_-_Aria.ogg)
and [first Prelude recording](https://commons.wikimedia.org/wiki/File:Kimiko_Ishizaka_-_Bach_-_Well-Tempered_Clavier,_Book_1_-_01_Prelude_No._1_in_C_major,_BWV_846.ogg)
identify the CC0 dedication. At runtime every included file must also report
`License=cc0` in its recording metadata. The shelf links to the current track's
Commons description page and credits its performer. Commons page-text licensing
is not treated as the recording's license.

[`src/commons.js`](../src/commons.js) follows these official APIs:

- [Categorymembers](https://www.mediawiki.org/wiki/API:Categorymembers): enumerate files, following continuation tokens.
- [Imageinfo](https://www.mediawiki.org/wiki/API:Imageinfo): resolve actual audio URLs, duration, MIME type, size and license metadata.
- [Cross-site requests](https://www.mediawiki.org/wiki/API:Cross-site_requests): anonymous browser requests with `origin=*` and omitted credentials.

Known filename patterns supply numeric ordering and exclude duplicate encodings
and unrelated category members. A missing or ineligible track rejects the album
instead of silently presenting an incomplete album. No credentials, backend,
external player SDK, or third-party runtime dependencies are needed. The audio
path reuses this project's file-import lathe and pressing worker rather than
introducing a second playback engine.

## Buffering and the simulated record

This is on-demand, track-by-track playback, not gapless streaming or incremental
groove cutting. Each entire track is decoded and cut before it plays. The
existing lathe uses whole-track look-ahead and produces fixed groove arrays.
Only one upcoming cut is retained, so long albums do not need to fit onto a
single side or in decoded memory at once. The current groove still drives all
sound, including pitch, scratching and volume. There is a short cueing gap at
track boundaries, and a longer wait if the next track is not ready.

Changing albums, jumping to a track, or choosing local audio cancels the old
queue and terminates its mastering worker. Late results cannot replace the new
selection. Background preparation errors are surfaced when that track is due;
selecting the track retries it. Tracks longer than 15 minutes, larger than 40 MB
in the catalog, or truncated by the lathe are rejected rather than silently cut
short. Ogg decoding depends on browser support.

## Cache behavior

[`sw.js`](../sw.js) uses the browser's Cache Storage for all successful application
GET requests: HTML, JavaScript (including workers), bundled record metadata,
visualization data and audio, Commons API responses and Commons audio files.
The app waits for the service worker before starting its first module and record
requests. Its small code shell is precached; other resources are cached as used.
Repeat requests are cache-first without background revalidation. HTTP failures,
partial responses and API error payloads are not saved as successful results.

After a successful download, the same track can be replayed offline, including
after reloading the app. A track that has never been downloaded still needs a
connection. This does not download all tracks in an album immediately. Decoded
audio and cut geometry are not persisted: offline replay cuts the cached audio
again. External source links open external websites and are not app downloads.

The browser checks for service-worker updates independently; that infrastructure
request and the first-ever page visit necessarily involve the network. HTTPS or
localhost is required. Downloads remain on this browser profile and origin
(including the local server's port). Storage persistence is requested when an
album is selected; the browser can decline. Storage failure is shown in the
shelf, and clearing site data or browser eviction can remove downloads.

`vinyl-app-commons-v1` holds application code and bundled resources. Bump `APP_CACHE`
when releasing changed code or bundled records. New workers wait until old tabs
close, then retire only older application caches. `vinyl-commons-v1` holds remote
metadata and recordings across application updates. Clear that cache in browser
site storage to refresh Commons metadata or download updated recordings.

References: [Service worker lifecycle and caching](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers),
[Cache Storage behavior](https://developer.mozilla.org/en-US/docs/Web/API/Cache),
[persistent storage requests](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).
