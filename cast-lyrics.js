const { lineEnd } = require('./karaoke-core');
function timestamp(milliseconds) {
  const hours = Math.floor(milliseconds / 3600000), minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60, fraction = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`;
}
function lyricsWebVtt(input, duration) {
  const lines = input.filter(line => Number.isFinite(line.time) && line.time >= 0 && Number.isSafeInteger(Math.round(line.time * 1000)) && typeof line.text === 'string')
    .map(line => ({ time: line.time, text: line.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() })).sort((a, b) => a.time - b.time);
  const grouped = [];
  for (const line of lines) {
    const last = grouped.at(-1);
    if (last && Math.round(last.time * 1000) === Math.round(line.time * 1000)) last.text = [last.text, line.text].filter(Boolean).join('\n');
    else grouped.push({ ...line });
  }
  const cues = [];
  for (const [index, line] of grouped.entries()) {
    if (!line.text) continue;
    const start = Math.round(line.time * 1000);
    const end = Math.round(Math.min(lineEnd(grouped, index), Number.isFinite(duration) && duration > 0 ? duration : Infinity) * 1000);
    if (end <= start) continue;
    const text = line.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n{2,}/g, '\n');
    cues.push(`${cues.length + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text}`);
  }
  return cues.length ? `WEBVTT\n\n${cues.join('\n\n')}\n\n` : null;
}
module.exports = { lyricsWebVtt };
