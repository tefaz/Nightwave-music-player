// Isolated headless desktop checks. The --no-sandbox flag belongs only to this test runner.
const { app, BrowserWindow, globalShortcut } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nightwave-electron-test-'));
app.setPath('userData', temporary);
app.disableHardwareAcceleration();
// Desktop checks must not take over the user's media keys.
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
const audioPath = path.join(temporary, 'silence.wav');
const wave = Buffer.alloc(44 + 16000);
wave.write('RIFF');wave.writeUInt32LE(wave.length - 8, 4);wave.write('WAVE', 8);
wave.write('fmt ', 12);wave.writeUInt32LE(16, 16);wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);wave.writeUInt32LE(8000, 24);wave.writeUInt32LE(16000, 28);
wave.writeUInt16LE(2, 32);wave.writeUInt16LE(16, 34);wave.write('data', 36);wave.writeUInt32LE(16000, 40);
fs.writeFileSync(audioPath, wave);
const tagPath = path.join(temporary, 'tags.mp3');fs.writeFileSync(tagPath, Buffer.alloc(100));
const fatalErrors = [];
let finished = false;
let primary;
const timeout = setTimeout(() => finish(new Error('Desktop checks timed out.')), 25000);

function finish(error) {
  if (finished) return;finished = true;clearTimeout(timeout);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  if (error) console.error(error);
  else console.log('PASS: isolated Electron checks (CSP, quotes, IPC, inline editing, tag writes, scanning, playback, click timing, IndexedDB rollback).');
  // Only remove this runner's validated mkdtemp directory.
  fs.rmSync(temporary, { recursive: true, force: true });
  app.exit(error ? 1 : 0);
}

