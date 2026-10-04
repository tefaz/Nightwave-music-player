(function(root) {
  function timedLyrics(metadata) {
    const entries = metadata.common?.lyrics || [];
    for (const entry of entries) {
      if (!Array.isArray(entry.syncText) || entry.timeStampFormat !== 2 || entry.contentType !== 1) continue;
      const lines = [];
      for (const part of entry.syncText) {
        if (!Number.isFinite(part.timestamp) || part.timestamp < 0 || typeof part.text !== 'string') continue;
        const startsLine = /^[\r\n]/.test(part.text);
        const text = part.text.replace(/^[\r\n]+/, '');
        if (!text.trim()) {
          if (startsLine) lines.push({ time: part.timestamp / 1000, text: '' });
          continue;
        }
        if (!lines.length || startsLine) lines.push({ time: part.timestamp / 1000, text });
        else lines[lines.length - 1].text += text;
      }
      if (lines.some(line => line.text.trim())) return lines.sort((a, b) => a.time - b.time);
    }
    // Some taggers store LRC text in an unsynchronized lyrics frame.
    for (const entry of entries) {
      const text = typeof entry === 'string' ? entry : entry.text;
      if (typeof text !== 'string') continue;
      const lines = [];
      const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
      for (const line of text.split(/\r?\n/)) {
        const stamps = [...line.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
        const words = line.replace(/\[\d+:\d+(?:[.:]\d+)?\]/g, '').trim();
        for (const stamp of stamps) lines.push({ time: Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2].replace(':', '.')) + offset), text: words });
      }
      if (lines.length) return lines.sort((a, b) => a.time - b.time);
    }
    return [];
  }

  function currentLine(lines, seconds) {
    let low = 0, high = lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle].time <= seconds) low = middle + 1;
      else high = middle;
    }
    const line = lines[low - 1];
    // Clear during long instrumental gaps and after the last sung line.
    return line && seconds < line.time + 8 ? line.text.trim() : '';
  }
  const api = { timedLyrics, currentLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NightwaveKaraokeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
