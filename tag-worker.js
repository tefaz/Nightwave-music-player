const { parentPort, workerData } = require('node:worker_threads');
const NodeID3 = require('node-id3');

try {
  const result = NodeID3.update(workerData.tags, workerData.filePath);
  if (result !== true) throw result instanceof Error ? result : new Error('Could not write tags to this file.');
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
