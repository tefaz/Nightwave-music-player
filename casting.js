const { EventEmitter } = require('node:events');
const net = require('node:net');
const { createCastStream } = require('./cast-stream');
function invoke(target, method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The Cast device did not respond.')), 12000);
    try { target[method](...args, (error, result) => { clearTimeout(timer); error ? reject(error) : resolve(result); }); }
    catch (error) { clearTimeout(timer); reject(error); }
  });
}
class Casting extends EventEmitter {
  constructor(dependencies = {}) {
    super(); this.dependencies = dependencies; this.devices = new Map(); this.stream = dependencies.stream || createCastStream(); this.generation = 0; this.trackId = null;
  }
  discover() {
    if (!this.bonjour) {
      const { Bonjour } = this.dependencies.Bonjour ? this.dependencies : require('bonjour-service');
      this.bonjour = new Bonjour({}, error => this.emit('status', { error: `Device discovery failed: ${error.message}` }));
      this.browser = this.bonjour.find({ type: 'googlecast' }, service => {
        const address = service.addresses?.find(value => net.isIPv4(value));
        if (!address) return;
        const id = service.txt?.id || service.fqdn;
        this.devices.set(id, { id, name: String(service.txt?.fn || service.name), host: address, port: service.port });
        this.emit('devices', this.list());
      });
      this.browser.on('down', service => { this.devices.delete(service.txt?.id || service.fqdn); this.emit('devices', this.list()); });
    } else this.browser.update();
    return this.list();
  }
  list() { return [...this.devices.values()].map(({ id, name }) => ({ id, name })); }
  async connect(id) {
    const device = this.devices.get(id);
    if (!device) throw new Error('This Cast device is no longer available. Refresh the device list.');
    await this.disconnect();
    const generation = ++this.generation;
    const { Client, DefaultMediaReceiver } = this.dependencies.Client ? this.dependencies : require('castv2-client');
    const client = this.client = new Client();
    client.on('error', error => { if (this.client === client) { this.disconnect().catch(() => {}); this.emit('status', { connected: false, error: `Cast connection lost: ${error.message}` }); } });
    try {
      await invoke(client, 'connect', { host: device.host, port: device.port });
      if (generation !== this.generation) throw new Error('Cast connection cancelled.');
      const player = await invoke(client, 'launch', DefaultMediaReceiver);
      if (generation !== this.generation) throw new Error('Cast connection cancelled.');
      this.player = player; this.device = device;
      this.host = client.client.socket.localAddress?.replace(/^::ffff:/, '');
      if (!net.isIPv4(this.host) || this.host === '127.0.0.1') throw new Error('Could not find a local network address for streaming.');
      player.on('status', status => { if (this.player === player) this.status(status); });
      player.once('close', () => { if (this.player === player) { this.disconnect().catch(() => {}); this.emit('status', { connected: false, error: 'The Cast session ended on the TV.' }); } });
      let polling = false;
      this.poll = setInterval(async () => {
        if (this.loading || polling || this.player !== player) return;
        polling = true;
        try { const status = await invoke(player, 'getStatus'); if (this.player === player) this.status(status); }
        catch (error) { if (this.player === player) { this.disconnect().catch(() => {}); this.emit('status', { connected: false, error: error.message }); } }
        finally { polling = false; }
      }, 1000);
      this.emit('status', { connected: true, deviceName: device.name });
      const volume = await invoke(client, 'getVolume');
      return { name: device.name, volume: volume?.level };
    } catch (error) { if (this.client === client) await this.disconnect(); throw error; }
  }
  status(status) {
    if (!status || !this.player || this.loading || !this.trackId || (status.media?.contentId ? status.media.contentId !== this.contentId : !this.mediaSessionId || status.mediaSessionId !== this.mediaSessionId)) return;
    this.emit('status', { connected: true, deviceName: this.device.name, trackId: this.trackId, currentTime: status.currentTime || 0, duration: status.media?.duration || 0, playerState: status.playerState, idleReason: status.idleReason });
  }
  async load(track) {
    if (!this.player) throw new Error('Connect to a Cast device first.');
    const player = this.player, generation = this.generation;
    this.loading = true; this.lastLoadFailure = null;
    try {
      const media = await this.stream.serve(track.path, this.host, track.captionVtt);
      if (generation !== this.generation) throw new Error('Cast connection cancelled.');
      const captionStyle = media.tracks?.length ? { textTrackStyle: { foregroundColor: '#FFFFFFFF', backgroundColor: '#000000B3', edgeType: 'OUTLINE', edgeColor: '#000000FF', fontScale: 1.5, fontGenericFamily: 'SANS_SERIF' } } : {};
      const status = await invoke(player, 'load', { ...media, ...captionStyle, streamType: 'BUFFERED', metadata: { metadataType: track.videoLyrics ? 0 : 3, title: String(track.title || ''), artist: String(track.artist || ''), albumName: String(track.album || '') } }, { autoplay: !track.paused, currentTime: Math.max(0, Number(track.currentTime) || 0), ...(media.tracks?.length ? { activeTrackIds: [1] } : {}) });
      if (generation !== this.generation) throw new Error('Cast connection cancelled.');
      const latest = await invoke(player, 'getStatus');
      if (generation !== this.generation) throw new Error('Cast connection cancelled.');
      this.mediaSessionId = latest?.mediaSessionId || status?.mediaSessionId;
      this.trackId = track.id; this.contentId = media.contentId; this.loading = false; this.status(status);
      return { captionState: track.videoLyrics ? 'video' : media.tracks?.length ? 'sent' : track.captions ? 'none' : 'disabled' };
    } catch (error) {
      if (error.message === 'The Cast device did not respond.') {
        const diagnostics = this.stream.diagnostics?.();
        if (diagnostics && !diagnostics.requested) {
          this.lastLoadFailure = { kind: 'stream-unreachable', host: this.device?.host, port: diagnostics.port };
          throw new Error(`The TV could not reach Nightwave's audio stream on TCP port ${diagnostics.port}. Allow this port from ${this.device?.host || 'the Cast device'} through your computer's firewall, then try again.`);
        }
        throw new Error('The TV did not finish loading the audio. Try another song or check whether its audio format is supported by your Cast device.');
      }
      throw error;
    } finally { this.loading = false; }
  }
  async command(command, value) {
    const player = this.player;
    if (!player) throw new Error('No Cast device is connected.');
    if (command === 'volume' && Number.isFinite(value) && value >= 0 && value <= 1) return invoke(this.client, 'setVolume', { level: value });
    if (command === 'seek' && Number.isFinite(value) && value >= 0) return invoke(player, 'seek', value);
    if (['play', 'pause', 'stop'].includes(command)) {
      if (command === 'stop') { this.trackId = null; this.stream.revoke(); if (!player.media?.currentSession) return; }
      return invoke(player, command);
    }
    throw new Error('Invalid Cast command.');
  }
  async disconnect() {
    ++this.generation; clearInterval(this.poll); this.trackId = null;
    const client = this.client, player = this.player;
    this.client = this.player = this.device = null; this.stream.close();
    if (player?.media?.currentSession) { try { await invoke(player, 'stop'); } catch {} }
    if (client?.client.socket) client.close(); this.emit('status', { connected: false });
  }
  close() { this.disconnect().catch(() => {}); this.browser?.stop(); this.bonjour?.destroy(); }
}
module.exports = { Casting };
