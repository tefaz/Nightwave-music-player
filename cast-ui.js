(() => {
  const api = window.electronAPI, button = $('#cast-button');
  button.hidden = !api?.castDiscover;
  let devices = [], picker = null, lastDevice = null, firewallInfo = null, retryTrackId = null;
  const friendlyError = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  function paintButton() {
    button.classList.toggle('active', castState.connected);
    button.setAttribute('aria-pressed', String(castState.connected));
    button.title = castState.connected ? `Casting to ${castState.deviceName}` : 'Cast music';
    button.setAttribute('aria-label', button.title);
  }
  async function prepareLocal(position) {
    const track = state.tracks.find(item => item.id === state.currentId), request = ++playbackRequest;
    releaseAudio();
    if (!track?.path) return;
    try {
      const source = await api.fileUrl(track.path);
      if (request !== playbackRequest || castState.connected) return;
      audio.src = source;
      audio.addEventListener('loadedmetadata', () => {
        if (request === playbackRequest && Number.isFinite(audio.duration)) audio.currentTime = Math.min(position, audio.duration);
      }, { once: true });
    } catch (error) { toast(error.message); }
  }
  function receiveStatus(status) {
    if (typeof status.preparingLyrics === 'boolean') {
      const text = `Preparing TV lyrics${status.preparationPercent == null ? '' : ` · ${status.preparationPercent}%`}…`;
      $('#now-artist').textContent = status.preparingLyrics ? text : state.tracks.find(track => track.id === state.currentId)?.artist || 'Choose a track from your library';
      if (picker?.open) picker.querySelector('.cast-message').textContent = status.preparingLyrics ? text : 'Loading music on the TV…';
      return;
    }
    if (status.firewallDeviceId && !castBusy) { retryTrackId = status.firewallTrackId; openPicker(status.firewallDeviceId).catch(error => toast(friendlyError(error))); }
    if (status.error) toast(status.error);
    if (status.connected === false && castState.connected) {
      const position = castState.currentTime;
      castState = { connected: false, paused: true, currentTime: 0, duration: 0 };
      castLoading = false; castEnded = false;
      $('#play').textContent = '▶';
      volumeControl.value = audio.volume;
      volumeControl.style.setProperty('--value', `${audio.volume * 100}%`);
      paintButton(); updateMediaSession(); prepareLocal(position); renderPicker();
      return;
    }
    if (!castState.connected || castLoading || status.trackId !== state.currentId) return;
    castState.currentTime = status.currentTime;
    castState.duration = status.duration || castState.duration;
    castState.paused = status.playerState !== 'PLAYING';
    $('#current-time').textContent = time(castState.currentTime);
    $('#duration').textContent = time(castState.duration);
    updateSongProgress(castState.duration ? castState.currentTime / castState.duration * 100 : 0);
    $('#play').textContent = castState.paused ? '▶' : 'Ⅱ';
    updateMediaSession();
    if (status.playerState === 'IDLE' && !castEnded) {
      castEnded = true;
      if (status.idleReason === 'FINISHED') {
        if (state.repeat) playTrack(state.currentId, true, true);
        else nextTrack(false, true);
      } else if (status.idleReason === 'ERROR') toast('The TV could not play this audio format. Try another song.');
    }
  }
  api?.onCastStatus(receiveStatus);
  api?.onCastDevices(list => { devices = list; renderPicker(); });
  async function showFirewallHelp(device, onlyIfUnreachable = false) {
    const dialog = picker;
    if (!dialog?.open || !api.castFirewallInfo) return;
    try {
      const info = await api.castFirewallInfo(device.id);
      if (picker !== dialog || !dialog.open || (onlyIfUnreachable && !info.streamUnreachable)) return;
      firewallInfo = info; lastDevice = device;
      const panel = dialog.querySelector('.cast-firewall'); panel.hidden = false;
      panel.querySelector('.cast-firewall-summary').textContent = `${info.deviceName} (${info.host}) needs access to Nightwave's music stream on port ${info.port}.`;
      panel.querySelector('.cast-firewall-guidance').textContent = info.guidance;
      panel.querySelector('.cast-firewall-command').value = info.command || '';
      panel.querySelector('.cast-firewall-command').hidden = !info.command;
      panel.querySelector('.cast-firewall-copy').hidden = !info.command;
      panel.querySelector('.cast-firewall-apply').hidden = !info.canApply;
      panel.querySelector('.cast-firewall-status').textContent = info.streamUnreachable
        ? 'Your TV connected, but could not reach the music stream. Your firewall or network may be blocking it.' : '';
      renderPicker();
    } catch (error) { if (picker === dialog && dialog.open) dialog.querySelector('.cast-message').textContent = friendlyError(error); }
  }
  function renderPicker() {
    if (!picker?.open) return;
    const list = picker.querySelector('.cast-devices'); list.replaceChildren();
    for (const device of devices) {
      const item = document.createElement('button');
      item.type = 'button'; item.textContent = device.name; item.disabled = castBusy;
      item.onclick = () => connect(device); list.append(item);
    }
    if (!devices.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No devices found yet. Keep your TV on and connect it to the same local network as this computer.';
      list.append(empty);
    }
    picker.querySelector('.cast-karaoke-mode').disabled = castBusy;
    picker.querySelector('.cast-karaoke-note').textContent = { music: 'Stream the original music file to the default receiver, with no video or preparation wait.', single: 'One white lyric line at a time, like Nightwave’s current-line view.', scroll: 'The current and upcoming lines scroll together, using Nightwave’s fading and spacing.', words: 'Nightwave’s scrolling view with yellow word highlights. Uses embedded word timings when available; otherwise estimates from line timings.' }[castKaraokeMode()];
    picker.querySelector('.cast-disconnect').hidden = !castState.connected;
    picker.querySelector('.cast-help').hidden = !api.castFirewallInfo;
    picker.querySelectorAll('.cast-refresh,.cast-disconnect,.cast-help,.cast-firewall-apply,.cast-firewall-retry,.cast-firewall-copy').forEach(item => item.disabled = castBusy);
    picker.querySelector('.cast-help').disabled = castBusy || !devices.length;
  }
  async function connect(device) {
    if (castBusy) return;
    const track = state.tracks.find(item => item.id === state.currentId);
    if (track && !track.path) { toast('Load this song from your computer before casting it.'); return; }
    lastDevice = device; firewallInfo = null; retryTrackId = null;
    picker.querySelector('.cast-firewall').hidden = true;
    castBusy = true; renderPicker();
    const message = picker.querySelector('.cast-message'); message.textContent = `Connecting to ${device.name}…`;
    const position = castState.connected ? castState.currentTime : audio.currentTime || 0;
    const wasPlaying = !playbackPaused();
    const duration = castState.connected ? castState.duration : audio.duration || track?.duration || 0;
    audio.pause();
    try {
      const result = await api.castConnect(device.id);
      const current = state.tracks.find(item => item.id === state.currentId);
      castState = { connected: true, deviceName: result.name, paused: !wasPlaying, currentTime: position, duration };
      let captionResult;
      if (current) {
        castLoading = true; castEnded = false;
        captionResult = await api.castLoad({ id: current.id, path: current.path, title: current.title, artist: current.artist, album: current.album, currentTime: position, paused: !wasPlaying, captions: castLyricsEnabled(), karaokeMode: castKaraokeMode() });
      }
      if(Number.isFinite(result.volume)){volumeControl.value=result.volume;volumeControl.style.setProperty('--value',`${result.volume*100}%`);}
      paintButton(); updateMediaSession(); picker.close();
      toast(`Casting to ${result.name}.${captionResult?.captionState === 'video' ? ' Playing TV lyrics video.' : captionResult?.captionState === 'none' ? ' This song has no embedded timed lyrics.' : ''}`);
    } catch (error) {
      await api.castDisconnect().catch(() => {});
      if (picker?.open) message.textContent = `Could not connect: ${friendlyError(error)}`;
      else toast(error.message);
      await showFirewallHelp(device, true);
      await prepareLocal(position);
      if (wasPlaying) await audio.play().catch(() => {});
    } finally { castLoading = false; castBusy = false; renderPicker(); }
  }
  async function openPicker(helpDeviceId = null) {
    if (picker?.open) return;
    picker = document.createElement('dialog'); picker.className = 'cast-picker';
    picker.setAttribute('aria-label', 'Cast music');
    picker.innerHTML = '<h2>Cast music</h2><p class="cast-message" role="status">Choose a TV or speaker on your local network.</p><label class="cast-karaoke-option">Display mode<select class="cast-karaoke-mode"><option value="music">Music only (default)</option><option value="single">Karaoke · Current line</option><option value="scroll">Karaoke · Scrolling with fades</option><option value="words">Karaoke · Scrolling with word highlights</option></select></label><p class="cast-karaoke-note"></p><p class="cast-lyrics-note">Karaoke modes render embedded timed lyrics into a video. They require FFmpeg and a preparation wait. Changes apply to the next song or reconnect.</p><div class="cast-devices"></div><section class="cast-firewall" hidden aria-label="Firewall help"><h3>Allow music through your firewall</h3><p class="cast-firewall-summary"></p><p class="cast-firewall-guidance"></p><textarea class="cast-firewall-command" readonly rows="3" aria-label="Firewall command"></textarea><p class="cast-firewall-status" role="status"></p><div class="cast-actions"><button class="cast-firewall-copy" type="button">Copy command</button><button class="cast-firewall-apply" type="button">Allow this device</button><button class="cast-firewall-retry" type="button">Retry casting</button></div></section><div class="cast-actions"><button class="cast-help" type="button">Firewall help</button><button class="cast-refresh" type="button">Refresh</button><button class="cast-disconnect" type="button" hidden>Stop casting</button><button class="cast-close" type="button" autofocus>Close</button></div>';
    picker.querySelector('.cast-karaoke-mode').value = castKaraokeMode();
    picker.querySelector('.cast-karaoke-mode').onchange = event => { localStorage.setItem('nightwave-cast-mode', event.target.value); renderPicker(); };
    picker.addEventListener('cancel', event => { if (castBusy) event.preventDefault(); });
    picker.querySelector('.cast-close').onclick = () => { if (!castBusy) picker.close(); };
    const dialog = picker;
    dialog.addEventListener('close', () => { dialog.remove(); if (picker === dialog) picker = null; }, { once: true });
    picker.querySelector('.cast-help').onclick = () => {
      const device = devices.find(item => item.id === lastDevice?.id) || devices[0];
      if (device) showFirewallHelp(device);
    };
    picker.querySelector('.cast-firewall-copy').onclick = async () => {
      const dialog = picker, command = firewallInfo?.command;
      if (!command) return;
      try { await navigator.clipboard.writeText(command); if (picker === dialog) dialog.querySelector('.cast-firewall-status').textContent = 'Command copied. Paste it into a terminal to add the rule.'; }
      catch { if (picker === dialog) { dialog.querySelector('.cast-firewall-command').select(); dialog.querySelector('.cast-firewall-status').textContent = 'Select and copy the command above, then paste it into a terminal.'; } }
    };
    picker.querySelector('.cast-firewall-apply').onclick = async () => {
      if (castBusy || !firewallInfo?.canApply) return;
      const dialog = picker, info = firewallInfo;
      castBusy = true; renderPicker();
      const status = dialog.querySelector('.cast-firewall-status');
      status.textContent = 'Waiting for administrator authentication…';
      try {
        const result = await api.castFirewallApply({ deviceId: info.deviceId, host: info.host, port: info.port });
        if (picker === dialog) status.textContent = result.message;
      } catch (error) { if (picker === dialog) status.textContent = friendlyError(error); }
      finally { castBusy = false; renderPicker(); }
    };
    picker.querySelector('.cast-firewall-retry').onclick = () => {
      const device = devices.find(item => item.id === firewallInfo?.deviceId);
      if (device && castState.connected && retryTrackId) { const trackId = retryTrackId; picker.close(); playTrack(trackId); }
      else if (device) connect(device);
      else picker.querySelector('.cast-firewall-status').textContent = 'This device is no longer available. Refresh the device list.';
    };
    picker.querySelector('.cast-refresh').onclick = async () => { try { devices = await api.castDiscover(); renderPicker(); } catch (error) { picker.querySelector('.cast-message').textContent = error.message; } };
    picker.querySelector('.cast-disconnect').onclick = async () => {
      castBusy = true; renderPicker();
      try { await api.castDisconnect(); picker.close(); toast('Casting stopped. Press Play to listen on this computer.'); }
      catch (error) { toast(error.message); }
      finally { castBusy = false; renderPicker(); }
    };
    document.body.append(picker); picker.showModal(); renderPicker();
    try {
      devices = await api.castDiscover(); renderPicker();
      const helpDevice = devices.find(device => device.id === helpDeviceId);
      if (helpDevice) await showFirewallHelp(helpDevice, true);
    } catch (error) { if (picker?.open) picker.querySelector('.cast-message').textContent = friendlyError(error); }
  }
  button.onclick = () => {
    if (castLoading || castBusy) { toast('Wait for casting to finish loading.'); return; }
    return openPicker();
  };
})();
