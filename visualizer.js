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
      // One source node follows this audio element across track changes. Keep the
      // audible path direct; the analyser only listens on a parallel connection.
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
      if (this.audio.paused || this.audio.ended) return;
      this.panel.classList.add('is-playing');
      this.startDrawing();
    } catch {
      this.failed = true;
      this.rest();
    }
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
