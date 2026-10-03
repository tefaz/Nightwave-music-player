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
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.frame = 0;
    this.lastDraw = 0;
    this.presets = [
      { id: 'tunnel', name: 'Space tunnel', render: 'drawTunnel' },
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
    this.presetIndex = (this.presetIndex + 1) % this.presets.length;
    localStorage.setItem('nightwave-visualizer', this.presets[this.presetIndex].id);
    this.updatePreset();
    this.draw();
  }

  async play() {
    this.updateIdle();
    if (this.panel.hidden) return;
    try { await this.analysis.ensureAnalysis(); }
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
    if (this.frame || this.panel.hidden || document.hidden || !this.width || !this.height) return;
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
      if (!this.motion.matches) {
        this.time += delta;
        this.travel += delta * (this.audio.paused ? 0.045 : 0.15 + this.bass * 0.22);
      }
      this.draw();
      this.lastDraw = time;
    }
    this.startDrawing();
  }

  readAudio() {
    const { analyser, bins, context } = this.analysis;
    const playing = analyser && !this.audio.paused && !this.audio.ended;
    let bass = 0, mid = 0, treble = 0;
    if (playing) {
      analyser.getByteFrequencyData(bins);
      if (!this.waveform) this.waveform = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(this.waveform);
      const band = (low, high) => {
        const first = Math.max(1, Math.floor(low * analyser.fftSize / context.sampleRate));
        const last = Math.min(bins.length, Math.ceil(high * analyser.fftSize / context.sampleRate));
        let total = 0;
        for (let index = first; index < last; index++) total += bins[index] / 255;
        return total / Math.max(1, last - first);
      };
      bass = band(35, 220); mid = band(220, 2000); treble = band(2000, 12000);
    }
    this.bass += (bass - this.bass) * 0.16;
    this.mid += (mid - this.mid) * 0.14;
    this.treble += (treble - this.treble) * 0.12;
    return playing;
  }

  draw() {
    if (this.panel.hidden || !this.width || !this.height) return;
    const playing = this.readAudio();
    // Each effect starts with the same canvas state and the same audio sample.
    this.paint.save();
    try { this[this.presets[this.presetIndex].render](playing); }
    finally { this.paint.restore(); }
  }

  drawTunnel(playing) {
    const { width, height } = this;
    if (this.panel.hidden || !width || !height) return;
    const ctx = this.paint;
    const time = this.time;
    const hue = (260 + time * 13) % 360;
    const centerX = width * (0.5 + Math.sin(time * 0.19) * 0.065);
    const centerY = height * (0.5 + Math.cos(time * 0.23) * 0.07);
    const scale = Math.max(width, height * 1.4);
    const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, scale * 0.65);
    glow.addColorStop(0, `hsl(${hue + 45}, 65%, 12%)`);
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
      const rotation = time * 0.1 + (1 - depth) * 2.1;
      const ripple = Math.sin(angle * 5 + time * 0.75 + depth * 8) * 0.045
        + Math.cos(angle * 9 - time * 0.55 + depth * 5) * 0.025;
      const wave = playing && this.waveform ? (this.waveform[Math.floor((angle / (Math.PI * 2) % 1 + 1) % 1 * this.waveform.length)] - 128) / 128 : 0;
      const radius = scale * (0.008 + Math.pow(depth, 2.2) * 0.96)
        * (1 + ripple + wave * (0.012 + this.mid * 0.05) + this.bass * 0.07);
      const bend = (1 - depth) * Math.sin(depth * 6 + time * 0.34);
      const jitter = electric ? Math.sin(depth * 105 + time * 2.4 + angle * 6) * (0.025 + this.treble * 0.075) : 0;
      return {
        x: centerX + bend * width * 0.055 + Math.cos(angle + rotation + jitter) * radius,
        y: centerY + Math.cos(depth * 5 + time * 0.28) * (1 - depth) * height * 0.05 + Math.sin(angle + rotation + jitter) * radius * 0.68
      };
    };
    ctx.globalCompositeOperation = 'lighter';
    for (const depth of rings) {
      const alpha = Math.min(0.75, depth * 0.7 + 0.05) * (0.9 + this.mid * 0.5);
      ctx.beginPath();
      for (let step = 0; step <= 96; step++) {
        const p = point(depth, step / 96 * Math.PI * 2);
        if (step) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.strokeStyle = `hsla(${hue + depth * 120}, 95%, 62%, ${alpha})`;
      ctx.lineWidth = 1 + depth * 1.4 + this.bass * 0.7;
      ctx.shadowColor = `hsl(${hue + depth * 120}, 100%, 55%)`;
      ctx.shadowBlur = 7;
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
      ctx.shadowBlur = bright ? 16 : 5;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    for (const star of this.stars) {
      const depth = (star.depth + this.travel * star.speed) % 1;
      const head = point(depth, star.angle);
      const tail = point(Math.max(0, depth - (0.006 + depth * 0.026)), star.angle);
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
    const hue = 135 + Math.sin(time * 0.08) * 35;
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#030410');sky.addColorStop(0.55, '#071225');sky.addColorStop(1, '#02040d');
    ctx.fillStyle = sky;ctx.fillRect(0, 0, width, height);
    const halo = ctx.createRadialGradient(width * 0.55, height * 0.45, 0, width * 0.55, height * 0.45, width * 0.65);
    halo.addColorStop(0, `hsla(${hue}, 85%, 30%, 0.15)`);halo.addColorStop(1, 'rgba(0,0,0,0)');
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
          + Math.sin(phase * (0.7 + ribbon * 0.07) + time * 0.23 + ribbon * 0.9) * height * (0.055 + this.bass * 0.12)
          + Math.cos(phase * 1.75 - time * 0.16 + ribbon * 0.7) * height * (0.025 + this.mid * 0.025);
      };
      const curtain = x => height * (0.13 + this.mid * 0.2 + Math.sin(x / width * 8 + time * 0.2 + ribbon) * 0.027);
      const fill = ctx.createLinearGradient(0, height * (0.08 + ribbon * 0.087), 0, height * (0.54 + ribbon * 0.087));
      fill.addColorStop(0, `hsla(${colour}, 95%, 55%, 0.04)`);
      fill.addColorStop(0.45, `hsla(${colour}, 95%, 56%, ${0.14 + this.mid * 0.16})`);
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
        light.addColorStop(0, `hsla(${colour}, 95%, 65%, ${0.12 + this.mid * 0.14})`);
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
      ctx.lineWidth = 1.2 + this.mid * 2;
      ctx.shadowColor = `hsl(${colour}, 100%, 58%)`;ctx.shadowBlur = 13;
      ctx.stroke();ctx.shadowBlur = 0;
    }
    ctx.globalCompositeOperation = 'source-over';
    const fade = ctx.createLinearGradient(0, height * 0.7, 0, height);
    fade.addColorStop(0, 'rgba(0,0,0,0)');fade.addColorStop(1, 'rgba(0,0,8,0.7)');
    ctx.fillStyle = fade;ctx.fillRect(0, 0, width, height);
  }

  drawKaleidoscope() {
    const ctx = this.paint, { width, height, time } = this;
    const hue = (220 + time * 9) % 360;
    const radius = Math.min(width, height) * 0.46 * (1 + this.bass * 0.12);
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
      const rotation = time * (layer % 2 ? -0.045 : 0.065) + layer * 0.21;
      for (let sector = 0; sector < sectors; sector++) {
        const angle = sector * sectorAngle + rotation;
        const colour = hue + layer * 32 + sector % 2 * 16;
        const vertices = [
          point(angle, distance * (0.32 + this.mid * 0.12)),
          point(angle - sectorAngle * 0.44, distance * 0.78),
          point(angle, distance),
          point(angle + sectorAngle * 0.44, distance * 0.78)
        ];
        const glass = ctx.createRadialGradient(0, 0, 0, 0, 0, distance);
        glass.addColorStop(0, `hsla(${colour + 45}, 95%, 60%, 0.18)`);
        glass.addColorStop(1, `hsla(${colour}, 95%, 55%, ${0.07 + this.mid * 0.08})`);
        ctx.beginPath();vertices.forEach((vertex, index) => index ? ctx.lineTo(vertex.x, vertex.y) : ctx.moveTo(vertex.x, vertex.y));ctx.closePath();
        ctx.fillStyle = glass;ctx.fill();
        ctx.strokeStyle = `hsla(${colour}, 100%, 72%, ${0.48 + this.mid * 0.2})`;
        ctx.lineWidth = 0.8 + (1 - layer / 7) * 0.9;
        ctx.shadowColor = `hsl(${colour}, 100%, 60%)`;ctx.shadowBlur = 9;
        ctx.stroke();
      }
    }
    // Dotted orbits and bright satellites provide another layer of symmetry.
    ctx.shadowBlur = 0;
    ctx.setLineDash([2, 9]);ctx.lineWidth = 1;
    ctx.strokeStyle = `hsla(${hue + 90}, 95%, 76%, 0.4)`;
    ctx.beginPath();ctx.arc(0, 0, radius * 1.09, 0, Math.PI * 2);ctx.stroke();ctx.setLineDash([]);
    for (let sector = 0; sector < sectors; sector++) {
      const angle = sector * sectorAngle - time * 0.08;
      const orbit = point(angle, radius * 1.09);
      ctx.fillStyle = `hsla(${hue + 90}, 100%, 85%, 0.8)`;
      ctx.beginPath();ctx.arc(orbit.x, orbit.y, 1.7 + this.treble * 3, 0, Math.PI * 2);ctx.fill();
    }
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.16);
    core.addColorStop(0, 'rgba(230,244,255,0.8)');core.addColorStop(0.2, `hsla(${hue}, 100%, 80%, 0.5)`);core.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    ctx.fillStyle = core;ctx.beginPath();ctx.arc(0, 0, radius * 0.16, 0, Math.PI * 2);ctx.fill();
  }

  dispose() {
    this.stopDrawing();
    this.resizeObserver.disconnect();
    this.visibilityObserver.disconnect();
  }
}

const musicVisualizer = new MusicVisualizer(document.querySelector('#audio'), document.querySelector('#tunnel-visualizer'), sidebarVisualizer);
