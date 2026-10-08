const { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeImage, net, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { absolutePath, audioFile, createLibrary } = require('./music-library');
const { createPhoneSync, playlistFolder } = require('./phone-sync');
const { createArtworkSearch } = require('./artwork-search');
const { readEmbeddedLyrics, removeLyricsTimestamps } = require('./lyrics');
const { timedLyrics } = require('./karaoke-core');
const { lyricsWebVtt } = require('./cast-lyrics');
const { Casting } = require('./casting');
const casting = new Casting();
const { CastVideo, normalizeCastMode } = require('./cast-video');
const castVideo = new CastVideo();
const { createCastFirewall } = require('./cast-firewall');
const { DEFAULT_CAST_PORT } = require('./cast-stream');
const castFirewall = createCastFirewall();
for (const event of ['devices', 'status']) casting.on(event, value => {
  if (event === 'status' && value.connected === false) { ++castLoadRevision; castVideo.cancel(); }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`cast:${event}`, value);
});
let castLoads = Promise.resolve(), castLoadRevision = 0;

const library = createLibrary({ createThumbnail: picture => {
  if (!picture.data?.length || picture.data.length > 10 * 1024 * 1024) return null;
  const image = nativeImage.createFromBuffer(Buffer.from(picture.data));
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const resized = Math.max(width, height) > 128
    ? image.resize(width >= height ? { width: 128 } : { height: 128 }) : image;
  return `data:image/png;base64,${resized.toPNG().toString('base64')}`;
} });
const artworkSearch = createArtworkSearch({
  fetch: (url, options) => net.fetch(url, options),
  userAgent: `Nightwave/${app.getVersion()} (https://github.com/tefaz/Nightwave-music-player)`,
  prepareCover: buffer => {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const cover = Math.max(width, height) > 500 ? image.resize(width >= height ? { width: 500 } : { height: 500 }) : image;
    return { buffer: cover.toJPEG(90), preview: cover.toDataURL() };
  }
});
const lyricsCache = new Map();
const pageUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const tagWrites = new Map();
let mainWindow;
let syncing = false;

function validateSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame?.url.split('#')[0] !== pageUrl) {
    throw new Error('This request must come from the Nightwave window.');
  }
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    validateSender(event);
    return callback(event, ...args);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1800, height: 980, minWidth: 900, minHeight: 620, frame: false,
    backgroundColor: '#0d0d0f', icon: path.join(__dirname, 'assets', 'nightwave-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow = window;
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.on('maximize', () => window.webContents.send('window:maximized', true));
  window.on('unmaximize', () => window.webContents.send('window:maximized', false));
  window.loadFile(path.join(__dirname, 'index.html'));
}

