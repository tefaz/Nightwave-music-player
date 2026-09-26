(function (root) {
  'use strict';

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function transaction(db, store, mode, enqueue) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction was aborted.'));
      tx.onerror = () => {}; // An unhandled request error aborts the transaction.
      try {
        enqueue(tx.objectStore(store), value => { result = value; });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  function writeBatch(db, store, values = [], keys = [], clear = false) {
    return transaction(db, store, 'readwrite', objectStore => {
      if (clear) objectStore.clear();
      for (const value of values) objectStore.put(value);
      for (const key of keys) objectStore.delete(key);
    });
  }

  class PlaybackQueue {
    constructor(random = Math.random) {
      this.random = random;
      this.ids = [];
      this.order = [];
      this.index = -1;
      this.shuffle = false;
    }

    shuffled(ids) {
      const result = [...ids];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    }

    start(ids, current, shuffle = false) {
      this.ids = [...new Set(ids)];
      if (!this.ids.includes(current)) this.ids.unshift(current);
      this.shuffle = shuffle;
      this.order = shuffle ? [current, ...this.shuffled(this.ids.filter(id => id !== current))] : [...this.ids];
      this.index = this.order.indexOf(current);
    }

    setShuffle(enabled) {
      if (enabled === this.shuffle) return;
      const current = this.order[this.index];
      if (current !== undefined) this.start(this.ids, current, enabled);
      else this.shuffle = enabled;
    }

    prune(available) {
      const current = this.order[this.index];
      const before = this.order.slice(0, this.index).filter(id => available.has(id)).length;
      this.ids = this.ids.filter(id => available.has(id));
      this.order = this.order.filter(id => available.has(id));
      this.index = this.order.includes(current) ? this.order.indexOf(current) : before - 1;
    }

    move(back = false) {
      if (!this.order.length) return null;
      // Keep one shuffled order across wraps so Previous always retraces Next.
      this.index = (this.index + (back ? -1 : 1) + this.order.length) % this.order.length;
      return this.order[this.index];
    }

    clear() { this.ids = []; this.order = []; this.index = -1; }
  }

  class TrackClicks {
    constructor(fast = 300, slow = 900) {
      this.fast = fast;
      this.slow = slow;
      this.previous = null;
    }

    click(trackId, field, timestamp, modified = false) {
      const previous = this.previous;
      this.previous = modified ? null : { trackId, field, timestamp };
      if (modified || !previous || previous.trackId !== trackId) return null;
      const elapsed = timestamp - previous.timestamp;
      if (elapsed < 0 || elapsed > this.slow) return null;
      if (elapsed <= this.fast) { this.previous = null; return 'play'; }
      if (field && field === previous.field) { this.previous = null; return 'edit'; }
      return null;
    }

    reset() { this.previous = null; }
  }

  const api = { escapeHTML, transaction, writeBatch, PlaybackQueue, TrackClicks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NightwaveCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
