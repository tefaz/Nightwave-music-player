const { randomUUID } = require('node:crypto');

const releaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const quote = value => `"${value.replace(/[\\"]/g, '\\$&')}"`;

async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('The cover service returned too much data.');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('The cover service returned too much data.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

function createArtworkSearch({ fetch, prepareCover, userAgent, interval = 1100, now = Date.now } = {}) {
  const selections = new Map();
  let lastSearch = 0, queue = Promise.resolve();
  function prune() {
    for (const [token, selection] of selections) if (now() - selection.created > 10 * 60 * 1000) selections.delete(token);
    while (selections.size > 20) selections.delete(selections.keys().next().value);
  }
  async function request(url) {
    return fetch(url, { headers: { 'User-Agent': userAgent, Accept: url.includes('musicbrainz.org') ? 'application/json' : 'image/*' }, signal: AbortSignal.timeout(12000) });
  }
  async function search({ filePath, title, artist, album = '' }) {
    for (const value of [title, artist]) if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) throw new Error('Enter a song title and artist (up to 200 characters each).');
    if (typeof album !== 'string' || album.length > 10000) throw new Error('Invalid album name.');
    title = title.trim(); artist = artist.trim();
    const params = new URLSearchParams({ query: `recording:${quote(title)} AND artist:${quote(artist)}`, fmt: 'json', limit: '20' });
    // Searches share MusicBrainz's one-request-per-second allowance.
    const operation = queue.catch(() => {}).then(async () => {
      const delay = Math.max(0, lastSearch + interval - now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastSearch = now();
      const response = await request(`https://musicbrainz.org/ws/2/recording?${params}`);
      if (!response.ok) throw new Error('Cover search is unavailable. Please try again later.');
      return JSON.parse((await readLimited(response, 2 * 1024 * 1024)).toString());
    });
    queue = operation;
    const data = await operation, releases = new Map();
    for (const recording of data.recordings || []) {
      const artists = (recording['artist-credit'] || []).filter(item => item.artist);
      if (!artists.some(item => normalize(item.name || item.artist.name) === normalize(artist))) continue;
      const exactTitle = normalize(recording.title) === normalize(title);
      if (!exactTitle && Number(recording.score) < 80) continue;
      const artistName = artists.map(item => (item.name || item.artist.name) + (item.joinphrase || '')).join('');
      for (const release of recording.releases || []) {
        if (!releaseIdPattern.test(release.id)) continue;
        const score = (exactTitle ? 100 : 0) + (normalize(release.title) === normalize(album) ? 50 : 0) + (release.status === 'Official' ? 10 : 0);
        if (!releases.has(release.id) || releases.get(release.id).score < score) releases.set(release.id, { releaseId: release.id, album: release.title || 'Untitled release', title: recording.title, artist: artistName, score });
      }
    }
    const results = [];
    let failed = false;
    for (const release of [...releases.values()].sort((a, b) => b.score - a.score).slice(0, 8)) {
      try {
        const response = await request(`https://coverartarchive.org/release/${release.releaseId}/front-500`);
        if (response.status === 404) continue;
        if (!response.ok) throw new Error('Cover download failed.');
        const cover = await prepareCover(await readLimited(response, 10 * 1024 * 1024));
        if (!cover) continue;
        const token = randomUUID();
        selections.set(token, { filePath, buffer: cover.buffer, created: now() });
        prune();
        results.push({ token, title: release.title, artist: release.artist, album: release.album, preview: cover.preview });
        if (results.length === 4) break;
      } catch { failed = true; }
    }
    if (!results.length && failed) throw new Error('Album covers could not be downloaded. Check your connection and try again.');
    return results;
  }
  function selectedCover(filePath, token) {
    prune();
    const selection = selections.get(token);
    if (!selection || selection.filePath !== filePath) throw new Error('This cover selection expired. Search again before saving.');
    return selection.buffer;
  }
  return { search, selectedCover, discard: token => selections.delete(token) };
}

module.exports = { createArtworkSearch, readLimited };
