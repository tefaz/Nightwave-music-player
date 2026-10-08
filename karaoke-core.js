(function(root) {
  function timedLyrics(metadata) {
    const entries = metadata.common?.lyrics || [];
    for (const entry of entries) {
      if (!Array.isArray(entry.syncText) || entry.timeStampFormat !== 2 || entry.contentType !== 1) continue;
      const lines = [];
      const fragments = new Map();
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
        const line = lines[lines.length - 1];
        const parts = fragments.get(line) || [];
        parts.push({ text, time: part.timestamp / 1000 });
        fragments.set(line, parts);
      }
      for (const line of lines) {
        const parts = fragments.get(line) || [];
        if (parts.length > 1) {
          let offset = 0;
          line.words = parts.flatMap(part => {
            const words = [...part.text.matchAll(/\S+/g)].map(word => ({ start: offset + word.index, time: part.time }));
            offset += part.text.length;
            return words;
          });
        }
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
    const index = lineIndex(lines, seconds);
    const line = lines[index];
    // Clear during long instrumental gaps and after the last sung line.
    return line && seconds < line.time + 8 ? line.text.trim() : '';
  }

  function lineIndex(lines, seconds) {
    let low = 0, high = lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (lines[middle].time <= seconds) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  function lineEnd(lines, index) {
    return Math.min(lines[index].time + 8, lines[index + 1]?.time ?? Infinity);
  }

  function wordSegments(lines, index) {
    const line = lines[index];
    if (!line) return [];
    const matches = [...line.text.matchAll(/\S+\s*/g)];
    const duration = Math.max(0, lineEnd(lines, index) - line.time);
    return matches.map((word, position) => ({
      text: word[0],
      time: line.words?.find(cue => cue.start === word.index)?.time ?? line.time + duration * position / matches.length
    }));
  }

  function scrollingFrame(lines, seconds) {
    const index = lineIndex(lines, seconds);
    const line = lines[index];
    const end = line ? lineEnd(lines, index) : lines[0]?.time ?? 0;
    const start = line?.time ?? end - 2;
    const duration = Math.max(0.001, end - start);
    const progress = Math.max(0, Math.min(1, (seconds - start) / duration));
    const fadeWindow = Math.min(0.6, duration * 0.35);
    const fade = Math.max(0, Math.min(1, (seconds - end + fadeWindow) / fadeWindow));
    const next = lines[index + 1];
    return {
      current: line && seconds < end ? index : -1,
      next: next && next.time - seconds <= 8 ? index + 1 : -1,
      progress, fade
    };
  }
  const api = { timedLyrics, currentLine, lineIndex, lineEnd, wordSegments, scrollingFrame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NightwaveKaraokeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
