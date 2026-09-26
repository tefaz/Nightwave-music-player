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
    require: name => name === 'node:worker_threads' ? { parentPort: { postMessage: message => messages.push(message) }, workerData: { tags: {}, filePath: '/fake.mp3' } } : { update: () => new Error('write failed') }
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

test('blob playback releases URLs on replacement, failure, and unload', async () => {
  const source = await fs.readFile(path.join(__dirname, '../app.js'), 'utf8');
  const created = [], revoked = [];
  const state = { tracks: [{ id: 'a', file: {} }, { id: 'b', file: {} }], objectUrl: null, shuffle: false };
  const audio = { pause() {}, removeAttribute() {}, load() {}, play: async () => {} };
  const context = { state, audio, window: {}, playbackRequest: 0, playbackQueue: new PlaybackQueue(),
    visibleTracks: () => state.tracks, URL: { createObjectURL: () => { const url=`blob:${created.length}`;created.push(url);return url; }, revokeObjectURL: url => revoked.push(url) },
    $: () => ({ style: { setProperty() {} } }), render() {}, toast() {}, updateMediaSession() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function releaseAudio('), source.indexOf('async function newPlaylist(')), context);
  await context.playTrack('a');await context.playTrack('b');assert.deepEqual(revoked, [created[0]]);
  context.stopPlayback();assert.deepEqual(revoked, created);
  audio.play = async () => { throw Error('decode error'); };
  await context.playTrack('a');assert.deepEqual(revoked, created);assert.equal(state.objectUrl, null);
});

test('stale asynchronous playback requests cannot replace a newer song', async () => {
  const source = await fs.readFile(path.join(__dirname, '../app.js'), 'utf8');
  let resolveFirst;
  const state = { tracks: [{ id: 'a', path: '/a.mp3' }, { id: 'b', path: '/b.mp3' }], objectUrl: null, shuffle: false };
  const audio = { pause() {}, removeAttribute() {}, load() {}, play: async () => {} };
  const context = { state, audio, window: { electronAPI: { fileUrl: file => file === '/a.mp3' ? new Promise(resolve => { resolveFirst=resolve; }) : Promise.resolve('file:///b.mp3') } }, playbackRequest: 0, playbackQueue: new PlaybackQueue(),
    visibleTracks: () => state.tracks, URL: { revokeObjectURL() {} }, $: () => ({ style: { setProperty() {} } }), render() {}, toast() {}, updateMediaSession() {}
  };
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function releaseAudio('), source.indexOf('async function newPlaylist(')), context);
  const first=context.playTrack('a');await context.playTrack('b');resolveFirst('file:///a.mp3');await first;
  assert.equal(audio.src,'file:///b.mp3');assert.equal(state.currentId,'b');
});
