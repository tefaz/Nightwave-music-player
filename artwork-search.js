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

// Keep editions together and ignore placeholder tags when choosing a likely album.
const albumName = value => normalize(String(value || '').replace(/\s*[([][^)\]]*(?:deluxe|expanded|remaster|anniversary|special edition)[^)\]]*[)\]]/gi, ''));
const meaningfulAlbum = value => value.trim() && !['localfiles', 'unknown', 'unknownalbum'].includes(normalize(value));
const artistCredits = entity => (entity['artist-credit'] || []).filter(item => item.artist);
const matchesArtist = (entity, artist) => artistCredits(entity).some(item =>
  [item.name, item.artist.name, item.artist['sort-name']].some(name => name && normalize(name) === normalize(artist))) ||
  normalize(artistCredits(entity).map(item => (item.name || item.artist.name) + (item.joinphrase || '')).join('')) === normalize(artist);
const creditName = entity => artistCredits(entity).map(item => (item.name || item.artist.name) + (item.joinphrase || '')).join('');

function createArtworkSearch({ fetch, prepareCover, userAgent, interval = 1100, now = Date.now } = {}) {
  const selections = new Map(), searches = new Map(), lifetime = 10 * 60 * 1000;
  let lastSearch = 0, queue = Promise.resolve();
  function removeSearch(cursor) {
    searches.delete(cursor);
    for (const [token, selection] of selections) if (selection.cursor === cursor) selections.delete(token);
  }
  function prune() {
    for (const [cursor, session] of searches) if (now() - session.created > lifetime) removeSearch(cursor);
    for (const [token, selection] of selections) if (now() - selection.created > lifetime) selections.delete(token);
  }
  async function request(url) {
    return fetch(url, { headers: { 'User-Agent': userAgent, Accept: url.includes('musicbrainz.org') ? 'application/json' : 'image/*' }, signal: AbortSignal.timeout(12000) });
  }
  function metadata(resource, params) {
    // Every MusicBrainz request shares its one-request-per-second allowance.
    const operation = queue.catch(() => {}).then(async () => {
      const delay = Math.max(0, lastSearch + interval - now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastSearch = now();
      const response = await request(`https://musicbrainz.org/ws/2/${resource}?${new URLSearchParams({ ...params, fmt: 'json', limit: '100' })}`);
      if (!response.ok) throw new Error('Cover search is unavailable. Please try again later.');
      return JSON.parse((await readLimited(response, 2 * 1024 * 1024)).toString());
    });
    queue = operation;
    return operation;
  }
  async function candidates(title, artist, album) {
    const releases = new Map();
    function add(release, recording, albumSearch = false) {
      if (!releaseIdPattern.test(release.id)) return;
      const group = release['release-group'] || {}, types = group['secondary-types'] || [];
      const exactAlbum = meaningfulAlbum(album) && normalize(release.title) === normalize(album);
      const relatedAlbum = meaningfulAlbum(album) && albumName(group.title || release.title) === albumName(album);
      const exactTitle = normalize(recording.title) === normalize(title);
      let score = (exactTitle ? 100 : 0) + (exactAlbum ? 600 : relatedAlbum ? 400 : 0) + (release.status === 'Official' ? 20 : 0);
      if (group['primary-type'] === 'Album') score += 60;
      if (group['primary-type'] === 'EP') score += 30;
      if (types.includes('Compilation') || /\b(?:greatest hits|best of|top hits|now that.s what i call)\b/i.test(release.title)) score -= 100;
      if (types.includes('Live')) score -= 40;
      if (types.includes('Remix')) score -= 30;
      if (release.status && release.status !== 'Official') score -= 50;
      if (albumSearch && !exactAlbum && !relatedAlbum) return;
      const entry = { releaseId: release.id, groupId: releaseIdPattern.test(group.id) ? group.id : null,
        album: release.title || 'Untitled release', title: recording.title, artist: creditName(recording) || artist,
        date: group['first-release-date'] || release.date || '', type: [group['primary-type'], ...types].filter(Boolean).join(' · '),
        reason: exactAlbum || relatedAlbum ? 'Matches album name' : group['primary-type'] === 'Album' && !types.length ? 'Studio album' : '', score };
      if (!releases.has(release.id) || releases.get(release.id).score < score) releases.set(release.id, entry);
    }
    const data = await metadata('recording', { query: `recording:${quote(title)} AND artist:${quote(artist)}` });
    const recordings = (data.recordings || []).filter(recording => matchesArtist(recording, artist) &&
      (normalize(recording.title) === normalize(title) || Number(recording.score) >= 80));
    for (const recording of recordings) for (const release of recording.releases || []) add(release, recording);
    // Search the tagged album directly: recording search results can omit its releases.
    if (meaningfulAlbum(album)) {
      try {
        const albums = await metadata('release', { query: `release:${quote(album)} AND artist:${quote(artist)}` });
        for (const release of albums.releases || []) if (matchesArtist(release, artist)) add(release, { title, 'artist-credit': release['artist-credit'] }, true);
      } catch { /* The song search still provides useful candidates. */ }
    }
    // Browse the best recording IDs for fuller release lists and album/compilation types.
    const best = [...recordings].sort((a, b) => Number(normalize(b.title) === normalize(title)) - Number(normalize(a.title) === normalize(title)) || Number(b.score) - Number(a.score));
    const ids = [...new Set(best.map(recording => recording.id).filter(id => releaseIdPattern.test(id)))].slice(0, 2);
    for (const id of ids) {
      try {
        const linked = await metadata('release', { recording: id, inc: 'release-groups+artist-credits' });
        const recording = best.find(item => item.id === id);
        for (const release of linked.releases || []) add(release, recording);
      } catch { /* Fall back to the releases included in search results. */ }
    }
    const groups = new Map();
    const ranked = [...releases.values()].sort((a, b) => b.score - a.score || (a.date || '9999').localeCompare(b.date || '9999'));
    for (const release of ranked) {
      const key = release.groupId || `${normalize(release.album)}:${normalize(release.artist)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(release);
    }
    return [...groups.values()].slice(0, 40);
  }
  async function downloadGroup(editions) {
    const release = editions[0];
    const urls = [
      ...(release.groupId ? [`https://coverartarchive.org/release-group/${release.groupId}/front-500`] : []),
      ...editions.slice(0, 3).map(edition => `https://coverartarchive.org/release/${edition.releaseId}/front-500`)
    ];
    let failed = false;
    for (const url of urls) {
      try {
        const response = await request(url);
        if (response.status === 404) continue;
        if (!response.ok) throw new Error('Cover download failed.');
        const cover = await prepareCover(await readLimited(response, 10 * 1024 * 1024));
        if (cover) return { release, cover };
      } catch { failed = true; }
    }
    return { failed };
  }
  async function nextPage(session, cursor) {
    const retry = [];
    let checked = 0;
    // A page checks at most twelve album groups; more remain available via Next 4.
    while (session.pending.length < 4 && session.groups.length && checked < 12) {
      const batch = session.groups.splice(0, Math.min(4, 12 - checked));
      checked += batch.length;
      const downloaded = await Promise.all(batch.map(downloadGroup));
      downloaded.forEach((result, index) => {
        if (result.cover) {
          const { release, cover } = result, token = randomUUID();
          selections.set(token, { filePath: session.filePath, buffer: cover.buffer, created: session.created, cursor });
          session.pending.push({ token, title: release.title, artist: release.artist, album: release.album,
            date: release.date, type: release.type, reason: release.reason, preview: cover.preview });
        } else if (result.failed) retry.push(batch[index]);
      });
    }
    session.groups.push(...retry);
    if (!session.pending.length && retry.length) throw new Error('Album covers could not be downloaded. Check your connection and try again.');
    return { covers: session.pending.splice(0, 4), cursor, hasMore: Boolean(session.pending.length || session.groups.length),
      warning: retry.length ? 'Some covers could not be downloaded. You can retry them with Next 4.' : '' };
  }
  async function search({ filePath, title, artist, album = '', cursor }) {
    prune();
    let session;
    if (cursor !== undefined) {
      session = searches.get(cursor);
      if (!session || session.filePath !== filePath) throw new Error('This cover search expired. Search again to see more covers.');
    } else {
      for (const value of [title, artist]) if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) throw new Error('Enter a song title and artist (up to 200 characters each).');
      if (typeof album !== 'string' || album.length > 10000 || album.includes('\0')) throw new Error('Invalid album name.');
      const groups = await candidates(title.trim(), artist.trim(), album.trim());
      cursor = randomUUID();
      session = { filePath, groups, pending: [], created: now(), queue: Promise.resolve() };
      searches.set(cursor, session);
      while (searches.size > 3) removeSearch(searches.keys().next().value);
    }
    const operation = session.queue.catch(() => {}).then(() => nextPage(session, cursor));
    session.queue = operation;
    return operation;
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
