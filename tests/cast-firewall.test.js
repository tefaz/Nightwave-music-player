const test = require('node:test');
const assert = require('node:assert/strict');
const { createCastFirewall } = require('../cast-firewall');
const device = { id: 'tv', name: 'Living room TV', host: '192.168.1.9' };
const expected = { host: device.host, port: 40789 };
const installed = async executable => { if (!['/usr/bin/ufw', '/usr/bin/pkexec'].includes(executable)) throw Error('Missing'); };

test('firewall help builds a device-specific command and only exposes supported actions', async () => {
  const firewall = createCastFirewall({ platform: 'linux', access: installed });
  const info = await firewall.info(device, 40789);
  assert.equal(info.canApply, true);
  assert.equal(info.command, "sudo ufw allow from 192.168.1.9 to any port 40789 proto tcp comment 'Nightwave Cast audio'");
  assert.equal(info.deviceName, device.name);
  assert.equal(info.ufw, undefined); assert.equal(info.args, undefined);
  for (const platform of ['win32', 'darwin']) {
    const help = await createCastFirewall({ platform }).info(device, 40789);
    assert.equal(help.canApply, false); assert.equal(help.command, null); assert.match(help.guidance, /40789.*192\.168\.1\.9/);
  }
  const missing = await createCastFirewall({ platform: 'linux', access: async () => { throw Error('Missing'); } }).info(device, 40789);
  assert.equal(missing.canApply, false);
});

test('firewall button runs one narrow rule with authentication and no shell', async () => {
  const calls = [];
  const firewall = createCastFirewall({ platform: 'linux', access: installed, run: async (...args) => { calls.push(args); } });
  assert.equal((await firewall.apply(device, 40789, expected)).ok, true);
  assert.equal(calls[0][0], '/usr/bin/pkexec');
  assert.deepEqual(calls[0][1], ['/usr/bin/ufw', 'allow', 'from', '192.168.1.9', 'to', 'any', 'port', '40789', 'proto', 'tcp', 'comment', 'Nightwave Cast audio']);
  assert.equal(calls[0][2].shell, undefined);
  await assert.rejects(firewall.apply(device, 40789, { host: '192.168.1.10', port: 40789 }), /changed/);
  await assert.rejects(firewall.apply(device, 40789, { ...expected, port: 22 }), /changed/);
  for (const host of ['127.0.0.1', '8.8.8.8', '192.168.1.9; bad-command', '::1']) await assert.rejects(firewall.info({ ...device, host }, 40789), /local network/);
  for (const port of [0, -1, 65536, '40789']) await assert.rejects(firewall.info(device, port), /Invalid/);
  await assert.rejects(firewall.info(null, 40789), /Choose/);
  assert.equal(calls.length, 1);
});

test('cancelled authentication can be retried and concurrent firewall requests are rejected', async () => {
  let resolve, runs = 0;
  const firewall = createCastFirewall({ platform: 'linux', access: installed, run: async () => {
    if (++runs === 1) throw Object.assign(Error('Cancelled'), { code: 126 });
    return new Promise(done => { resolve = done; });
  } });
  await assert.rejects(firewall.apply(device, 40789, expected), /cancelled or denied/);
  const first = firewall.apply(device, 40789, expected);
  while (!resolve) await new Promise(done => setImmediate(done));
  await assert.rejects(firewall.apply(device, 40789, expected), /already in progress/);
  resolve(); assert.equal((await first).ok, true); assert.equal(runs, 2);
});
