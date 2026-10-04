(() => {
  const button = document.querySelector('#karaoke-toggle');
  const panel = document.querySelector('#tunnel-visualizer');
  const overlay = document.querySelector('#karaoke-lyrics');
  const status = document.querySelector('#karaoke-status');
  const { timedLyrics, currentLine } = NightwaveKaraokeCore;
  let enabled = false, request = 0, lines = [], frame = 0;

  function paint() {
    const text = enabled && !audio.ended ? currentLine(lines, audio.currentTime) : '';
    if (overlay.textContent !== text) overlay.textContent = text;
    overlay.hidden = !text;
  }
  function animate() {
    frame = 0;
    paint();
    if (enabled && !panel.hidden && !audio.paused) frame = requestAnimationFrame(animate);
  }
  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    animate();
  }
  async function refresh(track) {
    const token = ++request;
    lines = [];
    paint();
    status.hidden = !enabled;
    if (!enabled) return;
    status.textContent = track ? 'Loading timed lyrics…' : 'Play a song to show karaoke lyrics.';
    if (!track) return;
    try {
      let result = [];
      if (track.path && window.electronAPI?.readTimedLyrics) result = await window.electronAPI.readTimedLyrics(track.path);
      else if (track.file) {
        const parseBlob = await metadataParser;
        if (parseBlob) result = timedLyrics(await parseBlob(track.file, { skipCovers: true }));
      }
      if (token !== request) return;
      lines = result;
      status.textContent = lines.length ? '' : 'This song has no timed lyrics in its metadata.';
      status.hidden = Boolean(lines.length);
      sync();
    } catch {
      if (token !== request) return;
      status.textContent = 'Timed lyrics could not be read from this file.';
    }
  }
  button.onclick = () => {
    enabled = !enabled;
    button.textContent = enabled ? 'Turn off karaoke lyrics' : 'Turn on karaoke lyrics';
    button.setAttribute('aria-pressed', String(enabled));
    refresh(state.tracks.find(track => track.id === state.currentId));
    sync();
  };
  for (const event of ['play', 'pause', 'seeked', 'seeking', 'timeupdate', 'ended']) audio.addEventListener(event, sync);
  new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  window.NightwaveKaraoke = { refresh, clear: () => refresh(null) };
})();