app.on('browser-window-created', (_event, window) => {
  if(primary)return;primary=window;
  window.hide();
  window.webContents.on('console-message', event => {
    if (event.level === 'error' && /Content Security Policy|Uncaught|preload/i.test(event.message)) fatalErrors.push(event.message);
  });
  window.webContents.once('did-finish-load', async () => {
    try {
      const execute = code => window.webContents.executeJavaScript(code);
      // Wait until the actual app has finished opening its database.
      await execute(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(db){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Database unavailable'))}},20)})`);
      assert.equal(await execute(`Boolean(window.electronAPI && NightwaveCore)`), true);
      const title = 'Song "Live" <img src=x onerror="window.injected=true">';
      await execute(`state.tracks=[{id:'test-track',key:${JSON.stringify(audioPath)},path:${JSON.stringify(audioPath)},title:${JSON.stringify(title)},artist:'Artist',album:'Album',duration:1}];render();audio.muted=true;`);
      assert.equal(await execute(`document.querySelector('.track-title').textContent`), title);
      assert.equal(await execute(`document.querySelector('.external-drag').getAttribute('aria-label')`), `Drag ${title} to another app`);
      assert.equal(await execute(`Boolean(document.querySelector('#track-list img') || window.injected)`), false);
      await execute(`window.textResult=askText('Edit title',${JSON.stringify(title)});void 0`);
      assert.equal(await execute(`document.querySelector('dialog input').value`), title);
      await execute(`document.querySelector('dialog .dialog-primary').click();`);
      assert.equal(await execute(`window.textResult`), title);
      assert.equal(await execute(`window.electronAPI.fileUrl(${JSON.stringify(audioPath)})`), require('node:url').pathToFileURL(audioPath).href);
      assert.equal(await execute(`window.electronAPI.fileUrl('/etc/passwd').then(()=>false,()=>true)`), true);
      // Fragment links must not disable IPC sender validation.
      await execute(`location.hash='test'`);
      assert.equal(await execute(`window.electronAPI.fileUrl(${JSON.stringify(audioPath)}).then(()=>true)`), true);
      const tags = await execute(`window.electronAPI.writeTags({filePath:${JSON.stringify(tagPath)},title:'Song "Live"',artist:'Artist',album:'Album'})`);
      assert.equal(tags.title, 'Song "Live"');
      assert.equal(await execute(`window.electronAPI.writeTags({filePath:${JSON.stringify(tagPath)},title:123,artist:'Artist',album:'Album'}).then(()=>false,()=>true)`), true);
      const scanned = await execute(`window.scanUpdates=[];window.electronAPI.refreshMusicFolders([${JSON.stringify(temporary)}],value=>scanUpdates.push(value))`);
      assert(scanned.tracks.some(track => track.path === audioPath));
      assert.equal(await execute(`scanUpdates.at(-1).completed === scanUpdates.at(-1).total`), true);
      await execute(`playTrack('test-track').then(()=>audio.pause())`);
      assert.equal(await execute(`state.currentId`), 'test-track');
      // Drive the actual handler with explicit timestamps so desktop click settings cannot affect the test.
      assert.equal(await execute(`(()=>{let plays=0,edits=0;const originalPlay=playTrack,originalEdit=editMetadata;playTrack=()=>plays++;editMetadata=()=>edits++;const target=document.querySelector('.track-title');const click=timeStamp=>document.querySelector('#track-list').onclick({target,timeStamp,shiftKey:false,ctrlKey:false,metaKey:false});trackClicks.reset();click(100);click(300);click(1200);click(1800);playTrack=originalPlay;editMetadata=originalEdit;return plays===1&&edits===1})()`), true);
      // Exercise the inline editor against a real temporary MP3 and the actual tag worker.
      await execute(`state.query='';state.tracks=[{id:'inline-test',key:${JSON.stringify(tagPath)},path:${JSON.stringify(tagPath)},title:'Song "Live"',artist:'Artist',album:'Album',duration:0}];render();editMetadata('inline-test','title')`);
      assert.equal(await execute(`document.querySelector('.metadata-input').value`), 'Song "Live"');
      assert.equal(await execute(`Boolean(document.querySelector('dialog[open]'))`), false);
      const inlineTitle = 'Inline "Live" <remix>';
      await execute(`(()=>{const input=document.querySelector('.metadata-input');input.value=${JSON.stringify(inlineTitle)};input.dispatchEvent(new Event('input'));input.setSelectionRange(3,7);render()})()`);
      assert.equal(await execute(`document.querySelector('.metadata-input').value`), inlineTitle);
      assert.equal(await execute(`document.activeElement.selectionStart`), 3);
      await execute(`document.querySelector('.metadata-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));void 0`);
      await execute(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(!metadataEdit){clearInterval(timer);resolve()}else if(metadataEdit.error||++attempts>100){clearInterval(timer);reject(Error(metadataEdit.error||'Inline save timed out'))}},20)})`);
      assert.equal(require('node-id3').read(tagPath).title, inlineTitle);
      assert.equal(await execute(`state.tracks[0].title`), inlineTitle);
      assert.equal(await execute(`document.querySelector('.track-title').textContent`), inlineTitle);
      assert.equal(await execute(`Boolean(document.querySelector('.metadata-input')||document.querySelector('dialog[open]'))`), false);
      await execute(`editMetadata('inline-test','artist');document.querySelector('.metadata-input').value='Cancelled';document.querySelector('.metadata-input').dispatchEvent(new Event('input'));document.querySelector('.metadata-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
      assert.equal(await execute(`state.tracks[0].artist`), 'Artist');
      assert.equal(require('node-id3').read(tagPath).artist, 'Artist');
      assert.equal(await execute(`Boolean(document.querySelector('.metadata-input'))`), false);
      // A write error keeps the draft and displays the error in its row, without a dialog.
      await execute(`state.tracks[0].path=${JSON.stringify(path.join(temporary, 'missing.mp3'))};editMetadata('inline-test','album');const input=document.querySelector('.metadata-input');input.value='Unsaved album';input.dispatchEvent(new Event('input'));void 0`);
      await execute(`saveMetadataEdit()`);
      assert.equal(await execute(`document.querySelector('.metadata-input').value`), 'Unsaved album');
      assert.equal(await execute(`Boolean(metadataEdit.error)&&!metadataEdit.saving&&!document.querySelector('dialog[open]')`), true);
      await execute(`document.querySelector('.metadata-cancel').click();void 0`);
      assert.equal(await execute(`(async()=>{await writeBatch(db,'playlists',[{id:'one',name:'First',order:0},{id:'two',name:'Second',order:1}]);let aborted=false;try{await transaction(db,'playlists','readwrite',store=>{store.put({id:'one',name:'Changed'});store.put({missingKey:true})})}catch{aborted=true}const values=await all('playlists');return aborted&&values.find(item=>item.id==='one').name==='First'&&values.find(item=>item.id==='two').name==='Second'})()`), true);
      assert.deepEqual(fatalErrors, []);
      finish();
    } catch (error) { finish(error); }
  });
});
require('../main');
