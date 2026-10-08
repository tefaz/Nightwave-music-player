const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(require('node:child_process').execFile);
const { CastVideo, lyricsAss, tvRows, normalizeCastMode } = require('../cast-video');
const { createCastStream } = require('../cast-stream');
const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nSing &amp; dance\n\n';
async function fixture(seconds = 3) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightwave-video-test-'));
  const filePath = path.join(directory, "song ' [test].wav"), samples = 48000 * seconds;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(96000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 48000) * 4000), 44 + i * 2);
  await fs.writeFile(filePath, data);
  return { directory, filePath, captionVtt: vtt, title: 'A song', artist: 'Artist' };
}
test('ASS keeps lyrics and metadata literal and preserves cue boundaries', () => {
  const text = lyricsAss(vtt.replace('Sing &amp; dance', '{\\pos(0,0)} &lt;sing&gt;\nnext'), '{\\N}title\nInjected', 'Artist');
  assert.match(text, /1,0:00:01.00,0:00:02.00,Lyrics/);
  assert.match(text, /｛＼pos\(0,0\)｝ <sing>\\Nnext/);
  assert.doesNotMatch(text, /\{\\pos|\{\\N\}/);
});
test('missing FFmpeg gives audio casting recovery instructions', async () => {
  const input = await fixture(), video = new CastVideo({ executable: path.join(input.directory, 'missing-ffmpeg') });
  try { await assert.rejects(video.render(input), /Install FFmpeg or choose Music only/); }
  finally { video.close(); await fs.rm(input.directory, { recursive: true, force: true }); }
});
test('TV rows follow the desktop scrolling timeline, including incoming lines and gaps', () => {
  const { scrollingFrame } = require('../karaoke-core');
  const lines = [{ time: 1, text: 'First line' }, { time: 4, text: 'Next line' }, { time: 5, text: '' }, { time: 16, text: 'After the gap' }];
  for (const time of [0, 1, 2, 3.8, 4.5, 5.1, 8.1, 12, 15.8, 16]) {
    const scene = scrollingFrame(lines, time), rows = tvRows(lines, time);
    for (const row of rows) {
      assert.equal(row.index, row.current ? scene.current : scene.next);
      assert.equal(row.opacity, row.current ? 1 - scene.fade : .12 + scene.progress * .88);
      const position = row.current ? 0 : 1;
      assert(Math.abs(row.y - (720 * .66 + (position - scene.progress) * (49 * 1.35 + 24))) < .001);
    }
  }
  const scrolling = lyricsAss(vtt, 'Title', 'Artist', 'scroll');
  assert.match(scrolling, /\\move/); assert.match(scrolling, /\\fade/);
  assert.doesNotMatch(scrolling, /\\kf|\\fad\(/);
  assert.match(scrolling, /Style: Lyrics,Manrope,49,&H00FFFFFF/);
  const timedLines = [{ time: 1, text: 'Sing & dance', words: [{ start: 0, time: 1 }, { start: 5, time: 1.5 }, { start: 7, time: 1.6 }] }, { time: 2, text: '' }];
  const embedded = lyricsAss(vtt, '', '', 'words', timedLines);
  assert.match(embedded, /\\t\(500,501,\\1c&H15CCFA&\)/);
  assert.match(embedded, /\\t\(600,601,\\1c&H15CCFA&\)/);
  assert.match(embedded, /\\1c&H15CCFA&/);
  assert.doesNotMatch(embedded, /\\kf/); // Desktop colors each word at its onset.
  assert.match(lyricsAss(vtt, '', '', 'words'), /\\t\(333,334,\\1c&H15CCFA&\)/);
  assert.equal(normalizeCastMode(undefined), 'music'); assert.equal(normalizeCastMode('unknown'), 'music');
  assert.equal(normalizeCastMode('words'), 'words');
  assert.equal(lyricsAss(vtt, '', '', 'unknown'), lyricsAss(vtt, '', '', 'single'));
});
test('real lyric video has audio, visible timed frames, byte-range seeking, caching and cleanup', async t => {
  try { await run('ffmpeg', ['-version']); await run('ffprobe', ['-version']); }
  catch { t.skip('FFmpeg and ffprobe are needed for video integration'); return; }
  const input = await fixture(), video = new CastVideo(), stream = createCastStream({ port: 0 });
  const original = await fs.readFile(input.filePath), progress = [];
  let output;
  try {
    output = await video.render({ ...input, onProgress: seconds => progress.push(seconds) });
    const metadata = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).stdout);
    assert.equal(metadata.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    assert.equal(metadata.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
    assert(Math.abs(Number(metadata.format.duration) - 3) < .3);
    assert(progress.length > 0);
    async function whitePixels(time) {
      const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
      let count = 0;
      for (let i = 500 * 1280 * 3; i < 680 * 1280 * 3; i += 3) if (stdout[i] > 180 && stdout[i + 1] > 180 && stdout[i + 2] > 180) count++;
      return count;
    }
    assert.equal(await whitePixels(.2), 0);
    assert(await whitePixels(1.2) > 500, 'active lyrics must be painted into video frames');
    assert.equal(await whitePixels(2.3), 0);
    const media = await stream.serve(output, '127.0.0.1');
    assert.equal(media.contentType, 'video/mp4'); assert.equal(media.tracks, undefined);
    const range = await fetch(media.contentId, { headers: { Range: 'bytes=0-31' } });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
    assert.equal(await video.render(input), output);
    assert.deepEqual(await fs.readFile(input.filePath), original);
  } finally {
    stream.close(); video.close();
    if (output) await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await fs.rm(input.directory, { recursive: true, force: true });
  }
});
test('cancelling preparation removes partial output and allows another song', async t => {
  try { await run('ffmpeg', ['-version']); } catch { t.skip('FFmpeg required'); return; }
  const input = await fixture(30), video = new CastVideo();
  try {
    await assert.rejects(video.render({ ...input, onProgress: () => video.cancel() }), /cancelled/);
    assert.equal((await fs.readdir(video.directory)).filter(file => /\.(mp4|ass)$/.test(file)).length, 0);
    const output = await video.render(input);
    assert((await fs.stat(output)).size > 0);
  } finally { video.close(); await fs.rm(input.directory, { recursive: true, force: true }); }
});
test('animated video frames move and fade, progressively highlight words, and cache modes separately', async t => {
  try { await run('ffmpeg', ['-version']); } catch { t.skip('FFmpeg required'); return; }
  const input = await fixture(), video = new CastVideo();
  async function pixels(file, time) {
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    let yellow = 0, ySum = 0, energy = 0;
    for (let y = 200; y < 600; y++) for (let x = 0; x < 1280; x++) {
      const index = (y * 1280 + x) * 3, r = stdout[index], g = stdout[index + 1], b = stdout[index + 2];
      const brightness = Math.max(0, r - 70) + Math.max(0, g - 70) + Math.max(0, b - 70);
      energy += brightness; ySum += y * brightness;
      if (r > 90 && g > 80 && b < 70) { yellow++; }
    }
    return { yellow, y: ySum / energy, energy };
  }
  try {
    const scroll = await video.render({ ...input, mode: 'scroll' });
    const early = await pixels(scroll, 1.15), late = await pixels(scroll, 1.6);
    assert(early.y - late.y > 35, 'active line must move upwards over time');
    assert((await pixels(scroll, .6)).energy > (await pixels(scroll, .03)).energy * 1.2, 'incoming line must fade in');
    assert((await pixels(scroll, 1.65)).energy > (await pixels(scroll, 1.96)).energy * 2, 'outgoing line must fade out');
    const timedLines = [{ time: 1, text: 'Sing & dance', words: [{ start: 0, time: 1 }, { start: 5, time: 1.5 }, { start: 7, time: 1.8 }] }, { time: 2, text: '' }];
    const words = await video.render({ ...input, mode: 'words', timedLines });
    assert.notEqual(words, scroll);
    const firstWord = await pixels(words, 1.15), lastWord = await pixels(words, 1.81);
    assert(lastWord.yellow > firstWord.yellow * 2, 'words must fill with color over time');
    assert.equal(early.yellow,0,'plain scrolling uses white text');
    assert(firstWord.y - lastWord.y > 30, 'word highlighting must keep scrolling');
    const predicted = await video.render({ ...input, mode: 'words' });
    assert.notEqual(predicted, words, 'embedded word timing must have its own cached video');
    assert((await pixels(predicted, 1.4)).yellow > (await pixels(words, 1.4)).yellow * 1.15, 'line predictions must differ from embedded word timing');
    assert.equal(await video.render({ ...input, mode: 'scroll' }), scroll);
  } finally { video.close(); await fs.rm(input.directory, { recursive: true, force: true }); }
});
