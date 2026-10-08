const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCastStream } = require('../cast-stream');
const { Casting } = require('../casting');

test('Cast stream serves only the current token, supports seeking, and revokes access', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightwave-cast-'));
  const file = path.join(directory, 'music.mp3'); await fs.writeFile(file, Buffer.from('0123456789'));
  const stream = createCastStream({ port: 0 });
  try {
    const media = await stream.serve(file, '127.0.0.1');
    assert.equal(stream.diagnostics().requested, false);
    const full = await fetch(media.contentId); assert.equal(await full.text(), '0123456789');
    assert.equal(stream.diagnostics().requested, true);
    assert.equal(full.headers.get('content-type'), 'audio/mpeg');
    for (const [range, text, header] of [['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']]) {
      const response = await fetch(media.contentId, { headers: { Range: range } });
      assert.equal(response.status, 206); assert.equal(await response.text(), text); assert.equal(response.headers.get('content-range'), header);
    }
    const head = await fetch(media.contentId, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
    for (const range of ['bytes=99-', 'bytes=4-2', 'bytes=0-1,3-4', 'garbage', 'bytes=-0']) assert.equal((await fetch(media.contentId, { headers: { Range: range } })).status, 416);
    assert.equal((await fetch(new URL('/etc/passwd', media.contentId))).status, 404);
    await stream.serve(file, '127.0.0.1'); assert.equal((await fetch(media.contentId)).status, 404);
    stream.revoke(); assert.equal((await fetch(media.contentId)).status, 404);
  } finally { stream.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

function rig() {
  const calls = [], player = new EventEmitter();
  player.media = {};
  player.load = (media, options, callback) => { calls.push(['load', media, options]); player.status = { media: { ...media, duration: 90 }, playerState: options.autoplay ? 'PLAYING' : 'PAUSED', currentTime: options.currentTime }; callback(null, player.status); };
  player.getStatus = callback => { player.media.currentSession = player.status; callback(null, player.status); };
  for (const command of ['play', 'pause', 'stop']) player[command] = callback => { calls.push([command]); callback(null, player.status); };
  player.seek = (time, callback) => { calls.push(['seek', time]); callback(null, player.status); };
  class Client extends EventEmitter {
    constructor() { super(); this.client = { socket: { localAddress: '192.168.1.20' } }; }
    connect(options, callback) { calls.push(['connect', options]); callback(); }
    launch(receiver, callback) { callback(null, player); }
    getVolume(callback) { callback(null, { level: 0.4 }); }
    setVolume(volume, callback) { calls.push(['volume', volume]); callback(); }
    close() { calls.push(['close']); this.client.socket = null; }
  }
  const stream = { serve: async (file, host) => { calls.push(['serve', file, host]); return { contentId: 'http://local/music/token', contentType: 'audio/mpeg' }; }, close() { calls.push(['revoke']); }, revoke() {} };
  const cast = new Casting({ Client, DefaultMediaReceiver: {}, stream });
  cast.devices.set('tv', { id: 'tv', name: 'Living room', host: '192.168.1.30', port: 8009 });
  return { cast, calls, player };
}

test('TV lyric video uses video metadata and preserves position and pause without caption tracks', async () => {
  const { cast, calls } = rig();
  cast.stream.serve = async () => ({ contentId: 'http://local/music/video', contentType: 'video/mp4' });
  try {
    await cast.connect('tv');
    const result = await cast.load({ id: 'lyrics', path: '/tmp/lyrics.mp4', videoLyrics: true, currentTime: 12, paused: true });
    const [, media, options] = calls.find(call => call[0] === 'load');
    assert.equal(media.contentType, 'video/mp4'); assert.equal(media.metadata.metadataType, 0);
    assert.equal(media.tracks, undefined); assert.equal(media.textTrackStyle, undefined);
    assert.deepEqual(options, { autoplay: false, currentTime: 12 });
    assert.equal(result.captionState, 'video');
  } finally { await cast.disconnect(); }
});

test('Cast handoff preserves position and pause, routes controls and rejects stale status', async () => {
  const { cast, calls, player } = rig(), statuses = [];
  cast.on('status', value => statuses.push(value));
  try {
    await cast.connect('tv');
    await cast.load({ id: 'song', path: '/music/song.mp3', title: 'Song', currentTime: 24, paused: true });
    assert.deepEqual(calls.find(call => call[0] === 'serve'), ['serve', '/music/song.mp3', '192.168.1.20']);
    const load = calls.find(call => call[0] === 'load');
    assert.deepEqual(load[2], { autoplay: false, currentTime: 24 });
    assert.equal(load[1].metadata.metadataType, 3);
    assert.equal(statuses.at(-1).trackId, 'song'); assert.equal(statuses.at(-1).playerState, 'PAUSED');
    await cast.command('play'); await cast.command('pause'); await cast.command('seek', 30); await cast.command('volume', 0.3);
    assert(calls.some(call => call[0] === 'seek' && call[1] === 30));
    assert.deepEqual(calls.find(call => call[0] === 'volume'), ['volume', { level: 0.3 }]);
    await assert.rejects(cast.command('volume', 2)); await assert.rejects(cast.command('seek', -1));
    const count = statuses.length;
    player.emit('status', { ...player.status, media: { contentId: 'http://old-song' } }); assert.equal(statuses.length, count);
    player.emit('status', { ...player.status, playerState: 'IDLE', idleReason: 'FINISHED' }); assert.equal(statuses.at(-1).idleReason, 'FINISHED');
    await cast.disconnect(); assert.equal(statuses.at(-1).connected, false); assert(calls.some(call => call[0] === 'stop')); assert(calls.some(call => call[0] === 'close'));
    await assert.rejects(cast.command('play'));
  } finally { cast.close(); }
});

test('Cast discovery uses friendly names, refreshes, and removes offline devices', async () => {
  const browser = new EventEmitter(); browser.update = () => { browser.updated = true; }; browser.stop = () => {};
  class Bonjour { constructor(options, onError) { this.onError = onError; } find(options, onUp) { this.onUp = onUp; return browser; } destroy() {} }
  const cast = new Casting({ Bonjour }), updates = [];
  cast.on('devices', value => updates.push(value));
  try {
    assert.deepEqual(cast.discover(), []);
    const service = { txt: { id: 'abc', fn: 'My TV' }, addresses: ['::1', '192.168.0.2'], name: 'id', port: 8009 };
    cast.bonjour.onUp(service); assert.deepEqual(cast.list(), [{ id: 'abc', name: 'My TV' }]);
    cast.discover(); assert.equal(browser.updated, true);
    browser.emit('down', service); assert.deepEqual(updates.at(-1), []);
    await assert.rejects(cast.connect('abc'), /no longer available/);
  } finally { cast.close(); }
});

test('patched Cast protocol encodes and decodes actual messages', async () => {
  const proto = require('castv2/lib/proto');
  // The dependency loads its bundled schema asynchronously.
  await new Promise(resolve => setTimeout(resolve, 100));
  const message = { protocolVersion: 0, sourceId: 'sender-0', destinationId: 'receiver-0', namespace: 'urn:x-cast:com.google.cast.media', payloadType: 0, payloadUtf8: '{"type":"GET_STATUS"}' };
  assert.equal(proto.CastMessage.parse(proto.CastMessage.serialize(message)).payloadUtf8, message.payloadUtf8);
});

test('Cast streaming uses a stable default port and reports occupied ports without switching', async () => {
  const { DEFAULT_CAST_PORT } = require('../cast-stream');
  const defaultStream = createCastStream();
  assert.equal(defaultStream.diagnostics().port, DEFAULT_CAST_PORT);
  defaultStream.close();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightwave-cast-port-'));
  const file = path.join(directory, 'music.mp3'); await fs.writeFile(file, 'audio');
  const first = createCastStream({ port: 0 }); let second;
  try {
    const media = await first.serve(file, '127.0.0.1'), port = Number(new URL(media.contentId).port);
    second = createCastStream({ port });
    await assert.rejects(second.serve(file, '127.0.0.1'), new RegExp(`port ${port} is already in use`));
    assert.equal(second.diagnostics().port, port);
  } finally { first.close(); second?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Cast load errors distinguish an unreachable audio stream from media loading problems', async () => {
  for (const requested of [false, true]) {
    const { cast, player } = rig();
    cast.stream.diagnostics = () => ({ port: 40789, requested });
    player.load = (_media, _options, callback) => callback(new Error('The Cast device did not respond.'));
    try {
      await cast.connect('tv');
      await assert.rejects(cast.load({ id: 'song', path: '/music/song.mp3' }), requested
        ? /did not finish loading the audio/
        : /TCP port 40789.*192\.168\.1\.30.*firewall/);
      assert.equal(cast.loading, false);
    } finally { cast.close(); }
  }
});

test('timed lyrics become safe WebVTT cues with gaps, duplicate timestamps and song boundaries', () => {
  const { lyricsWebVtt } = require('../cast-lyrics');
  const vtt = lyricsWebVtt([
    { time: 1.25, text: 'Café <tag> & friends' }, { time: 1.25, text: 'Together' },
    { time: 3, text: '' }, { time: 20, text: 'Last line' }, { time: NaN, text: 'Invalid' }
  ], 23);
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:01\.250 --> 00:00:03\.000\nCafé &lt;tag&gt; &amp; friends\nTogether\n\n2\n00:00:20\.000 --> 00:00:23\.000\nLast line/);
  assert.equal(lyricsWebVtt([], 60), null);
  assert.equal(lyricsWebVtt([{ time: 30, text: 'Past end' }], 10), null);
  assert.match(lyricsWebVtt([{ time: 2, text: 'Short verse' }, { time: 30, text: 'After gap' }]), /00:00:02\.000 --> 00:00:10\.000/);
});

test('caption endpoint uses the music port, serves CORS and UTF-8, and expires with its song', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nightwave-cast-caption-'));
  const file = path.join(directory, 'song.mp3'); await fs.writeFile(file, 'audio');
  const stream = createCastStream({ port: 0 }), vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nCafé\n\n';
  try {
    const media = await stream.serve(file, '127.0.0.1', vtt), url = media.tracks[0].trackContentId;
    assert.equal(new URL(url).port, new URL(media.contentId).port);
    assert.equal(stream.diagnostics().captionsRequested, false);
    const options = await fetch(url, { method: 'OPTIONS' }); assert.equal(options.status, 204);
    const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(vtt))); assert.equal(await head.text(), '');
    const caption = await fetch(url); assert.equal(caption.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.equal(caption.headers.get('access-control-allow-origin'), '*'); assert.equal(await caption.text(), vtt);
    assert.equal(stream.diagnostics().captionsRequested, true); assert.equal(stream.diagnostics().requested, false);
    const replacement = await stream.serve(file, '127.0.0.1');
    assert.equal(replacement.tracks, undefined); assert.equal((await fetch(url)).status, 404);
    const again = await stream.serve(file, '127.0.0.1', vtt); stream.revoke(); assert.equal((await fetch(again.tracks[0].trackContentId)).status, 404);
  } finally { stream.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Cast LOAD attaches and activates caption tracks while preserving seeking and pause', async () => {
  const { cast, calls } = rig();
  let served;
  cast.stream.serve = async (file, host, vtt) => { served = vtt; return { contentId: 'http://local/music/token', contentType: 'audio/mpeg', tracks: [{ trackId: 1, type: 'TEXT', trackContentId: 'http://local/music/token/lyrics.vtt', trackContentType: 'text/vtt', name: 'Timed lyrics', language: 'und', subtype: 'SUBTITLES' }] }; };
  try {
    await cast.connect('tv');
    const result = await cast.load({ id: 'song', path: '/song.mp3', captions: true, captionVtt: 'WEBVTT\n\n', currentTime: 42, paused: true });
    assert.equal(served, 'WEBVTT\n\n'); assert.equal(result.captionState, 'sent');
    const load = calls.find(call => call[0] === 'load');
    assert.deepEqual(load[2], { autoplay: false, currentTime: 42, activeTrackIds: [1] });
    assert.equal(load[1].tracks[0].trackContentType, 'text/vtt'); assert.equal(load[1].textTrackStyle.fontScale, 1.5);
  } finally { cast.close(); }
});