function registerMediaShortcuts() {
  for (const [accelerator, command] of [['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'previous']]) {
    if (!globalShortcut.register(accelerator, () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('playback:command', command);
    })) console.warn(`Could not register global media shortcut: ${accelerator}`);
  }
}

const normalizeLyricsValue = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function findLyrics({ title, artist, album, duration, path: filePath } = {}) {
  if (filePath) {
    const validatedPath = await audioFile(filePath);
    try {
      const lyrics = await readEmbeddedLyrics(validatedPath);
      if (lyrics) return { status: 'found', source: 'embedded', lyrics, title, artist };
    } catch (error) { console.warn('Embedded lyrics could not be read:', error.message); }
  }
  const trackName = String(title || '').trim(), artistName = String(artist || '').trim();
  if (!trackName) return { status: 'not-found' };
  const cacheKey = [trackName, artistName, album, duration].join('\0');
  if (lyricsCache.has(cacheKey)) return lyricsCache.get(cacheKey);
  const query = new URLSearchParams({ track_name: trackName });
  if (artistName && artistName !== 'Unknown artist') query.set('artist_name', artistName);
  if (album && album !== 'Local files') query.set('album_name', String(album));
  try {
    const response = await net.fetch(`https://lrclib.net/api/search?${query}`, {
      headers: { 'Lrclib-Client': `Nightwave/${app.getVersion()} (https://github.com/tefaz/Nightwave-music-player)` },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Lyrics service returned ${response.status}`);
    const matches = await response.json(), wantedTitle = normalizeLyricsValue(trackName), wantedArtist = normalizeLyricsValue(artistName);
    const score = item => (normalizeLyricsValue(item.trackName) === wantedTitle ? 8 : 0) +
      (wantedArtist && normalizeLyricsValue(item.artistName) === wantedArtist ? 6 : 0) +
      (Number.isFinite(duration) && Math.abs(Number(item.duration) - duration) <= 3 ? 2 : 0);
    const match = (Array.isArray(matches) ? matches : []).filter(item => (item.plainLyrics || item.syncedLyrics) && !item.instrumental).sort((a, b) => score(b) - score(a))[0];
    const result = match ? { status: 'found', source: 'online', lyrics: removeLyricsTimestamps(match.plainLyrics || match.syncedLyrics), title: match.trackName, artist: match.artistName } : { status: 'not-found' };
    lyricsCache.set(cacheKey, result);
    if (lyricsCache.size > 500) lyricsCache.delete(lyricsCache.keys().next().value);
    return result;
  } catch (error) {
    console.warn('Lyrics lookup failed:', error.message);
    return { status: 'error' };
  }
}

function runCommand(command, args, { hash = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, LC_ALL: 'C' } });
    const output = [], errors = [], digest = hash ? createHash('sha256') : null;
    let outputSize = 0, errorSize = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out.`)); }, 300000);
    child.stdout.on('data', chunk => {
      if (digest) digest.update(chunk);
      else if ((outputSize += chunk.length) <= 1024 * 1024) output.push(chunk);
    });
    child.stderr.on('data', chunk => { if ((errorSize += chunk.length) <= 65536) errors.push(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(digest ? digest.digest('hex') : Buffer.concat(output).toString());
      else reject(new Error(Buffer.concat(errors).toString().trim() || `${command} exited with code ${code}`));
    });
  });
}
const phoneSync = createPhoneSync({ runCommand });

function scanProgress(event, requestId) {
  let lastUpdate = 0;
  return progress => {
    const now = Date.now();
    if (now - lastUpdate < 100 && !(progress.phase === 'metadata' && progress.completed === progress.total)) return;
    lastUpdate = now;
    if (!event.sender.isDestroyed()) event.sender.send('music:scan-progress', { requestId, ...progress });
  };
}

function writeTags(filePath, tags) {
  // node-id3's callback API still reads synchronously. Keep all its work off the main thread.
  const previous = tagWrites.get(filePath) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'tag-worker.js'), { workerData: { filePath, tags } });
    let answered = false;
    worker.once('message', result => {
      answered = true;
      result.ok ? resolve() : reject(new Error(result.message || 'Could not write tags.'));
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (!answered) reject(new Error(`Tag writer exited before completing (${code}).`)); });
  }));
  tagWrites.set(filePath, operation);
  return operation.finally(() => { if (tagWrites.get(filePath) === operation) tagWrites.delete(filePath); });
}

app.whenReady().then(() => {
  createWindow();
  registerMediaShortcuts();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); casting.close(); castVideo.close(); });

