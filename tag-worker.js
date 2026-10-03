const { parentPort, workerData } = require('node:worker_threads');
const NodeID3 = require('node-id3');
// node-id3 0.2.x defaults to a single APIC frame. Enable its existing multiple-
// frame support within this worker so back covers survive both kinds of edits.
require('node-id3/src/ID3Definitions').ID3_FRAME_OPTIONS.APIC.multiple = true;
const pictureFrame = require('node-id3/src/ID3Frames').APIC;
const createPictureFrame = pictureFrame.create;
pictureFrame.create = pictures => Array.isArray(pictures)
  ? Buffer.concat(pictures.map(picture => {
    const frame = createPictureFrame(picture);
    if (!(frame instanceof Buffer)) throw frame;
    return frame;
  })) : createPictureFrame(pictures);

try {
  // Worker messages clone Buffers into Uint8Arrays; node-id3 expects a Buffer.
  const options = {};
  if (workerData.tags.image?.imageBuffer) {
    workerData.tags.image.imageBuffer = Buffer.from(workerData.tags.image.imageBuffer);
    const pictures = NodeID3.read(workerData.filePath).raw?.APIC || [];
    const otherPictures = (Array.isArray(pictures) ? pictures : [pictures]).filter(picture => picture.type?.id !== 3);
    workerData.tags.image = [workerData.tags.image, ...otherPictures];
    // Replace front covers regardless of their description, preserving other images.
    options.exclude = ['APIC'];
  }
  const result = NodeID3.update(workerData.tags, workerData.filePath, options);
  if (result !== true) throw result instanceof Error ? result : new Error('Could not write tags to this file.');
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
