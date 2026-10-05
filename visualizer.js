class SidebarVisualizer {
  constructor(audio, panel) {
    this.audio = audio;
    this.panel = panel;
    this.canvas = panel.querySelector('canvas');
    this.paint = this.canvas.getContext('2d');
    this.levels = new Float32Array(32);
    this.peaks = new Float32Array(32);
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.frame = 0;
    this.lastDraw = 0;
    this.failed = false;
    audio.addEventListener('play', () => this.play());
    for (const event of ['pause', 'ended', 'emptied', 'error']) audio.addEventListener(event, () => this.rest());
    document.addEventListener('visibilitychange', () => document.hidden ? this.stopDrawing() : this.startDrawing());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.visibilityObserver = new MutationObserver(() => {
      if (this.panel.hidden) this.stopDrawing();
      else {
        this.resize();
        if (!this.audio.paused && !this.audio.ended) this.play();
      }
    });
    this.visibilityObserver.observe(this.panel, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('beforeunload', () => this.dispose(), { once: true });
    this.resize();
  }

  async play() {
    if (this.failed || this.panel.hidden) return;
    try {
      await this.ensureAnalysis();
      if (this.audio.paused || this.audio.ended || this.panel.hidden) return;
      this.panel.classList.add('is-playing');
      this.startDrawing();
    } catch {
      this.failed = true;
      this.rest();
    }
  }

  async ensureAnalysis() {
    // All visualizers use this one source node. Creating another source for
    // the same audio element would fail and interrupt view switching.
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.76;
      this.analyser.minDecibels = -85;
      this.analyser.maxDecibels = -20;
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      this.source = this.context.createMediaElementSource(this.audio);
      this.source.connect(this.context.destination);
      this.source.connect(this.analyser);
    }
    await this.context.resume();
  }

  resize() {
    if (this.panel.hidden) { this.stopDrawing(); return; }
    const { width, height } = this.canvas.getBoundingClientRect();
    this.width = width;
    this.height = height;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    this.paint.setTransform(scale, 0, 0, scale, 0, 0);
    this.draw();
    this.startDrawing();
  }

  startDrawing() {
    if (this.frame || this.panel.hidden || this.audio.paused || this.audio.ended || !this.analyser || document.hidden || !this.width) return;
    this.frame = requestAnimationFrame(time => this.animate(time));
  }

  stopDrawing() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  animate(time) {
    this.frame = 0;
    if (this.panel.hidden || this.audio.paused || this.audio.ended || document.hidden || !this.width) return;
    // Limit work to 30 fps (10 with reduced motion), with no flashing or pulses.
    if (time - this.lastDraw >= (this.motion.matches ? 100 : 1000 / 30)) {
      this.draw();
      this.lastDraw = time;
    }
    this.startDrawing();
  }

  draw() {
    const ctx = this.paint, width = this.width, height = this.height;
    if (this.panel.hidden || !width || !height) return;
    const playing = this.analyser && !this.audio.paused && !this.audio.ended;
    if (playing) this.analyser.getByteFrequencyData(this.bins);
    ctx.clearRect(0, 0, width, height);
    const count = this.levels.length, gap = 3, barWidth = (width - gap * (count - 1)) / count;
    // A repeating warm colour wave gives both edges the same palette, instead
    // of pinning one end of a diagonal gradient to the entire treble section.
    const colourPhase = this.motion.matches ? 0 : (this.audio.currentTime || 0) / 12;
    const maxFrequency = Math.min(16000, this.context ? this.context.sampleRate * 0.45 : 16000);
    const baseline = height;
    for (let index = 0; index < count; index++) {
      let magnitude = 0;
      if (playing) {
        const low = 35 * (maxFrequency / 35) ** (index / count);
        const high = 35 * (maxFrequency / 35) ** ((index + 1) / count);
        const binWidth = this.context.sampleRate / this.analyser.fftSize;
        const first = Math.max(1, Math.floor(low / binWidth));
        const last = Math.min(this.bins.length - 1, Math.max(first, Math.ceil(high / binWidth)));
        for (let bin = first; bin <= last; bin++) magnitude = Math.max(magnitude, this.bins[bin] / 255);
      }
      this.levels[index] = playing ? Math.max(magnitude, this.levels[index] * 0.86) : 0;
      this.peaks[index] = playing ? Math.max(this.levels[index], this.peaks[index] - 0.025) : 0;
      const barHeight = Math.max(3, this.levels[index] * (height - 16));
      const x = index * (barWidth + gap);
      const warmth = (1 + Math.sin(index / count * Math.PI * 2 + colourPhase)) / 2;
      const hue = 8 + warmth * 42;
      const gradient = ctx.createLinearGradient(0, baseline, 0, baseline - barHeight);
      gradient.addColorStop(0, `hsl(${hue}, 95%, 50%)`);
      gradient.addColorStop(1, `hsl(${Math.min(56, hue + 7)}, 100%, 62%)`);
      ctx.globalAlpha = playing ? 0.95 : 0.3;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(x, baseline - barHeight, barWidth, barHeight, Math.min(2, barWidth / 2));
      ctx.fill();
      if (playing && this.peaks[index] > 0.05 && !this.motion.matches) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#ffe9bc';
        ctx.fillRect(x, baseline - this.peaks[index] * (height - 16) - 4, barWidth, 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  rest() {
    this.stopDrawing();
    this.levels.fill(0);
    this.peaks.fill(0);
    this.panel.classList.remove('is-playing');
    this.draw();
  }

  dispose() {
    this.stopDrawing();
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.context?.close().catch(() => {});
  }
}

const sidebarVisualizer = new SidebarVisualizer(document.querySelector('#audio'), document.querySelector('#sidebar-visualizer'));

class MusicVisualizer {
  constructor(audio, panel, analysis) {
    this.audio = audio;
    this.panel = panel;
    this.analysis = analysis;
    this.canvas = panel.querySelector('canvas');
    this.paint = this.canvas.getContext('2d', { alpha: false });
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.time = 0;
    this.travel = 0;
    this.resetAudio();
    this.frame = 0;
    this.lastDraw = 0;
    this.presets = [
      { id: 'tunnel', name: 'Space tunnel', render: 'drawTunnel' },
      { id: 'midnight', name: 'Midnight', render: 'drawMidnight', static: true },
      { id: 'karaoke', name: 'Karaoke lounge', render: 'drawKaraoke', static: true },
      { id: 'aurora', name: 'Aurora', render: 'drawAurora' },
      { id: 'kaleidoscope', name: 'Kaleidoscope', render: 'drawKaleidoscope' }
    ];
    const savedPreset = localStorage.getItem('nightwave-visualizer');
    this.presetIndex = Math.max(0, this.presets.findIndex(preset => preset.id === savedPreset));
    document.querySelector('#visualizer-next').addEventListener('click', () => this.nextPreset());
    this.updatePreset();
    // Stable particles avoid sparkling noise or random changes on every frame.
    this.stars = Array.from({ length: 135 }, (_, index) => ({
      angle: index * 2.399963,
      depth: ((index * 0.618034) % 1),
      speed: 0.75 + ((index * 0.317) % 1) * 0.5
    }));
    audio.addEventListener('play', () => this.play());
    for (const event of ['pause', 'ended', 'emptied', 'error']) audio.addEventListener(event, () => this.updateIdle());
    for (const event of ['emptied', 'seeking', 'ended', 'error']) audio.addEventListener(event, () => this.resetAudio());
    document.addEventListener('visibilitychange', () => document.hidden ? this.stopDrawing() : this.startDrawing());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.visibilityObserver = new MutationObserver(() => {
      if (panel.hidden) this.stopDrawing();
      else { this.resize(); if (!audio.paused && !audio.ended) this.play(); }
    });
    this.visibilityObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('beforeunload', () => this.dispose(), { once: true });
    this.updateIdle();
    this.resize();
  }

  updateIdle() {
    document.querySelector('#tunnel-idle').hidden = !this.audio.paused && !this.audio.ended;
  }

  updatePreset() {
    const preset = this.presets[this.presetIndex];
    const next = this.presets[(this.presetIndex + 1) % this.presets.length];
    document.querySelector('#visualizer-name').textContent = preset.name;
    this.panel.setAttribute('aria-label', `${preset.name} music visualizer`);
    const button = document.querySelector('#visualizer-next');
    button.title = `Next visualizer: ${next.name}`;
    button.setAttribute('aria-label', button.title);
  }

  nextPreset() {
    this.setPreset(this.presets[(this.presetIndex + 1) % this.presets.length].id);
  }

  setPreset(id) {
    const index = this.presets.findIndex(preset => preset.id === id);
    if (index < 0) return;
    this.stopDrawing();
    this.presetIndex = index;
    localStorage.setItem('nightwave-visualizer', this.presets[this.presetIndex].id);
    this.updatePreset();
    this.draw();
    this.startDrawing();
  }

  async play() {
    this.updateIdle();
    if (this.panel.hidden) return;
    try {
      await this.analysis.ensureAnalysis();
      if (!this.analyser) {
        // A faster analysis branch preserves the sidebar's smooth spectrum,
        // while sharing its source and leaving the audible signal untouched.
        this.analyser = this.analysis.context.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.15;
        this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
        this.previousSpectrum = new Float32Array(this.spectrum.length);
        this.waveform = new Uint8Array(this.analyser.fftSize);
        this.analysis.source.connect(this.analyser);
      }
    }
    catch { /* The visuals can still animate when audio analysis is unavailable. */ }
    this.startDrawing();
  }

  resize() {
    if (this.panel.hidden) { this.stopDrawing(); return; }
    const { width, height } = this.canvas.getBoundingClientRect();
    this.width = width;
    this.height = height;
    // Bound the backing buffer on large displays; this effect does not need
    // the full native resolution of a high DPI screen.
    const scale = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2200000 / Math.max(1, width * height)));
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    this.paint.setTransform(scale, 0, 0, scale, 0, 0);
    this.draw();
    this.startDrawing();
  }

  startDrawing() {
    if (this.frame || this.presets[this.presetIndex].static || this.panel.hidden || document.hidden || !this.width || !this.height) return;
    this.frame = requestAnimationFrame(time => this.animate(time));
  }

  stopDrawing() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastDraw = 0;
  }

  animate(time) {
    this.frame = 0;
    if (this.panel.hidden || document.hidden || !this.width || !this.height) return;
    const interval = this.motion.matches ? 100 : 1000 / 30;
    if (time - this.lastDraw >= interval) {
      const delta = this.lastDraw ? Math.min(0.1, (time - this.lastDraw) / 1000) : 1 / 30;
      this.draw(delta);
      this.lastDraw = time;
    }
    this.startDrawing();
  }

  resetAudio() {
    this.bass = this.mid = this.treble = this.beat = 0;
    this.beatAge = 1;
    this.fluxAverage = this.energyAverage = 0;
    this.bandPeaks = [0.015, 0.015, 0.015];
    this.previousSpectrum?.fill(0);
    this.waveform?.fill(128);
    this.pulseTime = 0;
  }

  readAudio(delta = 1 / 30) {
    const { analyser } = this;
    const { context } = this.analysis;
    const playing = analyser && !this.audio.paused && !this.audio.ended;
    const levels = [0, 0, 0];
    this.beatAge += delta;
    this.beat *= Math.exp(-delta / 0.22);
    if (playing) {
      analyser.getFloatFrequencyData(this.spectrum);
      analyser.getByteTimeDomainData(this.waveform);
      // Linear amplitudes retain the contrast between a drum attack and its
      // tail; byte decibel averages tend to flatten loud, mastered songs.
      for (let index = 0; index < this.spectrum.length; index++) {
        this.spectrum[index] = Math.pow(10, this.spectrum[index] / 20);
      }
      const band = (low, high) => {
        const first = Math.max(1, Math.floor(low * analyser.fftSize / context.sampleRate));
        const last = Math.min(this.spectrum.length, Math.ceil(high * analyser.fftSize / context.sampleRate));
        let energy = 0, flux = 0;
        for (let index = first; index < last; index++) {
          const amplitude = this.spectrum[index];
          energy += amplitude * amplitude;
          flux += Math.max(0, amplitude - this.previousSpectrum[index]) ** 2;
        }
        const count = Math.max(1, last - first);
        return { energy: Math.sqrt(energy / count), flux: Math.sqrt(flux / count) };
      };
      const bands = [band(35, 220), band(220, 2000), band(2000, 12000)];
      const energy = bands[0].energy * 0.65 + bands[1].energy * 0.25 + bands[2].energy * 0.1;
      const flux = bands[0].flux * 0.65 + bands[1].flux * 0.25 + bands[2].flux * 0.1;
      // Adapt to each song, and detect rising spectral energy rather than
      // generating pulses on a timer or repeatedly triggering on held bass.
      if (energy > 0.003 && flux > Math.max(0.0015, this.fluxAverage * 1.8)
        && this.beatAge >= 0.18) {
        this.beat = Math.min(1, 0.45 + flux / Math.max(0.004, this.energyAverage) * 1.3);
        this.beatAge = 0;
      }
      const history = 1 - Math.exp(-delta / 0.8);
      this.fluxAverage += (flux - this.fluxAverage) * history;
      this.energyAverage += (energy - this.energyAverage) * history;
      bands.forEach((band, index) => {
        this.bandPeaks[index] = Math.max(0.015, band.energy, this.bandPeaks[index] * Math.exp(-delta / 1.2));
        levels[index] = Math.min(1, band.energy / this.bandPeaks[index]) ** 0.7;
      });
      this.previousSpectrum.set(this.spectrum);
    } else {
      this.previousSpectrum?.fill(0);
      this.waveform?.fill(128);
    }
    ['bass', 'mid', 'treble'].forEach((name, index) => {
      const smoothing = this.motion.matches ? 0.3 : (levels[index] > this[name] ? 0.035 : 0.18);
      const response = 1 - Math.exp(-delta / smoothing);
      this[name] += (levels[index] - this[name]) * response;
    });
    return playing;
  }

  draw(delta = 1 / 30) {
    if (this.panel.hidden || !this.width || !this.height) return;
    if (this.presets[this.presetIndex].static) {
      this.paint.save();
      try { this[this.presets[this.presetIndex].render](); }
      finally { this.paint.restore(); }
      return;
    }
    const playing = this.readAudio(delta);
    if (!this.motion.matches) {
      this.time += delta;
      this.travel += delta * (playing ? 0.15 + this.bass * 0.32 + this.beat * 0.85 : 0.045);
      this.pulseTime += delta * (this.mid * 0.25 + this.beat * 1.8);
    }
    // Each effect starts with the same canvas state and the same audio sample.
    this.paint.save();
    try { this[this.presets[this.presetIndex].render](playing); }
    finally { this.paint.restore(); }
  }

  drawMidnight() {
    const { width, height, paint: ctx } = this;
    // A fixed night landscape keeps brightness steady and the lyric area dark.
    const sky = ctx.createLinearGradient(0, 0, width * 0.45, height);
    sky.addColorStop(0, '#121b30');
    sky.addColorStop(0.55, '#182132');
    sky.addColorStop(1, '#090d18');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    const glow = ctx.createRadialGradient(width * 0.24, height * 0.28, 0, width * 0.24, height * 0.28, height * 0.6);
    glow.addColorStop(0, 'rgba(121,154,178,0.12)');
    glow.addColorStop(1, 'rgba(121,154,178,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'rgba(192,206,224,0.32)';
    for (let index = 0; index < 42; index++) {
      const x = ((index * 0.618034 + 0.13) % 1) * width;
      const y = ((index * 0.317 + 0.07) % 1) * height * 0.55;
      ctx.beginPath();ctx.arc(x, y, index % 3 === 0 ? 1 : 0.6, 0, Math.PI * 2);ctx.fill();
    }
    ctx.fillStyle = '#8292a5';
    ctx.beginPath();ctx.arc(width * 0.24, height * 0.28, Math.min(width, height) * 0.028, 0, Math.PI * 2);ctx.fill();

    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath();ctx.moveTo(0, height);
      for (let step = 0; step <= 60; step++) {
        const x = step / 60;
        const ridge = Math.sin(x * 9 + layer * 1.7) * 0.045 + Math.sin(x * 21 + layer) * 0.018;
        ctx.lineTo(x * width, height * (0.66 + layer * 0.105 + ridge));
      }
      ctx.lineTo(width, height);ctx.closePath();
      ctx.fillStyle = ['#111a29', '#0b1220', '#070d17'][layer];ctx.fill();
    }
  }

  drawKaraoke() {
    const { width, height, paint: ctx } = this;
    // A still, softly lit stage leaves the lyrics clear and brightness steady.
    const backdrop = ctx.createLinearGradient(0, 0, 0, height);
    backdrop.addColorStop(0, '#201720');
    backdrop.addColorStop(0.5, '#151018');
    backdrop.addColorStop(1, '#08090e');
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);

    for (const side of [0, 1]) {
      const x = width * (side ? 0.86 : 0.14);
      const glow = ctx.createRadialGradient(x, height * 0.08, 0, x, height * 0.08, height * 0.72);
      glow.addColorStop(0, 'rgba(241,188,122,0.13)');
      glow.addColorStop(0.45, 'rgba(200,136,99,0.035)');
      glow.addColorStop(1, 'rgba(200,136,99,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      const beam = ctx.createLinearGradient(0, height * 0.07, 0, height * 0.68);
      beam.addColorStop(0, 'rgba(250,211,152,0.08)');
      beam.addColorStop(1, 'rgba(250,211,152,0)');
      ctx.fillStyle = beam;
      ctx.beginPath();ctx.moveTo(x, height * 0.07);
      ctx.lineTo(width * (side ? 0.46 : 0.2), height * 0.68);
      ctx.lineTo(width * (side ? 0.8 : 0.54), height * 0.68);
      ctx.closePath();ctx.fill();

      // Low-contrast folds frame the stage without filling the lyric area.
      for (let fold = 0; fold < 7; fold++) {
        const foldWidth = width * 0.018;
        const left = side ? width - (fold + 1) * foldWidth : fold * foldWidth;
        const curtain = ctx.createLinearGradient(left, 0, left + foldWidth, 0);
        curtain.addColorStop(0, '#151016');
        curtain.addColorStop(0.5, '#281b24');
        curtain.addColorStop(1, '#181219');
        ctx.fillStyle = curtain;
        ctx.fillRect(left, 0, foldWidth, height);
      }
    }

    const floor = ctx.createRadialGradient(width * 0.5, height * 0.96, 0, width * 0.5, height * 0.96, width * 0.48);
    floor.addColorStop(0, 'rgba(192,143,94,0.07)');
    floor.addColorStop(1, 'rgba(192,143,94,0)');
    ctx.fillStyle = floor;
    ctx.beginPath();ctx.ellipse(width * 0.5, height * 0.96, width * 0.46, height * 0.09, 0, 0, Math.PI * 2);ctx.fill();

    // An understated microphone sits above and to the side of the lyrics.
    const scale = Math.min(width, height), x = width * 0.25, y = height * 0.36;
    ctx.strokeStyle = '#756054';ctx.fillStyle = '#30292b';
    ctx.lineWidth = Math.max(1, scale * 0.002);ctx.lineCap = 'round';
    ctx.beginPath();ctx.moveTo(x, y + scale * 0.054);ctx.lineTo(x, height * 0.63);
    ctx.moveTo(x - scale * 0.035, height * 0.65);ctx.lineTo(x, height * 0.63);ctx.lineTo(x + scale * 0.035, height * 0.65);ctx.stroke();
    ctx.beginPath();ctx.roundRect(x - scale * 0.014, y, scale * 0.028, scale * 0.054, scale * 0.014);ctx.fill();ctx.stroke();
    ctx.strokeStyle = '#8c7260';
    for (let line = 0; line < 4; line++) {
      const top = y + scale * (0.012 + line * 0.008);
      ctx.beginPath();ctx.moveTo(x - scale * 0.008, top);ctx.lineTo(x + scale * 0.008, top);ctx.stroke();
    }
  }

  drawTunnel(playing) {
    const { width, height } = this;
    if (this.panel.hidden || !width || !height) return;
    const ctx = this.paint;
    const time = this.time;
    const pulse = this.motion.matches ? 0 : this.beat;
    const hue = (260 + time * 13) % 360;
    const centerX = width * (0.5 + Math.sin(time * 0.19) * 0.065);
    const centerY = height * (0.5 + Math.cos(time * 0.23) * 0.07);
    const scale = Math.max(width, height * 1.4);
    const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, scale * 0.65);
    glow.addColorStop(0, `hsl(${hue + 45}, 65%, ${12 + pulse * 8}%)`);
    glow.addColorStop(0.2, `hsl(${hue}, 70%, 6%)`);
    glow.addColorStop(1, '#020109');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Perspective rings travel from the vanishing point towards the viewer.
    // Their twist, corrugations and audio waveform make a living tunnel wall.
    const rings = Array.from({ length: 34 }, (_, index) => (index / 34 + this.travel) % 1).sort((a, b) => a - b);
    const point = (depth, angle, electric = false) => {
      const rotation = time * 0.1 + this.pulseTime * 0.12 + (1 - depth) * 2.1;
      const ripple = Math.sin(angle * 5 + time * 0.75 + depth * 8) * 0.045
        + Math.cos(angle * 9 - time * 0.55 + depth * 5) * 0.025;
      const wave = playing && this.waveform ? (this.waveform[Math.floor((angle / (Math.PI * 2) % 1 + 1) % 1 * this.waveform.length)] - 128) / 128 : 0;
      const radius = scale * (0.008 + Math.pow(depth, 2.2) * 0.96)
        * (1 + ripple + wave * (0.018 + this.mid * 0.09) + this.bass * 0.14 + pulse * 0.2);
      const bend = (1 - depth) * Math.sin(depth * 6 + time * 0.34);
      const jitter = electric ? Math.sin(depth * 105 + time * 2.4 + angle * 6) * (0.025 + this.treble * 0.075) : 0;
      return {
        x: centerX + bend * width * 0.055 + Math.cos(angle + rotation + jitter) * radius,
        y: centerY + Math.cos(depth * 5 + time * 0.28) * (1 - depth) * height * 0.05 + Math.sin(angle + rotation + jitter) * radius * 0.68
      };
    };
    ctx.globalCompositeOperation = 'lighter';
    for (const depth of rings) {
      const alpha = Math.min(1, Math.min(0.75, depth * 0.7 + 0.05) * (0.9 + this.mid * 0.5 + pulse * 0.5));
      ctx.beginPath();
      for (let step = 0; step <= 96; step++) {
        const p = point(depth, step / 96 * Math.PI * 2);
        if (step) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${hue + depth * 120}, 95%, 62%, ${alpha})`;
      ctx.lineWidth = 1 + depth * 1.4 + this.bass * 1.1 + pulse * 1.5;
      ctx.shadowColor = `hsl(${hue + depth * 120}, 100%, 55%)`;
      ctx.shadowBlur = 7 + pulse * 9;
      ctx.stroke();
    }

    // Glowing seams and bright electric filaments run along the tunnel walls.
    for (let strand = 0; strand < 14; strand++) {
      const angle = strand / 14 * Math.PI * 2;
      const colour = hue + strand / 14 * 190 + 65;
      ctx.beginPath();
      for (let step = 0; step <= 64; step++) {
        const p = point(step / 64, angle, true);
        if (step) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }
      const bright = strand % 3 === 0;
      ctx.strokeStyle = `hsla(${colour}, 100%, ${bright ? 80 : 58}%, ${bright ? 0.7 + this.mid * 0.25 : 0.22})`;
      ctx.lineWidth = bright ? 1.7 + this.treble * 1.8 : 0.7;
      ctx.shadowColor = `hsl(${colour}, 100%, 60%)`;
      ctx.shadowBlur = bright ? 16 + pulse * 12 : 5;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    for (const star of this.stars) {
      const depth = (star.depth + this.travel * star.speed) % 1;
      const head = point(depth, star.angle);
      const tail = point(Math.max(0, depth - (0.006 + depth * (0.026 + pulse * 0.055))), star.angle);
      ctx.strokeStyle = `hsla(${hue + star.angle * 20}, 85%, 82%, ${depth * 0.6})`;
      ctx.lineWidth = 0.5 + depth * 1.5;
      ctx.beginPath();ctx.moveTo(tail.x, tail.y);ctx.lineTo(head.x, head.y);ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.2, width / 2, height / 2, scale * 0.6);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,8,0.8)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  drawStars(hue) {
    const ctx = this.paint;
    ctx.shadowBlur = 0;
    for (const star of this.stars) {
      const x = star.depth * this.width;
      const y = ((Math.sin(star.angle * 3.17) + 1) / 2) * this.height;
      const shimmer = 0.25 + (Math.sin(this.time * 0.7 + star.angle) + 1) * 0.12 + this.treble * 0.2;
      ctx.fillStyle = `hsla(${hue + star.speed * 35}, 65%, 85%, ${shimmer})`;
      ctx.beginPath();ctx.arc(x, y, 0.5 + star.speed * 0.35, 0, Math.PI * 2);ctx.fill();
    }
  }

  drawAurora() {
    const ctx = this.paint, { width, height, time } = this;
    const pulse = this.motion.matches ? 0 : this.beat;
    const hue = 135 + Math.sin(time * 0.08) * 35;
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#030410');sky.addColorStop(0.55, '#071225');sky.addColorStop(1, '#02040d');
    ctx.fillStyle = sky;ctx.fillRect(0, 0, width, height);
    const halo = ctx.createRadialGradient(width * 0.55, height * 0.45, 0, width * 0.55, height * 0.45, width * 0.65);
    halo.addColorStop(0, `hsla(${hue}, 85%, 30%, ${0.15 + pulse * 0.12})`);halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;ctx.fillRect(0, 0, width, height);
    this.drawStars(205);
    ctx.globalCompositeOperation = 'lighter';

    // Translucent curtains drift across the sky; the music stretches their
    // folds and brightens the ridges rather than moving the whole camera.
    for (let ribbon = 0; ribbon < 5; ribbon++) {
      const colour = hue + ribbon * 29;
      const edge = x => {
        const phase = x / width * Math.PI * 2;
        return height * (0.25 + ribbon * 0.087)
          + Math.sin(phase * (0.7 + ribbon * 0.07) + time * 0.23 + this.pulseTime * 0.35 + ribbon * 0.9) * height * (0.055 + this.bass * 0.15 + pulse * 0.065)
          + Math.cos(phase * 1.75 - time * 0.16 + ribbon * 0.7) * height * (0.025 + this.mid * 0.045)
          + Math.sin(phase * 4 + ribbon + this.pulseTime) * height * pulse * 0.025;
      };
      const curtain = x => height * (0.13 + this.mid * 0.2 + pulse * 0.12 + Math.sin(x / width * 8 + time * 0.2 + ribbon) * 0.027);
      const fill = ctx.createLinearGradient(0, height * (0.08 + ribbon * 0.087), 0, height * (0.54 + ribbon * 0.087));
      fill.addColorStop(0, `hsla(${colour}, 95%, 55%, 0.04)`);
      fill.addColorStop(0.45, `hsla(${colour}, 95%, 56%, ${0.14 + this.mid * 0.16 + pulse * 0.12})`);
      fill.addColorStop(1, `hsla(${colour + 25}, 95%, 40%, 0)`);
      ctx.beginPath();
      for (let step = 0; step <= 90; step++) {
        const x = width * (step / 90 * 1.1 - 0.05);
        if (step) ctx.lineTo(x, edge(x)); else ctx.moveTo(x, edge(x));
      }
      for (let step = 90; step >= 0; step--) {
        const x = width * (step / 90 * 1.1 - 0.05);
        ctx.lineTo(x, edge(x) + curtain(x));
      }
      ctx.closePath();ctx.fillStyle = fill;ctx.fill();

      // Fine vertical folds soften the ribbons into an aurora instead of
      // drawing a set of flat waves. Their positions stay stable between frames.
      ctx.shadowBlur = 0;
      for (let fold = 0; fold < 64; fold++) {
        const x = width * (fold / 64 * 1.1 - 0.05), y = edge(x), length = curtain(x);
        const light = ctx.createLinearGradient(x, y, x, y + length);
        light.addColorStop(0, `hsla(${colour}, 95%, 65%, ${0.12 + this.mid * 0.14 + pulse * 0.14})`);
        light.addColorStop(0.35, `hsla(${colour + 15}, 95%, 55%, 0.07)`);
        light.addColorStop(1, `hsla(${colour + 30}, 95%, 45%, 0)`);
        ctx.fillStyle = light;ctx.fillRect(x, y, width / 64 * 0.85, length);
      }
      ctx.beginPath();
      for (let step = 0; step <= 90; step++) {
        const x = width * (step / 90 * 1.1 - 0.05);
        if (step) ctx.lineTo(x, edge(x)); else ctx.moveTo(x, edge(x));
      }
      ctx.strokeStyle = `hsla(${colour}, 100%, 74%, ${0.6 + this.mid * 0.25})`;
      ctx.lineWidth = 1.2 + this.mid * 2 + pulse * 2;
      ctx.shadowColor = `hsl(${colour}, 100%, 58%)`;ctx.shadowBlur = 13 + pulse * 14;
      ctx.stroke();ctx.shadowBlur = 0;
    }
    ctx.globalCompositeOperation = 'source-over';
    const fade = ctx.createLinearGradient(0, height * 0.7, 0, height);
    fade.addColorStop(0, 'rgba(0,0,0,0)');fade.addColorStop(1, 'rgba(0,0,8,0.7)');
    ctx.fillStyle = fade;ctx.fillRect(0, 0, width, height);
  }

  drawKaleidoscope() {
    const ctx = this.paint, { width, height, time } = this;
    const pulse = this.motion.matches ? 0 : this.beat;
    const hue = (220 + time * 9) % 360;
    const radius = Math.min(width, height) * 0.42 * (1 + this.bass * 0.18 + pulse * 0.22);
    const background = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.65);
    background.addColorStop(0, `hsl(${hue + 60}, 65%, 10%)`);background.addColorStop(1, '#03020d');
    ctx.fillStyle = background;ctx.fillRect(0, 0, width, height);
    this.drawStars(hue);
    ctx.translate(width / 2, height / 2);
    ctx.globalCompositeOperation = 'lighter';
    const sectors = 12, sectorAngle = Math.PI * 2 / sectors;
    const point = (angle, distance) => ({ x: Math.cos(angle) * distance, y: Math.sin(angle) * distance });

    // Counter-rotating layers of mirrored diamond facets form a stained-glass
    // mandala. Bass expands it and the middle frequencies open its petals.
    for (let layer = 0; layer < 7; layer++) {
      const distance = radius * Math.pow(0.77, layer);
      const rotation = time * (layer % 2 ? -0.045 : 0.065)
        + this.pulseTime * (layer % 2 ? -0.14 : 0.18) + layer * 0.21;
      for (let sector = 0; sector < sectors; sector++) {
        const angle = sector * sectorAngle + rotation;
        const colour = hue + layer * 32 + sector % 2 * 16;
        const vertices = [
          point(angle, distance * (0.32 + this.mid * 0.18 + pulse * 0.12)),
          point(angle - sectorAngle * 0.44, distance * 0.78),
          point(angle, distance),
          point(angle + sectorAngle * 0.44, distance * 0.78)
        ];
        const glass = ctx.createRadialGradient(0, 0, 0, 0, 0, distance);
        glass.addColorStop(0, `hsla(${colour + 45}, 95%, 60%, 0.18)`);
        glass.addColorStop(1, `hsla(${colour}, 95%, 55%, ${0.07 + this.mid * 0.08 + pulse * 0.1})`);
        ctx.beginPath();vertices.forEach((vertex, index) => index ? ctx.lineTo(vertex.x, vertex.y) : ctx.moveTo(vertex.x, vertex.y));ctx.closePath();
        ctx.fillStyle = glass;ctx.fill();
        ctx.strokeStyle = `hsla(${colour}, 100%, 72%, ${0.48 + this.mid * 0.2})`;
        ctx.lineWidth = 0.8 + (1 - layer / 7) * 0.9 + pulse * 1.2;
        ctx.shadowColor = `hsl(${colour}, 100%, 60%)`;ctx.shadowBlur = 9 + pulse * 11;
        ctx.stroke();
      }
    }
    // Dotted orbits and bright satellites provide another layer of symmetry.
    ctx.shadowBlur = 0;
    ctx.setLineDash([2, 9]);ctx.lineWidth = 1;
    ctx.strokeStyle = `hsla(${hue + 90}, 95%, 76%, 0.4)`;
    ctx.beginPath();ctx.arc(0, 0, radius * 1.09, 0, Math.PI * 2);ctx.stroke();ctx.setLineDash([]);
    for (let sector = 0; sector < sectors; sector++) {
      const angle = sector * sectorAngle - time * 0.08 - this.pulseTime * 0.2;
      const orbit = point(angle, radius * 1.09);
      ctx.fillStyle = `hsla(${hue + 90}, 100%, 85%, 0.8)`;
      ctx.beginPath();ctx.arc(orbit.x, orbit.y, 1.7 + this.treble * 3 + pulse * 2.5, 0, Math.PI * 2);ctx.fill();
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.16);
    core.addColorStop(0, 'rgba(230,244,255,0.8)');core.addColorStop(0.2, `hsla(${hue}, 100%, 80%, 0.5)`);core.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    ctx.fillStyle = core;ctx.beginPath();ctx.arc(0, 0, radius * 0.16, 0, Math.PI * 2);ctx.fill();
  }

  dispose() {
    this.stopDrawing();
    this.analyser?.disconnect();
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
  }
}

const musicVisualizer = new MusicVisualizer(document.querySelector('#audio'), document.querySelector('#tunnel-visualizer'), sidebarVisualizer);
