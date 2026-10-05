const path = require('node:path');
const fs = require('node:fs/promises');
const { timedLyrics } = require('./karaoke-core');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.opus']);
const isTemporaryTag = value => /^(?:video[_ -]?download|download[_ -]?(?:temp|video)?|temp(?:orary)?|unknown|untitled)[_ -]*/i.test(String(value || '').trim());

function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('An absolute local file path is required.');
  }
  return path.normalize(value);
}

async function audioFile(value) {
  const filePath = absolutePath(value);
  if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('Unsupported audio file.');
  const realPath = await fs.realpath(filePath);
  if (!AUDIO_EXTENSIONS.has(path.extname(realPath).toLowerCase()) || !(await fs.stat(realPath)).isFile()) {
    throw new Error('The path must refer to a local audio file.');
  }
  return filePath; // Preserve existing playlist keys, including paths through symlinks.
}

function preferredTag(metadata, commonValue, ids) {
  if (commonValue && !isTemporaryTag(commonValue)) return String(commonValue);
  for (const tags of Object.values(metadata.native || {})) {
    const tag = tags.find(item => ids.includes(item.id) && item.value && !isTemporaryTag(item.value));
    if (tag) return String(tag.value);
  }
  return commonValue;
}

function createLibrary({ fileSystem = fs, parseFile = async (...args) => (await import('music-metadata')).parseFile(...args), concurrency = 4, cacheLimit = 20000, createThumbnail = () => null } = {}) {
  const cache = new Map();
  // Shared limiter also bounds concurrent scans and individual read-track requests.
  let active = 0;
  const waiting = [];
  async function limited(operation) {
    if (active >= concurrency) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await operation(); }
    finally { if (waiting.length) waiting.shift()(); else active--; }
  }

  async function readTrack(filePath) {
    return limited(async () => {
      const stat = await fileSystem.stat(filePath);
      if (!stat.isFile()) throw new Error('Not a regular audio file.');
      const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = cache.get(filePath);
      if (cached?.signature === signature) return { ...cached.track };
      const fallback = path.basename(filePath, path.extname(filePath));
      let track = { path: filePath, key: filePath, title: fallback, artist: 'Unknown artist', album: 'Local files', duration: 0, artwork: null };
      try {
        const metadata = await parseFile(filePath, { duration: true, skipCovers: false });
        track = { ...track,
          title: preferredTag(metadata, metadata.common.title, ['TIT2', 'TT2', 'title']) || fallback,
          artist: preferredTag(metadata, metadata.common.artist, ['TPE1', 'TP1', 'artist']) || 'Unknown artist',
          album: preferredTag(metadata, metadata.common.album, ['TALB', 'TAL', 'album']) || 'Local files',
          duration: metadata.format.duration || 0,
          hasTimedLyrics: timedLyrics(metadata).some(line => line.text.trim())
        };
        const pictures = metadata.common.picture || [];
        const picture = pictures.find(item => /front/i.test(item.type || item.name || '')) || pictures[0];
        // A damaged cover must not discard otherwise readable song tags.
        if (picture) { try { track.artwork = await createThumbnail(picture); } catch {} }
        cache.delete(filePath);
        cache.set(filePath, { signature, track });
        if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
      } catch { /* Keep readable files with malformed or absent metadata; retry next scan. */ }
      return { ...track };
    });
  }

  async function readMusicFolders(directories, onProgress = () => {}) {
    const files = new Set(), unavailableFolders = [], failures = [];
    // Iterative traversal avoids both recursive stack growth and unbounded directory I/O.
    const pending = [...new Set(directories)];
    const visited = new Set();
    while (pending.length) {
      const directory = pending.pop();
      if (visited.has(directory)) continue;
      visited.add(directory);
      try {
        const entries = await fileSystem.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(target);
          else if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            if (entry.isFile()) files.add(target);
            else if (entry.isSymbolicLink?.()) {
              try {
                const realPath = await fileSystem.realpath(target);
                if (AUDIO_EXTENSIONS.has(path.extname(realPath).toLowerCase())) files.add(target);
              } catch (error) { failures.push({ path: target, message: error.message }); }
            }
          }
        }
      } catch (error) {
        unavailableFolders.push(directory);
        failures.push({ path: directory, message: error.message });
      }
      onProgress({ phase: 'discovering', discovered: files.size });
    }
    const paths = [...files], tracks = new Array(paths.length);
    let cursor = 0, completed = 0;
    onProgress({ phase: 'metadata', completed, total: paths.length });
    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
      while (cursor < paths.length) {
        const index = cursor++;
        try { tracks[index] = await readTrack(paths[index]); }
        catch (error) { failures.push({ path: paths[index], message: error.message }); }
        onProgress({ phase: 'metadata', completed: ++completed, total: paths.length });
      }
    }));
    return { tracks: tracks.filter(Boolean), unavailableFolders, failures };
  }

  return { readTrack, readMusicFolders, invalidate: filePath => cache.delete(filePath) };
}

module.exports = { AUDIO_EXTENSIONS, absolutePath, audioFile, createLibrary };
