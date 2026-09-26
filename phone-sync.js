const path = require('node:path');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');

function playlistFolder(name) {
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 180 || /[\x00-\x1f]/.test(name) || name.trim() === '.' || name.trim() === '..') {
    throw new Error('Invalid playlist name for phone sync.');
  }
  return encodeURIComponent(name.trim().replace(/[\/\\]/g, '_')).replace(/\./g, '%2E');
}

async function fileIdentity(filePath) {
  const before = await fs.stat(filePath);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const after = await fs.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error('The source file changed while preparing sync. Please try again.');
  }
  const extension = path.extname(filePath);
  // Stable content-based names disambiguate identical basenames, even across later syncs.
  let stem = '';
  for (const character of path.basename(filePath, extension)) {
    if (Buffer.byteLength(stem + character) > 180) break;
    stem += character;
  }
  return { name: `${stem} [${hash.digest('hex').slice(0, 16)}]${extension}`, size: after.size };
}

function createPhoneSync({ runCommand, identify = fileIdentity, kioMusicUri = 'mtp:/Redmi Note 11/Internal shared storage/Music/' }) {
  const gio = args => runCommand('gio', args);
  const kioOptions = ['--platform', 'offscreen', '--noninteractive'];
  const kio = args => runCommand('kioclient5', [...kioOptions, ...args]);

  async function phoneMusicUri(name) {
    const mounts = await gio(['mount', '-li']);
    const roots = [...mounts.matchAll(/mtp:\/\/[^\s]+/g)].map(match => match[0]);
    if (!roots.length) {
      const error = new Error('No MTP phone is mounted. Unlock your phone and choose File transfer.');
      error.code = 'NO_GIO_PHONE';
      throw error;
    }
    const root = roots.find(uri => mounts.slice(Math.max(0, mounts.indexOf(uri) - 300), mounts.indexOf(uri) + 300).includes('Redmi Note 11')) || roots[0];
    return `${root.replace(/\/?$/, '/')}Internal%20shared%20storage/Music/${playlistFolder(name)}/`;
  }

  async function transfer(filePaths, uri, backend, onProgress = () => {}) {
    if (backend === 'gio') await gio(['mkdir', '-p', uri]);
    else {
      try { await kio(['stat', uri]); }
      catch { await kio(['mkdir', uri]); }
    }
    let copied = 0, skipped = 0;
    const failed = [];
    for (const [index, filePath] of filePaths.entries()) {
      onProgress(index, filePath);
      try {
        const { name, size } = await identify(filePath);
        const destination = `${uri}${encodeURIComponent(name)}`;
        if (backend === 'gio') {
          let info = '';
          try { info = await gio(['info', '-a', 'standard::size', destination]); } catch { /* Not present yet. */ }
          const remoteSize = info.match(/standard::size:\s*(\d+)/);
          if (remoteSize && Number(remoteSize[1]) === size) { skipped++; continue; }
          // GIO overwrites a partial destination; verify its length before reporting success.
          await gio(['copy', '--no-target-directory', filePath, destination]);
          const verification = await gio(['info', '-a', 'standard::size', destination]);
          if (Number(verification.match(/standard::size:\s*(\d+)/)?.[1]) !== size) throw new Error('Copied file size could not be verified.');
        } else {
          // KDE stat output varies by version. Compare remote content rather than trusting existence.
          let remoteHash = '';
          try { remoteHash = (await runCommand('kioclient5', [...kioOptions, 'cat', destination], { hash: true })).slice(0, 16); } catch { /* Not present or unreadable. */ }
          const expectedHash = name.match(/\[([a-f0-9]{16})\]\.[^.]+$/)?.[1];
          if (remoteHash && remoteHash === expectedHash) { skipped++; continue; }
          await kio(['--overwrite', 'copy', pathToUri(filePath), destination]);
          const verification = (await runCommand('kioclient5', [...kioOptions, 'cat', destination], { hash: true })).slice(0, 16);
          if (verification !== expectedHash) throw new Error('Copied file content could not be verified.');
        }
        copied++;
      } catch (error) { failed.push(`${path.basename(filePath)}: ${error.message}`); }
      finally { onProgress(index + 1, filePath); }
    }
    return { copied, skipped, failed };
  }

  async function sync(filePaths, name, onProgress) {
    let uri;
    try { uri = await phoneMusicUri(name); }
    catch (error) {
      if (error.code !== 'NO_GIO_PHONE' && error.code !== 'ENOENT') throw error;
      uri = `${kioMusicUri}${playlistFolder(name)}/`;
      return transfer(filePaths, uri, 'kio', onProgress);
    }
    return transfer(filePaths, uri, 'gio', onProgress);
  }

  return { sync, transfer, phoneMusicUri };
}

function pathToUri(filePath) { return require('node:url').pathToFileURL(filePath).href; }
module.exports = { createPhoneSync, fileIdentity, playlistFolder };
