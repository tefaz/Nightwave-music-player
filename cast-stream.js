const http = require('node:http');
const fs = require('node:fs');
const { stat } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const types = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };
const DEFAULT_CAST_PORT = 40789;
function createCastStream({ port = Number(process.env.NIGHTWAVE_CAST_PORT || DEFAULT_CAST_PORT) } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Nightwave Cast streaming port.');
  let current = null;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    const isCaptions = current?.captions && req.url === current.captionUrl;
    if (!current || (req.url !== current.url && !isCaptions)) { res.writeHead(404).end(); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const file = current;
    if (isCaptions) {
      const body = Buffer.from(file.captions, 'utf8');
      if (req.method === 'GET') file.captionsRequested = true;
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body); return;
    }
    try {
      const { size } = await stat(file.path);
      if (req.method === 'GET') file.requested = true;
      let start = 0, end = size - 1, code = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
        code = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      res.writeHead(code, { 'Content-Type': file.type, 'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1), 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD' || !size) { res.end(); return; }
      const stream = fs.createReadStream(file.path, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  return {
    async serve(filePath, host, captions = null) {
      if (!server.listening) await new Promise((resolve, reject) => {
        const onError = error => reject(new Error(error.code === 'EADDRINUSE'
          ? `Nightwave's Cast streaming port ${port} is already in use. Close other Nightwave instances or set NIGHTWAVE_CAST_PORT to another port.`
          : `Could not start the Cast audio stream: ${error.message}`));
        server.once('error', onError);
        server.listen(port, '0.0.0.0', () => { server.removeListener('error', onError); resolve(); });
      });
      current = { path: filePath, type: types[path.extname(filePath).toLowerCase()], url: `/music/${randomBytes(24).toString('hex')}`, requested: false };
      current.captions = typeof captions === 'string' ? captions : null;
      current.captionUrl = `${current.url}/lyrics.vtt`;
      current.captionsRequested = false;
      if (!current.type) throw new Error('This audio format cannot be cast.');
      const base = `http://${host}:${server.address().port}`;
      return { contentId: `${base}${current.url}`, contentType: current.type, ...(current.captions ? { tracks: [{ trackId: 1, type: 'TEXT', trackContentId: `${base}${current.captionUrl}`, trackContentType: 'text/vtt', name: 'Timed lyrics', language: 'und', subtype: 'SUBTITLES' }] } : {}) };
    },
    diagnostics() { return { port: server.address()?.port || port, requested: Boolean(current?.requested), captionsRequested: Boolean(current?.captionsRequested) }; },
    revoke() { current = null; },
    close() { current = null; server.close(); server.closeAllConnections(); }
  };
}
module.exports = { createCastStream, DEFAULT_CAST_PORT };