handle('music:pick-folder', async (event, requestId) => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  const directory = absolutePath(result.filePaths[0]);
  return { directory, ...await library.readMusicFolders([directory], scanProgress(event, requestId)) };
});
handle('music:refresh-folders', async (event, directories, requestId) => {
  if (!Array.isArray(directories) || directories.length > 1000) throw new Error('Invalid music folder list.');
  return library.readMusicFolders(directories.map(absolutePath), scanProgress(event, requestId));
});
handle('music:read-track', async (_event, filePath) => library.readTrack(await audioFile(filePath)));
handle('app:open-tracksmith', () => shell.openExternal('https://github.com/tefaz/Tracksmith-mp3-enricher'));
handle('music:read-artwork', async (_event, filePath) => {
  const validatedPath = await audioFile(filePath);
  const metadata = await (await import('music-metadata')).parseFile(validatedPath, { skipCovers: false });
  const pictures = metadata.common.picture || [];
  const picture = pictures.find(item => /front/i.test(item.type || item.name || '')) || pictures[0];
  if (!picture?.data?.length) return null;
  const image = nativeImage.createFromBuffer(Buffer.from(picture.data));
  return image.isEmpty() ? null : image.toDataURL();
});
handle('music:show-in-folder', async (_event, filePath) => shell.showItemInFolder(await audioFile(filePath)));
ipcMain.on('music:start-external-drag', async (event, filePaths) => {
  try {
    validateSender(event);
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    if (!paths.length || paths.length > 10000) throw new Error('Invalid drag file list.');
    const validated = await Promise.all([...new Set(paths)].map(audioFile));
    if (!event.sender.isDestroyed()) event.sender.startDrag({
      files: validated,
      icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'nightwave-icon.png')).resize({ width: 64, height: 64 })
    });
  } catch (error) { console.warn('External drag failed:', error.message); }
});
handle('music:file-url', async (_event, filePath) => pathToFileURL(await audioFile(filePath)).href);
handle('music:timed-lyrics', async (_event, filePath) => {
  const validatedPath = await audioFile(filePath);
  const { parseFile } = await import('music-metadata');
  return timedLyrics(await parseFile(validatedPath, { skipCovers: true }));
});
handle('music:find-lyrics', (_event, track) => {
  if (!track || typeof track !== 'object' || [track.title, track.artist, track.album].some(value => value != null && (typeof value !== 'string' || value.length > 2000))) {
    throw new Error('Invalid lyrics request.');
  }
  return findLyrics(track);
});
handle('music:sync-to-phone', async (event, request) => {
  if (syncing) throw new Error('A phone sync is already running.');
  if (!Array.isArray(request?.filePaths) || !request.filePaths.length || request.filePaths.length > 100000) throw new Error('There are no valid local music files to sync.');
  playlistFolder(request.playlistName);
  syncing = true;
  try {
    const filePaths = [];
    for (const filePath of new Set(request.filePaths)) filePaths.push(await audioFile(filePath));
    const onProgress = (completed, filePath) => {
      if (!event.sender.isDestroyed()) event.sender.send('music:sync-progress', { completed, total: filePaths.length, fileName: path.basename(filePath) });
    };
    return await phoneSync.sync(filePaths, request.playlistName, onProgress);
  } finally { syncing = false; }
});
handle('music:write-tags', async (_event, values) => {
  const filePath = await audioFile(values?.filePath);
  if (path.extname(filePath).toLowerCase() !== '.mp3') throw new Error('Editing tags is currently supported for MP3 files only.');
  const tags = {};
  for (const field of ['title', 'artist', 'album']) {
    if (typeof values[field] !== 'string' || values[field].length > 10000 || values[field].includes('\0')) throw new Error(`Invalid ${field} tag.`);
    tags[field] = values[field];
  }
  await writeTags(filePath, tags);
  library.invalidate(filePath);
  return library.readTrack(filePath);
});
handle('music:search-artwork', async (_event, request) => {
  const filePath = await audioFile(request?.filePath);
  if (path.extname(filePath).toLowerCase() !== '.mp3') throw new Error('Saving album covers is currently supported for MP3 files only.');
  return artworkSearch.search({ filePath, title: request.title, artist: request.artist, album: request.album, cursor: request.cursor });
});
handle('music:save-artwork', async (_event, request) => {
  const filePath = await audioFile(request?.filePath);
  if (path.extname(filePath).toLowerCase() !== '.mp3') throw new Error('Saving album covers is currently supported for MP3 files only.');
  const imageBuffer = artworkSearch.selectedCover(filePath, request.token);
  await writeTags(filePath, { image: { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'Front cover', imageBuffer } });
  artworkSearch.discard(request.token);
  library.invalidate(filePath);
  return library.readTrack(filePath);
});
handle('window:minimize', event => BrowserWindow.fromWebContents(event.sender)?.minimize());
handle('window:toggle-maximize', event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  window.isMaximized() ? window.unmaximize() : window.maximize();
  return window.isMaximized();
});
handle('window:close', event => BrowserWindow.fromWebContents(event.sender)?.close());

