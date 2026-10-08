const fs = require('node:fs/promises');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

function privateAddress(host) {
  if (!net.isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
function createCastFirewall({ platform = process.platform, access = fs.access, run = execute } = {}) {
  let applying = false;
  async function executable(paths) {
    for (const path of paths) {
      try { await access(path, fs.constants.X_OK); return path; } catch {}
    }
    return null;
  }
  async function info(device, port) {
    if (!device || !privateAddress(device.host)) throw new Error('Choose an available Cast device on your local network.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Cast streaming port.');
    const ufw = platform === 'linux' ? await executable(['/usr/sbin/ufw', '/usr/bin/ufw']) : null;
    const pkexec = ufw ? await executable(['/usr/bin/pkexec']) : null;
    const args = ['allow', 'from', device.host, 'to', 'any', 'port', String(port), 'proto', 'tcp', 'comment', 'Nightwave Cast audio'];
    return {
      deviceId: device.id, deviceName: device.name, host: device.host, port,
      canApply: Boolean(ufw && pkexec),
      command: ufw ? `sudo ufw allow from ${device.host} to any port ${port} proto tcp comment 'Nightwave Cast audio'` : null,
      guidance: ufw ? 'Allow this device to receive music from Nightwave. This adds one UFW rule for the displayed device and port. Your system will ask for administrator authentication.'
        : `In your firewall settings, allow incoming TCP connections on port ${port} from ${device.host}. Also check that your router allows devices on this network to communicate.`,
      ufw, pkexec, args
    };
  }
  return {
    async info(device, port) { const { ufw, pkexec, args, ...publicInfo } = await info(device, port); return publicInfo; },
    async apply(device, port, expected) {
      if (applying) throw new Error('A firewall request is already in progress.');
      const rule = await info(device, port);
      if (expected?.host !== rule.host || expected?.port !== rule.port) throw new Error('The device address or streaming port changed. Open firewall help again before applying the rule.');
      if (!rule.canApply) throw new Error('Automatic firewall setup requires UFW and a system authentication service. Use the displayed instructions instead.');
      if (applying) throw new Error('A firewall request is already in progress.');
      applying = true;
      try {
        await run(rule.pkexec, [rule.ufw, ...rule.args], { timeout: 120000, maxBuffer: 64 * 1024 });
        return { ok: true, message: 'Firewall rule added. Try casting again.' };
      } catch (error) {
        if (error.code === 126 || error.code === 127) throw new Error('Administrator authentication was cancelled or denied. You can retry or use the command below.');
        if (error.killed) throw new Error('Administrator authentication timed out. You can retry or use the command below.');
        throw new Error('The firewall rule could not be added. Use the command below or adjust your firewall settings.');
      } finally { applying = false; }
    }
  };
}
module.exports = { createCastFirewall, privateAddress };
