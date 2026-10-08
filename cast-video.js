const fs = require('node:fs/promises');
const { rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { wordSegments, scrollingFrame, lineEnd } = require('./karaoke-core');
const karaokeModes = ['single', 'scroll', 'words'];
const normalizeMode = mode => karaokeModes.includes(mode) ? mode : 'single';
const normalizeCastMode = mode => ['music', ...karaokeModes].includes(mode) ? mode : 'music';

// ASS formatting is a language: keep song tags and lyrics strictly literal.
function literal(text) {
  return String(text || '')
    .replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝')
    .replace(/[\u0000-\u001f]/g, ' ').slice(0, 1000);
}
function assTime(seconds) {
  const ticks = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}
const seconds = time => time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
const displayText = text => text.split('\n').map(literal).join('\\N');
function karaokeText(line, lines, index, start, end) {
  return wordSegments(lines, index).map(word => {
    const time = Number.isFinite(word.time) ? word.time : line.time;
    const delay = Math.max(0, Math.round((time - start) * 1000));
    const color = time <= start ? '\\1c&H15CCFA&' : time >= end ? '\\1c&HFFFFFF&'
      : `\\1c&HFFFFFF&\\t(${delay},${delay + 1},\\1c&H15CCFA&)`;
    return `{${color}}${displayText(word.text)}`;
  }).join('');
}
// At 720p these follow the desktop's 3.8vw text, 1.35 line height and 24px gap.
const fontSize = 49, rowHeight = fontSize * 1.35, rowGap = 24, scrollTop = 720 * .66;
function textHeight(text) {
  // Account for explicit verses and wrapped lines when spacing the two rows.
  const rows = text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil([...line].reduce((width, char) => width + (/\s/.test(char) ? .28 : /[ilI.,!']/u.test(char) ? .25 : /[MW@]/u.test(char) ? .9 : .55), 0) * fontSize / (1280 * .82))), 0);
  return rows * rowHeight;
}
function tvRows(lines, time) {
  const scene = scrollingFrame(lines, time);
  const indices = [scene.current, scene.next];
  const distance = Math.max(0, ...indices.map(index => lines[index]?.text.trim() ? textHeight(lines[index].text) : 0)) + rowGap;
  return indices.flatMap((index, position) => lines[index]?.text.trim() ? [{ index,
    y: scrollTop + (position - scene.progress) * distance,
    opacity: position ? .12 + scene.progress * .88 : 1 - scene.fade,
    current: position === 0
  }] : []);
}
function lyricsAss(vtt, title, artist, mode = 'single', timedLines = []) {
  mode = normalizeMode(mode);
  const cues = [];
  for (const block of vtt.split(/\n\s*\n/)) {
    const match = block.match(/(\d{2,}:\d{2}:\d{2}\.\d{3}) --> (\d{2,}:\d{2}:\d{2}\.\d{3})\n([\s\S]+)/);
    if (match) cues.push({ time: seconds(match[1]), end: seconds(match[2]), text: match[3].trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') });
  }
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Lyrics,Manrope,49,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,-1.225,0,1,2,3,8,115,115,0,1\nStyle: Heading,Manrope,26,&H00DADADA,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,2,8,80,80,60,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const event = (start, end, text) => end > start ? `Dialogue: 1,${assTime(start)},${assTime(end)},Lyrics,,0,0,0,,${text}\n` : '';
  let events = '';
  if (mode === 'single') {
    events = cues.map(cue => event(cue.time, cue.end, `{\\b600\\an2\\pos(640,605)}${displayText(cue.text)}`)).join('');
  } else {
    const lines = timedLines.length ? timedLines.filter(line => Number.isFinite(line.time) && line.time >= 0 && typeof line.text === 'string').toSorted((a, b) => a.time - b.time) : cues.flatMap((cue, index) => [cue, ...(cue.end < Math.min(cue.time + 8, cues[index + 1]?.time ?? Infinity) ? [{ time: cue.end, text: '' }] : [])]);
    const duration = cues.at(-1)?.end || 0;
    const points = new Set([0, duration, ...(lines[0]?.time > 2 ? [lines[0].time - 2] : [])]);
    for (const [index, line] of lines.entries()) {
      const end = lineEnd(lines, index);
      for (const time of [line.time, end, end - Math.min(.6, (end - line.time) * .35), line.time - 8]) {
        if (time > 0 && time < duration) points.add(time);
      }
    }
    const times = [...points].sort((a, b) => a - b);
    for (let part = 0; part < times.length - 1; part++) {
      const start = times[part], end = times[part + 1], milliseconds = Math.round((end - start) * 1000);
      const first = tvRows(lines, start + .000001), last = tvRows(lines, end - .000001);
      for (const row of first) {
        const target = last.find(other => other.index === row.index);
        if (!target) continue;
        const alpha = opacity => Math.round(255 * (1 - opacity));
        const motion = `{\\b600\\move(640,${row.y.toFixed(2)},640,${target.y.toFixed(2)})\\fade(${alpha(row.opacity)},${alpha(row.opacity)},${alpha(target.opacity)},0,0,0,${milliseconds})}`;
        const text = mode === 'words' && row.current ? `{\\1c&H15CCFA&}${karaokeText(lines[row.index], lines, row.index, start, end)}` : displayText(lines[row.index].text);
        events += event(start, end, motion + text);
      }
    }
  }
  return header + `Dialogue: 0,0:00:00.00,99:00:00.00,Heading,,0,0,0,,${[literal(title), literal(artist)].filter(Boolean).join('\\N')}\n` + events;
}

function karaokeBackdrop() {
  const width = 1280, height = 720, pixels = Buffer.alloc(width * height * 3);
  const mix = (a, b, amount) => a.map((channel, index) => channel + (b[index] - channel) * amount);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const fraction = y / height;
    let rgb = fraction < .5 ? mix([32, 23, 32], [21, 16, 24], fraction * 2) : mix([21, 16, 24], [8, 9, 14], (fraction - .5) * 2);
    for (const center of [.14, .86]) {
      const radius = Math.hypot(x - width * center, y - height * .08) / (height * .72);
      if (radius < 1) rgb = mix(rgb, [241, 188, 122], radius < .45 ? .13 - radius / .45 * .095 : .035 * (1 - radius) / .55);
    }
    const edge = Math.min(x, width - 1 - x);
    if (edge < width * .126) {
      const fold = edge % (width * .018) / (width * .018);
      rgb = fold < .5 ? mix([21, 16, 22], [40, 27, 36], fold * 2) : mix([40, 27, 36], [24, 18, 25], (fold - .5) * 2);
    }
    for (let channel = 0; channel < 3; channel++) pixels[(y * width + x) * 3 + channel] = Math.round(rgb[channel]);
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

class CastVideo {
  constructor({ executable = 'ffmpeg' } = {}) {
    this.executable = executable; this.cache = new Map(); this.closed = false;
  }
  cancel() { this.controller?.abort(); }
  async render({ filePath, captionVtt, title, artist, onProgress, mode = 'single', timedLines = [] }) {
    mode = normalizeMode(mode);
    if (this.closed) throw new Error('TV lyrics preparation cancelled.');
    const controller = this.controller = new AbortController();
    const source = await fs.stat(filePath);
    const key = createHash('sha256').update(JSON.stringify([filePath, source.size, source.mtimeMs, captionVtt, title, artist, mode, mode === 'words' ? timedLines : null])).digest('hex');
    if (controller.signal.aborted) throw new Error('TV lyrics preparation cancelled.');
    if (this.cache.has(key)) {
      const output = this.cache.get(key); this.cache.delete(key); this.cache.set(key, output);
      return output;
    }
    if (!this.directory) this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightwave-tv-'));
    if (controller.signal.aborted || this.closed) {
      await fs.rm(this.directory, { recursive: true, force: true });
      throw new Error('TV lyrics preparation cancelled.');
    }
    const subtitles = `${key}.ass`, output = path.join(this.directory, `${key}.mp4`);
    if (!this.sceneReady) {
      await fs.writeFile(path.join(this.directory, 'stage.ppm'), karaokeBackdrop());
      await fs.mkdir(path.join(this.directory, 'fonts'), { recursive: true });
      await fs.copyFile(path.join(__dirname, 'assets', 'fonts', 'Manrope.ttf'), path.join(this.directory, 'fonts', 'Manrope.ttf'));
      this.sceneReady = true;
    }
    await fs.writeFile(path.join(this.directory, subtitles), lyricsAss(captionVtt, title, artist, mode, timedLines));
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(this.executable, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-loop', '1', '-framerate', mode === 'single' ? '10' : '30', '-i', 'stage.ppm', '-i', filePath,
          '-map', '0:v:0', '-map', '1:a:0', '-vf', `ass=${subtitles}:fontsdir=fonts`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
          '-shortest', '-movflags', '+faststart', '-progress', 'pipe:1', output
        ], { cwd: this.directory, signal: controller.signal, windowsHide: true });
        let errorText = '', progress = '', processError;
        child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-3000); });
        child.stdout.on('data', chunk => {
          progress += chunk;
          const lines = progress.split('\n'); progress = lines.pop();
          for (const line of lines) if (line.startsWith('out_time_us=')) onProgress?.(Number(line.slice(12)) / 1000000);
        });
        child.once('error', error => { processError = error; });
        // Wait for close, so cancellation cannot leave a writer running during cleanup.
        child.once('close', code => code === 0 && !controller.signal.aborted ? resolve() : reject(new Error(controller.signal.aborted
          ? 'TV lyrics preparation cancelled.' : processError?.code === 'ENOENT'
            ? 'TV lyrics needs FFmpeg installed on this computer. Install FFmpeg or choose Music only in the Cast picker.'
            : `Could not prepare TV lyrics. Choose Music only to cast audio. ${processError?.message || errorText.trim()}`)));
      });
      this.cache.set(key, output);
      // Keep a small session cache, preserving any video the TV is still reading.
      for (const [oldKey, oldPath] of this.cache) {
        if (this.cache.size <= 3) break;
        if (oldPath === this.activePath || oldPath === output) continue;
        await fs.rm(oldPath, { force: true }); this.cache.delete(oldKey);
      }
      return output;
    } catch (error) { await fs.rm(output, { force: true }); throw error; }
    finally { await fs.rm(path.join(this.directory, subtitles), { force: true }); }
  }
  close() {
    this.closed = true; this.cancel();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.cache.clear();
  }
}
module.exports = { CastVideo, lyricsAss, normalizeMode, normalizeCastMode, tvRows };