handle('cast:discover', () => casting.discover());
handle('cast:connect', (_event, id) => casting.connect(id));
handle('cast:disconnect', () => { ++castLoadRevision; castVideo.cancel(); return casting.disconnect(); });
handle('cast:load', (_event, track) => {
  const revision = ++castLoadRevision;
  castVideo.cancel();
  const load = castLoads.catch(() => {}).then(async () => {
    if (revision !== castLoadRevision) return;
    if (!track || typeof track.id !== 'string') throw new Error('Invalid cast track.');
    const mode = normalizeCastMode(track.karaokeMode);
    const filePath = await audioFile(track.path);
    if (revision !== castLoadRevision) return;
    let captionVtt = null, duration = 0, timedLines = [];
    if (mode !== 'music') {
      try {
        const { parseFile } = await import('music-metadata');
        const metadata = await parseFile(filePath, { skipCovers: true });
        duration = metadata.format.duration || 0;
        timedLines = timedLyrics(metadata);
        captionVtt = lyricsWebVtt(timedLines, metadata.format.duration);
      } catch (error) { console.warn('Cast timed lyrics could not be read:', error.message); }
    }
    if (revision !== castLoadRevision) return;
    let mediaPath = filePath;
    if (captionVtt) {
      const progress = seconds => {
        if (revision === castLoadRevision && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cast:status', { preparingLyrics: true, trackId: track.id,
            preparationPercent: duration ? Math.min(99, Math.floor(seconds / duration * 100)) : null });
        }
      };
      progress(0);
      try { mediaPath = await castVideo.render({ filePath, captionVtt, title: track.title, artist: track.artist, onProgress: progress, mode, timedLines }); }
      finally {
        if (revision === castLoadRevision && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cast:status', { preparingLyrics: false });
        }
      }
    }
    if (revision !== castLoadRevision) return;
    try {
      const result = await casting.load({ ...track, karaokeMode: mode, captions: mode !== 'music', path: mediaPath, captionVtt: null, videoLyrics: Boolean(captionVtt) });
      castVideo.activePath = captionVtt ? mediaPath : null;
      return result;
    }
    catch (error) {
      if (casting.lastLoadFailure?.kind === 'stream-unreachable' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cast:status', { firewallDeviceId: casting.device?.id, firewallTrackId: track.id });
      }
      throw error;
    }
  });
  castLoads = load;
  return load;
});
handle('cast:command', async (_event, command, value) => {
  if (command === 'stop') { ++castLoadRevision; castVideo.cancel(); await castLoads.catch(() => {}); }
  return casting.command(command, value);
});

function castFirewallTarget(id) {
  const device = casting.devices?.get(id);
  const port = casting.stream?.diagnostics?.().port || DEFAULT_CAST_PORT;
  return { device, port };
}
handle('cast:firewall-info', async (_event, id) => {
  const { device, port } = castFirewallTarget(id);
  const info = await castFirewall.info(device, port);
  return { ...info, streamUnreachable: casting.lastLoadFailure?.host === device.host && casting.lastLoadFailure?.kind === 'stream-unreachable' };
});
handle('cast:firewall-apply', (_event, request) => {
  const { device, port } = castFirewallTarget(request?.deviceId);
  return castFirewall.apply(device, port, request);
});
