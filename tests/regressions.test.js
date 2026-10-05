const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { escapeHTML, writeBatch, PlaybackQueue, TrackClicks } = require('../renderer-core');
const { createLibrary, absolutePath, audioFile } = require('../music-library');
const { createPhoneSync, fileIdentity, playlistFolder } = require('../phone-sync');
const { createArtworkSearch, readLimited } = require('../artwork-search');

async function audioVisualizer() {
  const source = await fs.readFile(path.join(__dirname, '../visualizer.js'), 'utf8');
  const Visualizer = vm.runInNewContext(`${source.slice(source.indexOf('class MusicVisualizer'), source.indexOf('const musicVisualizer'))}; MusicVisualizer`);
  const visualizer = Object.create(Visualizer.prototype);
  const input = new Float32Array(1024).fill(-Infinity);
  Object.assign(visualizer, {
    audio: { paused: false, ended: false }, motion: { matches: false },
    analysis: { context: { sampleRate: 48000 } },
    analyser: { fftSize: 2048, getFloatFrequencyData: output => output.set(input), getByteTimeDomainData: output => output.fill(128) },
    spectrum: new Float32Array(1024), previousSpectrum: new Float32Array(1024), waveform: new Uint8Array(2048)
  });
  visualizer.resetAudio();
  return { visualizer, input };
}

test('beat detection follows repeated drum attacks at different volumes and frame rates', async () => {
  for (const amplitude of [0.025, 0.25]) {
    for (const fps of [30, 60]) {
      const { visualizer, input } = await audioVisualizer();
      const hits = [];
      for (let frame = 0; frame < fps * 2; frame++) {
        const phase = frame % (fps / 2);
        const bass = amplitude * Math.exp(-phase / fps / 0.07);
        input.fill(-Infinity);input.fill(20 * Math.log10(bass), 1, 10);
        visualizer.readAudio(1 / fps);
        if (visualizer.beatAge === 0) hits.push(frame);
        if (phase === 0) assert(visualizer.beat > 0.7, `Missed attack at ${amplitude}, ${fps} fps`);
        if (phase === fps / 2 - 1) assert(visualizer.beat < 0.2);
      }
      assert.deepEqual(hits, [0, fps / 2, fps, fps * 1.5]);
    }
  }
});

test('held tones and silence do not generate repeated beats; pause and track changes clear the response', async () => {
  const { visualizer, input } = await audioVisualizer();
  for (let frame = 0; frame < 30; frame++) visualizer.readAudio();
  assert.equal(visualizer.beat, 0);assert.equal(visualizer.bass, 0);
  input.fill(-20, 1, 10);
  visualizer.readAudio();assert(visualizer.beat > 0.7);assert(visualizer.bass > 0.5);
  for (let frame = 0; frame < 60; frame++) {
    visualizer.readAudio();assert(visualizer.beatAge > 0);
  }
  assert(visualizer.beat < 0.001);
  visualizer.audio.paused = true;
  for (let frame = 0; frame < 30; frame++) visualizer.readAudio();
  assert(visualizer.bass < 0.01);assert(visualizer.waveform.every(value => value === 128));
  visualizer.resetAudio();
  assert.equal(visualizer.bass, 0);assert.equal(visualizer.beat, 0);
  assert(visualizer.previousSpectrum.every(value => value === 0));
});

