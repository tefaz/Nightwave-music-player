(() => {
  const button = document.querySelector('#karaoke-toggle');
  const panel = document.querySelector('#tunnel-visualizer');
  const overlay = document.querySelector('#karaoke-lyrics');
  const status = document.querySelector('#karaoke-status');
  const modeButton = document.querySelector('#karaoke-mode');
  const highlightButton = document.querySelector('#karaoke-highlight');
  let highlighting = localStorage.getItem('nightwave-karaoke-highlight') !== 'false';
  function updateHighlight() {
    highlightButton.textContent = `Word highlighting: ${highlighting ? 'On' : 'Off'}`;
    highlightButton.setAttribute('aria-pressed', String(highlighting));
  }
  updateHighlight();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const { timedLyrics, wordSegments, scrollingFrame } = NightwaveKaraokeCore;
  let mode = localStorage.getItem('nightwave-karaoke-mode') === 'current' ? 'current' : 'scrolling';
  let rendered = '', rows = [];
  function updateMode() {
    modeButton.textContent = `Karaoke Mode: ${mode === 'scrolling' ? 'Scrolling lines' : 'Current line'}`;
    modeButton.title = `Switch to ${mode === 'scrolling' ? 'current line' : 'scrolling lines'}`;
    overlay.classList.toggle('karaoke-scrolling', mode === 'scrolling');
    rendered = '';
  }
  updateMode();
  let enabled = false, request = 0, lines = [], frame = 0;

  function paint() {
    const seconds = audio.currentTime;
    const scene = scrollingFrame(lines, seconds);
    const current = scene.current;
    const indices = enabled && !audio.ended
      ? (mode === 'scrolling' ? [current, scene.next] : [current]) : [];
    const key = `${request}:${mode}:${indices.join(',')}`;
    if (key !== rendered) {
      rendered = key;
      overlay.replaceChildren();
      rows = indices.map(index => {
        const row = document.createElement('div');
        row.className = 'karaoke-line';
        const words = wordSegments(lines, index).map(word => {
          const span = document.createElement('span');
          span.textContent = word.text;
          row.append(span);
          return { span, time: word.time };
        });
        row.hidden = index < 0 || !words.length;
        overlay.append(row);
        return { row, words };
      });
    }
    overlay.hidden = !rows.some(({ row }) => !row.hidden);
    const distance = Math.max(...rows.map(({ row }) => row.offsetHeight), 0) + 24;
    rows.forEach(({ row, words }, position) => {
      for (const word of words) word.span.classList.toggle('karaoke-sung', highlighting && seconds >= word.time);
      if (mode === 'scrolling') {
        const shift = motion.matches ? position * distance : (position - scene.progress) * distance;
        row.style.transform = `translateY(${shift}px)`;
        row.style.opacity = String(motion.matches ? (position ? 0.65 : 1) : position ? 0.12 + scene.progress * 0.88 : 1 - scene.fade);
      } else {
        row.style.transform = '';
        row.style.opacity = '';
      }
    });
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
    button.textContent = enabled ? 'Karaoke: On' : 'Karaoke: Off';
    button.setAttribute('aria-pressed', String(enabled));
    modeButton.hidden = !enabled;
    highlightButton.hidden = !enabled;
    refresh(state.tracks.find(track => track.id === state.currentId));
    sync();
  };
  modeButton.onclick = () => {
    mode = mode === 'current' ? 'scrolling' : 'current';
    localStorage.setItem('nightwave-karaoke-mode', mode);
    updateMode();
    sync();
  };
  highlightButton.onclick = () => {
    highlighting = !highlighting;
    localStorage.setItem('nightwave-karaoke-highlight', String(highlighting));
    updateHighlight();
    sync();
  };
  motion.addEventListener('change', sync);
  for (const event of ['play', 'pause', 'seeked', 'seeking', 'timeupdate', 'ended']) audio.addEventListener(event, sync);
  new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  window.NightwaveKaraoke = { refresh, clear: () => refresh(null) };
})();
