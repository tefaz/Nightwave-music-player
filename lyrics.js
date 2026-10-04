const removeLyricsTimestamps = lyrics => String(lyrics || '')
  .replace(/^(?:[ \t]*\[\d+:\d+(?:[.:]\d+)?\])+[ \t]*/gm, '').trim();

function embeddedLyrics(metadata) {
  const entries = metadata.common?.lyrics || [];
  // Plain lyrics preserve the original verse spacing when both ID3 forms exist.
  for (const entry of entries) {
    const text = removeLyricsTimestamps(typeof entry === 'string' ? entry : entry.text);
    if (text) return text;
  }
  for (const entry of entries) {
    if (!Array.isArray(entry.syncText) || (entry.contentType != null && entry.contentType !== 1)) continue;
    // SYLT fragments carry their own line breaks and may represent individual words.
    const text = removeLyricsTimestamps(entry.syncText.map(part => part.text || '').join(''));
    if (text) return text;
  }
  return '';
}

async function readEmbeddedLyrics(filePath) {
  const { parseFile } = await import('music-metadata');
  return embeddedLyrics(await parseFile(filePath, { skipCovers: true }));
}

module.exports = { embeddedLyrics, readEmbeddedLyrics, removeLyricsTimestamps };