test('cover search ranks the tagged album, skips missing covers, and binds expiring selections to the file', async () => {
  const ids = [1, 2, 3].map(number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`);
  let clock = 10000;
  const requests = [];
  const service = createArtworkSearch({ interval: 0, now: () => clock, userAgent: 'Test',
    fetch: async url => {
      requests.push(url);
      if (url.includes('/ws/2/release?')) return Response.json({ releases: [] });
      if (url.includes('musicbrainz.org')) return Response.json({ recordings: [
        { title: 'Song', score: 100, 'artist-credit': [{ artist: { name: 'Wrong artist' } }], releases: [{ id: ids[2], title: 'Wrong' }] },
        { title: 'Song', score: 100, 'artist-credit': [{ artist: { name: 'Artist' } }], releases: [{ id: ids[0], title: 'Other' }, { id: ids[1], title: 'Album' }, { id: '../unsafe', title: 'Bad' }] }
      ] });
      return url.includes(ids[1]) ? new Response('', { status: 404 }) : new Response('cover');
    },
    prepareCover: buffer => ({ buffer, preview: 'data:image/png;base64,Y292ZXI=' })
  });
  const { covers: results } = await service.search({ filePath: '/song.mp3', title: 'Song', artist: 'Artist', album: 'Album' });
  assert.equal(results.length, 1);assert.equal(results[0].album, 'Other');
  assert(requests.filter(url => url.includes('coverartarchive.org'))[0].includes(ids[1]));assert.equal(requests.length, 4);
  assert.equal(service.selectedCover('/song.mp3', results[0].token).toString(), 'cover');
  assert.throws(() => service.selectedCover('/another.mp3', results[0].token), /expired/);
  clock += 10 * 60 * 1000 + 1;
  assert.throws(() => service.selectedCover('/song.mp3', results[0].token), /expired/);
  await assert.rejects(service.search({ filePath: '/song.mp3', title: '', artist: 'Artist' }), /song title/);
});

test('cover search handles no matches, service errors, and bounded responses', async () => {
  const service = fetch => createArtworkSearch({ fetch, interval: 0, prepareCover: () => null });
  const query = { filePath: '/song.mp3', title: 'Song', artist: 'Artist' };
  assert.deepEqual((await service(async () => Response.json({ recordings: [] })).search(query)).covers, []);
  await assert.rejects(service(async () => new Response('', { status: 503 })).search(query), /unavailable/);
  await assert.rejects(readLimited(new Response('Too long'), 3), /too much data/);
  await assert.rejects(readLimited(new Response('x', { headers: { 'Content-Length': '100' } }), 3), /too much data/);
});

const coverId = number => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const coverCredit = [{ artist: { name: 'Artist' } }];
const testCover = buffer => ({ buffer, preview: `data:image/png;base64,${buffer.toString('base64')}` });
const coverQuery = { filePath: '/song.mp3', title: 'Song', artist: 'Artist' };

test('cover search prefers the tagged album, studio albums and earlier releases; groups duplicate editions', async () => {
  const releases = [
    { id: coverId(1), title: 'Greatest Hits', status: 'Official', date: '2020', 'release-group': { id: coverId(101), 'primary-type': 'Album', 'secondary-types': ['Compilation'] } },
    { id: coverId(2), title: 'Later Album', status: 'Official', date: '2010', 'release-group': { id: coverId(102), 'primary-type': 'Album' } },
    { id: coverId(3), title: 'Original Album', status: 'Official', date: '1990', 'release-group': { id: coverId(103), 'primary-type': 'Album' } },
    { id: coverId(4), title: 'Original Album', status: 'Official', date: '1991', 'release-group': { id: coverId(103), 'primary-type': 'Album' } },
    { id: coverId(5), title: 'Live Album', status: 'Official', date: '1989', 'release-group': { id: coverId(105), 'primary-type': 'Album', 'secondary-types': ['Live'] } }
  ];
  const service = createArtworkSearch({ interval: 0, prepareCover: testCover,
    fetch: async url => url.includes('musicbrainz.org') ? Response.json({ recordings: [{ title: 'Song', score: 100, 'artist-credit': coverCredit, releases }] }) : new Response(url)
  });
  const first = await service.search(coverQuery);
  assert.deepEqual(first.covers.map(cover => cover.album), ['Original Album', 'Later Album', 'Live Album', 'Greatest Hits']);
  assert.equal(first.hasMore, false);
  assert.equal(first.covers[0].reason, 'Studio album');
  const tagged = await service.search({ ...coverQuery, album: 'Greatest Hits' });
  assert.equal(tagged.covers[0].album, 'Greatest Hits');
  assert.equal(tagged.covers[0].reason, 'Matches album name');
});

test('cover search finds a tagged album missing from song results and falls back across editions', async () => {
  const requests = [];
  const group = { id: coverId(100), title: 'Original Album', 'primary-type': 'Album' };
  const service = createArtworkSearch({ interval: 0, prepareCover: testCover, fetch: async url => {
    requests.push(url);
    if (url.includes('/recording?')) return Response.json({ recordings: [] });
    if (url.includes('/ws/2/release?')) return Response.json({ releases: [
      { id: coverId(1), title: 'Original Album', date: '1990', 'artist-credit': coverCredit, 'release-group': group },
      { id: coverId(2), title: 'Original Album (Deluxe Edition)', date: '2000', 'artist-credit': coverCredit, 'release-group': group },
      { id: coverId(3), title: 'Original Album', 'artist-credit': [{ artist: { name: 'Wrong Artist' } }] }
    ] });
    return url.includes(`/release/${coverId(2)}/`) ? new Response('correct cover') : new Response('', { status: 404 });
  } });
  const page = await service.search({ ...coverQuery, album: 'Original Album' });
  assert.equal(page.covers.length, 1);assert.equal(page.covers[0].album, 'Original Album');
  assert.equal(service.selectedCover(coverQuery.filePath, page.covers[0].token).toString(), 'correct cover');
  assert.equal(requests.filter(url => url.includes('coverartarchive.org')).length, 3);
  assert.equal(new URL(requests[1]).searchParams.get('query'), 'release:"Original Album" AND artist:"Artist"');
});

test('cover search browses matching recordings to find studio albums outside the search release list', async () => {
  const requests = [];
  const service = createArtworkSearch({ interval: 0, prepareCover: testCover, fetch: async url => {
    requests.push(url);
    if (url.includes('/recording?')) return Response.json({ recordings: [{ id: coverId(50), title: 'Song', score: 100, 'artist-credit': coverCredit,
      releases: [{ id: coverId(1), title: 'Top Hits', 'release-group': { 'primary-type': 'Album', 'secondary-types': ['Compilation'] } }] }] });
    if (url.includes('/ws/2/release?')) return Response.json({ releases: [{ id: coverId(2), title: 'Original Album', 'release-group': { id: coverId(100), 'primary-type': 'Album' } }] });
    return new Response(url);
  } });
  const page = await service.search({ ...coverQuery, album: 'Local files' });
  assert.deepEqual(page.covers.map(cover => cover.album), ['Original Album', 'Top Hits']);
  assert.equal(new URL(requests[0]).searchParams.get('limit'), '100');
  assert.equal(new URL(requests[1]).searchParams.get('recording'), coverId(50));
  assert.equal(new URL(requests[1]).searchParams.get('inc'), 'release-groups+artist-credits');
});

test('cover pages continue without repeating searches or albums and earlier selections remain saveable', async () => {
  let clock = 10000, metadataRequests = 0;
  const service = createArtworkSearch({ interval: 0, now: () => clock, prepareCover: testCover, fetch: async url => {
    if (url.includes('musicbrainz.org')) {
      metadataRequests++;
      return Response.json({ recordings: [{ title: 'Song', score: 100, 'artist-credit': coverCredit,
        releases: Array.from({ length: 25 }, (_, index) => ({ id: coverId(index + 1), title: `Album ${index + 1}` })) }] });
    }
    return new Response(url);
  } });
  const first = await service.search(coverQuery), pages = [first];
  assert.equal(first.covers.length, 4);assert.equal(first.hasMore, true);
  while (pages.at(-1).hasMore) pages.push(await service.search({ filePath: coverQuery.filePath, cursor: first.cursor }));
  const covers = pages.flatMap(page => page.covers);
  assert.equal(covers.length, 25);assert.equal(new Set(covers.map(cover => cover.album)).size, 25);
  assert.equal(metadataRequests, 1);assert.equal(pages.at(-1).covers.length, 1);
  assert(service.selectedCover(coverQuery.filePath, first.covers[0].token).length > 0);
  await assert.rejects(service.search({ filePath: '/another.mp3', cursor: first.cursor }), /expired/);
  clock += 10 * 60 * 1000 + 1;
  await assert.rejects(service.search({ filePath: coverQuery.filePath, cursor: first.cursor }), /expired/);
  assert.throws(() => service.selectedCover(coverQuery.filePath, first.covers[0].token), /expired/);
});

test('cover paging can continue past twelve missing albums and retry transient failures', async () => {
  let broken = false;
  const service = createArtworkSearch({ interval: 0, prepareCover: testCover, fetch: async url => {
    if (url.includes('musicbrainz.org')) return Response.json({ recordings: [{ title: 'Song', score: 100, 'artist-credit': coverCredit,
      releases: Array.from({ length: 17 }, (_, index) => ({ id: coverId(index + 1), title: `Album ${index + 1}` })) }] });
    const id = Number(url.match(/-([0-9]{12})\//)[1]);
    if (id <= 12) return new Response('', { status: 404 });
    return broken ? new Response('', { status: 503 }) : new Response(url);
  } });
  const first = await service.search(coverQuery);
  assert.equal(first.covers.length, 0);assert.equal(first.hasMore, true);
  broken = true;
  await assert.rejects(service.search({ filePath: coverQuery.filePath, cursor: first.cursor }), /could not be downloaded/);
  broken = false;
  const next = await service.search({ filePath: coverQuery.filePath, cursor: first.cursor });
  assert.equal(next.covers.length, 4);assert.equal(next.hasMore, true);
  const last = await service.search({ filePath: coverQuery.filePath, cursor: first.cursor });
  assert.equal(last.covers.length, 1);assert.equal(last.hasMore, false);
});

test('text and attribute escaping preserves quotes without introducing attributes', () => {
  assert.equal(escapeHTML('Song "Live" & <remix>\'s'), 'Song &quot;Live&quot; &amp; &lt;remix&gt;&#39;s');
  assert.equal(escapeHTML('" onclick="bad()'), '&quot; onclick=&quot;bad()');
});

test('IPC accepts only the main local document and rejects other windows or frames', async () => {
  const source = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
  const sender = { mainFrame: { url: 'file:///nightwave/index.html' } };
  const context = { pageUrl: 'file:///nightwave/index.html', mainWindow: { isDestroyed: () => false, webContents: sender } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function validateSender('), source.indexOf('function handle(')), context);
  context.validateSender({ sender, senderFrame: sender.mainFrame });
  sender.mainFrame.url += '#fragment';context.validateSender({ sender, senderFrame: sender.mainFrame });
  assert.throws(() => context.validateSender({ sender: {}, senderFrame: sender.mainFrame }));
  assert.throws(() => context.validateSender({ sender, senderFrame: { url: 'file:///nightwave/index.html' } }));
  sender.mainFrame.url = 'https://untrusted.example/';
  assert.throws(() => context.validateSender({ sender, senderFrame: sender.mainFrame }));
});

test('fast clicks play and slow clicks edit only the same field', () => {
  const clicks = new TrackClicks();
  assert.equal(clicks.click('a', 'title', 0), null);
  assert.equal(clicks.click('a', 'title', 200), 'play');
  assert.equal(clicks.click('a', 'artist', 1000), null);
  assert.equal(clicks.click('a', 'artist', 1600), 'edit');
  clicks.click('a', 'artist', 2000);
  assert.equal(clicks.click('a', 'album', 2600), null);
  clicks.click('a', 'title', 4000);
  assert.equal(clicks.click('a', 'title', 5100), null);
  assert.equal(clicks.click('a', 'title', 5200, true), null);
  assert.equal(clicks.click('a', 'title', 5300), null);
  assert.equal(clicks.click('b', 'title', 5400), null);
});

test('playback order is a snapshot independent of later browsing', () => {
  const queue = new PlaybackQueue();
  const visible = ['a', 'b', 'c'];
  queue.start(visible, 'b');visible.splice(0, 3, 'other-playlist');
  assert.equal(queue.move(), 'c');
  assert.equal(queue.move(), 'a');
  assert.equal(queue.move(true), 'c');
});

test('shuffle visits every song, avoids immediate repeats, and retraces Previous', () => {
  const queue = new PlaybackQueue(() => 0.25);
  queue.start(['a', 'b', 'c', 'd'], 'a', true);
  const second = queue.move(), third = queue.move();
  assert.notEqual(second, 'a');assert.notEqual(third, second);
  assert.equal(queue.move(true), second);assert.equal(queue.move(), third);
  const cycle = [third, queue.move(), queue.move(), queue.move()];
  assert.equal(new Set(cycle).size, 4);
  const current = queue.order[queue.index];queue.setShuffle(false);
  assert.equal(queue.order[queue.index], current);
});

test('unloading a queued song does not break subsequent navigation', () => {
  const queue = new PlaybackQueue();queue.start(['a', 'b', 'c'], 'a');
  queue.prune(new Set(['a', 'c']));assert.equal(queue.move(), 'c');
  queue.prune(new Set(['a']));assert.equal(queue.move(), 'a');
});

test('writes wait for commit and reject an abort after request success', async () => {
  let tx;
  const calls = [];
  const database = { transaction: () => tx = { objectStore: () => ({ put: value => calls.push(value) }) } };
  let settled = false;
  const pending = writeBatch(database, 'playlists', [{ id: 'a' }, { id: 'b' }]).then(() => { settled = true; });
  await Promise.resolve();assert.equal(settled, false);assert.equal(calls.length, 2);
  tx.oncomplete();await pending;assert.equal(settled, true);
  const failed = writeBatch(database, 'playlists', [{ id: 'c' }]);
  tx.error = new Error('disk failure');tx.onabort();
  await assert.rejects(failed, /disk failure/);
});

test('bulk deletion and clear each use a single transaction', async () => {
  let transactions = 0;
  const operations = [];
  const database = { transaction: () => {
    transactions++;
    const tx = { objectStore: () => ({ clear: () => operations.push('clear'), delete: key => operations.push(key) }) };
    queueMicrotask(() => tx.oncomplete());return tx;
  } };
  await writeBatch(database, 'tracks', [], ['a', 'b']);
  await writeBatch(database, 'tracks', [], [], true);
  assert.equal(transactions, 2);assert.deepEqual(operations, ['a', 'b', 'clear']);
});

test('scanning bounds metadata work, caches unchanged files, and retries changed files', async () => {
  let active = 0, peak = 0, parses = 0, version = 1;
  const entries = Array.from({ length: 25 }, (_, i) => ({ name: `${i}.mp3`, isDirectory: () => false, isFile: () => true }));
  const library = createLibrary({
    fileSystem: { readdir: async () => entries, stat: async () => ({ isFile: () => true, size: 10, mtimeMs: version, ctimeMs: version }) },
    parseFile: async () => {
      peak = Math.max(peak, ++active);parses++;
      await new Promise(resolve => setImmediate(resolve));active--;
      return { common: { title: 'Parsed' }, native: {}, format: { duration: 5 } };
    }
  });
  const progress = [];
  const result = await library.readMusicFolders(['/music'], value => progress.push(value));
  assert.equal(result.tracks.length, 25);assert(peak <= 4);assert.equal(parses, 25);
  await library.readMusicFolders(['/music']);assert.equal(parses, 25);
  version++;await library.readMusicFolders(['/music']);assert.equal(parses, 50);
  assert.equal(progress.at(-1).completed, 25);
});

test('library timed-lyrics status distinguishes SYLT, LRC, plain lyrics and changed tags', async () => {
  let version=1, lyrics=[], parses=0;
  const library=createLibrary({
    fileSystem:{stat:async()=>({isFile:()=>true,size:10,mtimeMs:version,ctimeMs:version})},
    parseFile:async()=>{parses++;return {common:{lyrics},format:{duration:5}}}
  });
  const read=()=>library.readTrack('/music/lyrics.mp3');
  assert.equal((await read()).hasTimedLyrics,false);
  lyrics=[{contentType:1,timeStampFormat:2,syncText:[{text:'Timed verse',timestamp:1000}]}];version++;
  assert.equal((await read()).hasTimedLyrics,true);
  assert.equal((await read()).hasTimedLyrics,true);
  assert.equal(parses,2);
  lyrics=[{text:'[00:01.20]LRC verse'}];version++;
  assert.equal((await read()).hasTimedLyrics,true);
  lyrics=[{text:'Plain verse'}];version++;
  assert.equal((await read()).hasTimedLyrics,false);
  lyrics=[{text:'[00:01.20]'}];version++;
  assert.equal((await read()).hasTimedLyrics,false);
});

test('embedded artwork prefers the front cover, is cached, and updates with file changes', async () => {
  let version=1,parses=0,conversions=0;
  const back={type:'Cover (back)',data:Buffer.from('back')},front={type:'Cover (front)',data:Buffer.from('front')};
  const library=createLibrary({
    fileSystem:{stat:async()=>({isFile:()=>true,size:10,mtimeMs:version,ctimeMs:version})},
    parseFile:async (_file,options)=>{parses++;assert.equal(options.skipCovers,false);return {common:{title:'Song',picture:version===1?[back,front]:[]},format:{duration:5}}},
    createThumbnail:picture=>{conversions++;assert.equal(picture,front);return 'thumbnail'}
  });
  assert.equal((await library.readTrack('/music/cover.mp3')).artwork,'thumbnail');
  assert.equal((await library.readTrack('/music/cover.mp3')).artwork,'thumbnail');
  assert.equal(parses,1);assert.equal(conversions,1);
  version++;
  assert.equal((await library.readTrack('/music/cover.mp3')).artwork,null);
});

test('a damaged embedded cover preserves readable song metadata', async () => {
  const library=createLibrary({
    fileSystem:{stat:async()=>({isFile:()=>true,size:10,mtimeMs:1})},
    parseFile:async()=>({common:{title:'Song',artist:'Artist',picture:[{data:Buffer.from('bad')}]},format:{duration:5}}),
    createThumbnail:()=>{throw Error('Bad image')}
  });
  const track=await library.readTrack('/music/bad-cover.mp3');
  assert.equal(track.title,'Song');assert.equal(track.artist,'Artist');assert.equal(track.artwork,null);
});

test('an unreadable subfolder does not discard readable siblings', async () => {
  const library = createLibrary({ fileSystem: {
    readdir: async directory => {
      if (directory.endsWith('locked')) throw Error('permission denied');
      return [{ name: 'good.mp3', isDirectory: () => false, isFile: () => true }, { name: 'locked', isDirectory: () => true, isFile: () => false }];
    },
    stat: async () => ({ isFile: () => true, size: 10, mtimeMs: 1 })
  }, parseFile: async () => { throw Error('missing metadata'); } });
  const result = await library.readMusicFolders(['/music']);
  assert.equal(result.tracks.length, 1);assert.deepEqual(result.unavailableFolders, ['/music/locked']);
});

test('file identities distinguish same-name and same-size content; unsafe paths are rejected', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightwave-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'a'));await fs.mkdir(path.join(directory, 'b'));
  const a = path.join(directory, 'a', 'Intro.mp3'), b = path.join(directory, 'b', 'Intro.mp3');
  await fs.writeFile(a, 'aaaa');await fs.writeFile(b, 'bbbb');
  const first = await fileIdentity(a), second = await fileIdentity(b);
  assert.notEqual(first.name, second.name);assert.equal(first.size, second.size);
  assert.deepEqual(await fileIdentity(a), first);
  assert.equal(await audioFile(a), a);
  assert.throws(() => absolutePath('relative.mp3'));
  await assert.rejects(audioFile(path.join(directory, 'not-music.txt')));
  const target = path.join(directory, 'secret.txt');await fs.writeFile(target, 'secret');
  const link = path.join(directory, 'disguised.mp3');await fs.symlink(target, link);
  await assert.rejects(audioFile(link));
  assert.throws(() => playlistFolder('..'));assert.throws(() => playlistFolder(' .. '));
  assert(!decodeURIComponent(playlistFolder('../Other')).includes('/'));
});

test('GIO sync distinguishes songs, skips verified copies, repairs partial files, and reaches 100%', async () => {
  const remote = new Map();let copies = 0;
  const identify = async file => ({ name: `Intro [${file.includes('/a/') ? 'a'.repeat(16) : 'b'.repeat(16)}].mp3`, size: 100 });
  const sync = createPhoneSync({ identify, runCommand: async (_command, args) => {
    if (args[0] === 'info') {
      const key = args.at(-1);if (!remote.has(key)) throw Error('missing');
      return `standard::size: ${remote.get(key)}`;
    }
    if (args[0] === 'copy') { copies++;remote.set(args.at(-1), 100); }
    return '';
  } });
  const progress = [], paths = ['/a/Intro.mp3', '/b/Intro.mp3'];
  const first = await sync.transfer(paths, 'mtp://test/', 'gio', count => progress.push(count));
  assert.equal(first.copied, 2);assert.equal(remote.size, 2);assert.equal(progress.at(-1), 2);
  const second = await sync.transfer(paths, 'mtp://test/', 'gio');assert.equal(second.skipped, 2);
  remote.set([...remote.keys()][0], 10);
  const repaired = await sync.transfer(paths, 'mtp://test/', 'gio');assert.equal(repaired.copied, 1);assert.equal(repaired.skipped, 1);assert.equal(copies, 3);
});

test('KIO sync verifies hashes and overwrites corrupt existing copies', async () => {
  const hash = 'a'.repeat(16), remote = new Map();let copies = 0;
  const sync = createPhoneSync({ identify: async () => ({ name: `Intro [${hash}].mp3`, size: 100 }), runCommand: async (_command, args, options) => {
    if (args.includes('cat')) { assert.equal(options.hash, true);if(!remote.has(args.at(-1)))throw Error('missing');return remote.get(args.at(-1)); }
    if (args.includes('copy')) { assert(args.includes('--overwrite'));copies++;remote.set(args.at(-1), hash); }
    return '';
  } });
  assert.equal((await sync.transfer(['/a/Intro.mp3'], 'mtp:/test/', 'kio')).copied, 1);
  assert.equal((await sync.transfer(['/a/Intro.mp3'], 'mtp:/test/', 'kio')).skipped, 1);
  remote.set([...remote.keys()][0], 'b'.repeat(16));
  assert.equal((await sync.transfer(['/a/Intro.mp3'], 'mtp:/test/', 'kio')).copied, 1);assert.equal(copies, 2);
});

test('the worker reports truthy node-id3 errors as failures', async () => {
  const messages = [];
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../tag-worker.js'), 'utf8'), {
    require: name => {
      if(name === 'node:worker_threads')return { parentPort: { postMessage: message => messages.push(message) }, workerData: { tags: {}, filePath: '/fake.mp3' } };
      if(name.endsWith('ID3Definitions'))return {ID3_FRAME_OPTIONS:{APIC:{multiple:false}}};
      if(name.endsWith('ID3Frames'))return {APIC:{create:()=>Buffer.alloc(0)}};
      return { update: () => new Error('write failed') };
    }
  });
  assert.equal(messages[0].ok, false);
});

test('real tag worker writes tags and reports missing-file errors', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightwave-tags-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'song.mp3');await fs.writeFile(filePath, Buffer.alloc(100));
  const run = target => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '../tag-worker.js'), { workerData: { filePath: target, tags: { title: 'Song "Live"', artist: 'Artist' } } });
    worker.once('message', resolve);worker.once('error', reject);
  });
  assert.equal((await run(filePath)).ok, true);
  assert.equal(require('node-id3').read(filePath).title, 'Song "Live"');
  assert.equal((await run(path.join(directory, 'missing.mp3'))).ok, false);
});

test('cover writes replace front images and preserve back images, text tags, and audio bytes', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nightwave-artwork-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const NodeID3=require('node-id3'),filePath=path.join(directory,'song.mp3');
  const picture=(id,data)=>({mime:'image/jpeg',type:{id},description:`Picture ${id}`,imageBuffer:Buffer.from(data)});
  const first=NodeID3.create({title:'Song',artist:'Artist',album:'Album',image:picture(3,'old-front')});
  const back=NodeID3.create({image:picture(4,'back')}).subarray(10);
  const frames=Buffer.concat([first.subarray(10),back]),header=Buffer.from(first.subarray(0,10));
  for(let i=0;i<4;i++)header[9-i]=(frames.length>>>(7*i))&127;
  const audioBytes=Buffer.alloc(100,42);
  await fs.writeFile(filePath,Buffer.concat([header,frames,audioBytes]));
  const write=tags=>new Promise((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'../tag-worker.js'),{workerData:{filePath,tags}});
    worker.once('message',result=>result.ok?resolve():reject(Error(result.message)));worker.once('error',reject);
  });
  await write({image:picture(3,'new-front')});
  await write({title:'Edited song',artist:'Artist',album:'Album'});
  const metadata=await (await import('music-metadata')).parseFile(filePath,{skipCovers:false});
  assert.equal(metadata.common.title,'Edited song');assert.equal(metadata.common.artist,'Artist');assert.equal(metadata.common.album,'Album');
  const pictures=metadata.common.picture;
  assert.equal(pictures.length,2);
  assert.equal(Buffer.from(pictures.find(image=>/front/i.test(image.type)).data).toString(),'new-front');
  assert.equal(Buffer.from(pictures.find(image=>/back/i.test(image.type)).data).toString(),'back');
  assert.deepEqual((await fs.readFile(filePath)).subarray(-100),audioBytes);
});

test('blob playback releases URLs on replacement, failure, and unload', async () => {
  const source = await fs.readFile(path.join(__dirname, '../app.js'), 'utf8');
  const created = [], revoked = [];
  const state = { tracks: [{ id: 'a', file: {} }, { id: 'b', file: {} }], objectUrl: null, shuffle: false };
  const audio = { pause() {}, removeAttribute() {}, load() {}, play: async () => {} };
  const context = { state, audio, window: {}, playbackRequest: 0, playbackQueue: new PlaybackQueue(),
    visibleTracks: () => state.tracks, URL: { createObjectURL: () => { const url=`blob:${created.length}`;created.push(url);return url; }, revokeObjectURL: url => revoked.push(url) },
    $: selector => selector==='#track-list .track-row.playing'?null:({ style: { setProperty() {} } }), render() {}, toast() {}, updateMediaSession() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function releaseAudio('), source.indexOf('async function newPlaylist(')), context);
  await context.playTrack('a');await context.playTrack('b');assert.deepEqual(revoked, [created[0]]);
  context.stopPlayback();assert.deepEqual(revoked, created);
  audio.play = async () => { throw Error('decode error'); };
  await context.playTrack('a');assert.deepEqual(revoked, created);assert.equal(state.objectUrl, null);
});

test('only automatic track changes center the playing song', async () => {
  const source = await fs.readFile(path.join(__dirname, '../app.js'), 'utf8');
  const centered = [];
  const state = { tracks: ['a', 'b', 'c'].map(id => ({ id, file: {} })), objectUrl: null, shuffle: false, repeat: false };
  const audio = { pause() {}, removeAttribute() {}, load() {}, play: async () => {} };
  const context = { state, audio, window: {}, playbackRequest: 0, playbackQueue: new PlaybackQueue(),
    visibleTracks: () => state.tracks, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    $: selector => selector === '#track-list .track-row.playing'
      ? { scrollIntoView: options => centered.push({ id: state.currentId, block: options.block }) }
      : { style: { setProperty() {} } },
    render() {}, toast() {}, updateMediaSession() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function releaseAudio('), source.indexOf('async function newPlaylist(')), context);
  vm.runInContext(source.slice(source.indexOf('audio.onended='), source.indexOf("$('#progress').oninput=")), context);
  await context.playTrack('a');
  await context.nextTrack();
  assert.equal(state.currentId, 'b');
  await context.nextTrack(true);
  assert.equal(state.currentId, 'a');
  assert.deepEqual(centered, []);
  await audio.onended();
  assert.equal(state.currentId, 'b');
  assert.deepEqual(centered, [{ id: 'b', block: 'center' }]);
  state.repeat = true;
  await audio.onended();
  assert.equal(state.currentId, 'b');
  assert.equal(centered.length, 1);
  state.repeat = false;
  context.playbackQueue.clear();
  await audio.onended();
  assert.deepEqual(centered, [{ id: 'b', block: 'center' }, { id: 'a', block: 'center' }]);
});

test('stale asynchronous playback requests cannot replace a newer song', async () => {
  const source = await fs.readFile(path.join(__dirname, '../app.js'), 'utf8');
  let resolveFirst;
  const state = { tracks: [{ id: 'a', path: '/a.mp3' }, { id: 'b', path: '/b.mp3' }], objectUrl: null, shuffle: false };
  const audio = { pause() {}, removeAttribute() {}, load() {}, play: async () => {} };
  const context = { state, audio, window: { electronAPI: { fileUrl: file => file === '/a.mp3' ? new Promise(resolve => { resolveFirst=resolve; }) : Promise.resolve('file:///b.mp3') } }, playbackRequest: 0, playbackQueue: new PlaybackQueue(),
    visibleTracks: () => state.tracks, URL: { revokeObjectURL() {} }, $: selector => selector==='#track-list .track-row.playing'?null:({ style: { setProperty() {} } }), render() {}, toast() {}, updateMediaSession() {}
  };
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function releaseAudio('), source.indexOf('async function newPlaylist(')), context);
  const first=context.playTrack('a');await context.playTrack('b');resolveFirst('file:///a.mp3');await first;
  assert.equal(audio.src,'file:///b.mp3');assert.equal(state.currentId,'b');
});

test('embedded lyrics preserve verses and remove timestamps from plain and synchronized tags', () => {
  const { embeddedLyrics } = require('../lyrics');
  const syncText = [{ text: '\nFirst', timestamp: 1000 }, { text: ' line', timestamp: 1500 }, { text: '\nSecond line', timestamp: 2000 }];
  assert.equal(embeddedLyrics({ common: { lyrics: [{ syncText, contentType: 1 }, { text: '[00:01.00]First line\n\n[00:02.00][00:03.00]Second line' }] } }), 'First line\n\nSecond line');
  assert.equal(embeddedLyrics({ common: { lyrics: [{ syncText, contentType: 1 }] } }), 'First line\nSecond line');
  assert.equal(embeddedLyrics({ common: { lyrics: [{ text: '   ' }, { syncText, contentType: 3 }] } }), '');
  assert.equal(embeddedLyrics({ common: {} }), '');
});

test('lyrics check the file before cached online results and fall back only when embedded text is absent', async () => {
  const source = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
  const { removeLyricsTimestamps } = require('../lyrics');
  let embedded = 'Local verse', fetches = 0, reads = 0;
  const lyricsCache = new Map([[['Song', 'Artist', 'Album', 100].join('\0'), { status: 'found', lyrics: 'Cached online verse' }]]);
  const findLyrics = vm.runInNewContext(`${source.slice(source.indexOf('const normalizeLyricsValue'), source.indexOf('function runCommand'))}; findLyrics`, {
    audioFile: async value => value,
    readEmbeddedLyrics: async () => { reads++; return embedded; },
    removeLyricsTimestamps, lyricsCache, URLSearchParams, AbortSignal, console,
    app: { getVersion: () => 'test' },
    net: { fetch: async () => { fetches++; return { ok: true, json: async () => [{ trackName: 'Song', artistName: 'Artist', syncedLyrics: '[00:01.00]Online verse' }] }; } }
  });
  const track = { path: '/music/song.mp3', title: 'Song', artist: 'Artist', album: 'Album', duration: 100 };
  assert.equal((await findLyrics(track)).lyrics, 'Local verse');
  assert.equal(fetches, 0);
  embedded = '';
  lyricsCache.clear();
  assert.equal((await findLyrics(track)).lyrics, 'Online verse');
  assert.equal(fetches, 1);
  embedded = 'Newly enriched verse';
  assert.equal((await findLyrics(track)).lyrics, 'Newly enriched verse');
  assert.equal(reads, 3);
  assert.equal(fetches, 1);
});

test('karaoke converts millisecond SYLT fragments into lines and follows seeks and instrumental gaps', () => {
  const { timedLyrics, currentLine } = require('../karaoke-core');
  const lines = timedLyrics({ common: { lyrics: [{ contentType: 1, timeStampFormat: 2, syncText: [
    { text: '\nFirst', timestamp: 1000 }, { text: ' line', timestamp: 1500 },
    { text: '\nSecond line', timestamp: 3000 }, { text: '\nFinal line', timestamp: 20000 }
  ] }] } });
  assert.deepEqual(lines, [{ time: 1, text: 'First line', words: [{ start: 0, time: 1 }, { start: 6, time: 1.5 }] }, { time: 3, text: 'Second line' }, { time: 20, text: 'Final line' }]);
  assert.equal(currentLine(lines, 0), '');
  assert.equal(currentLine(lines, 1), 'First line');
  assert.equal(currentLine(lines, 3), 'Second line');
  assert.equal(currentLine(lines, 12), '');
  assert.equal(currentLine(lines, 20), 'Final line');
  assert.equal(currentLine(lines, 1.2), 'First line');
  assert.equal(currentLine(lines, 29), '');
  assert.deepEqual(timedLyrics({ common: { lyrics: [{ contentType: 1, timeStampFormat: 1, syncText: [{ text: 'Unsupported frame timing', timestamp: 1 }] }] } }), []);
});

test('karaoke accepts embedded LRC timing but never invents timing for plain lyrics', () => {
  const { timedLyrics } = require('../karaoke-core');
  assert.deepEqual(timedLyrics({ common: { lyrics: [{ text: '[offset:100]\n[00:01.20][00:05.20]Repeated line\n[00:03.00]Middle' }] } }), [
    { time: 1.3, text: 'Repeated line' }, { time: 3.1, text: 'Middle' }, { time: 5.3, text: 'Repeated line' }
  ]);
  assert.deepEqual(timedLyrics({ common: { lyrics: [{ text: 'Plain lyrics' }] } }), []);
});

test('karaoke word cues use embedded timing and estimate line-only timing without changing text', () => {
  const { wordSegments } = require('../karaoke-core');
  const lines = [{ time: 1, text: 'One two three', words: [{ start: 0, time: 1 }, { start: 4, time: 1.7 }, { start: 8, time: 2.1 }] }, { time: 4, text: 'Four five six' }, { time: 10, text: 'End' }];
  assert.deepEqual(wordSegments(lines, 0), [{ text: 'One ', time: 1 }, { text: 'two ', time: 1.7 }, { text: 'three', time: 2.1 }]);
  assert.deepEqual(wordSegments(lines, 1).map(word => word.time), [4, 6, 8]);
  assert.equal(wordSegments(lines, 0).map(word => word.text).join(''), lines[0].text);
  assert.deepEqual(wordSegments(lines, -1), []);
});

test('scrolling karaoke progresses with playback, fades near the next cue and resets after backward seeking', () => {
  const { scrollingFrame } = require('../karaoke-core');
  const lines = [{ time: 2, text: 'First' }, { time: 6, text: 'Second' }, { time: 20, text: 'Final' }];
  const first = scrollingFrame(lines, 2);
  const middle = scrollingFrame(lines, 4);
  const outgoing = scrollingFrame(lines, 5.9);
  assert.equal(first.current, 0);assert.equal(first.next, 1);assert.equal(first.progress, 0);
  assert.equal(middle.progress, .5);assert.equal(middle.fade, 0);
  assert(outgoing.fade > .8);assert(outgoing.progress > .9);
  assert.equal(scrollingFrame(lines, 6).current, 1);
  assert.deepEqual(scrollingFrame(lines, 2), first);
  assert.equal(scrollingFrame(lines, 15).current, -1);
  assert.equal(scrollingFrame(lines, 30).next, -1);
});
