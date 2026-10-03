// Isolated headless desktop checks. The --no-sandbox flag belongs only to this test runner.
const { app, BrowserWindow, globalShortcut, nativeImage, net } = require('electron');
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
const tonePath=path.join(temporary,'tone.wav'),toneWave=Buffer.from(wave);
for(let sample=0;sample<8000;sample++)toneWave.writeInt16LE(Math.round(16000*Math.sin(2*Math.PI*440*sample/8000)),44+sample*2);
fs.writeFileSync(tonePath,toneWave);
const tagPath = path.join(temporary, 'tags.mp3');fs.writeFileSync(tagPath, Buffer.alloc(100));
const coverPath=path.join(temporary,'cover.mp3');fs.writeFileSync(coverPath,Buffer.alloc(100));
const coverPng=nativeImage.createFromBitmap(Buffer.alloc(256*256*4,255),{width:256,height:256}).toPNG();
assert.equal(require('node-id3').update({title:'Covered song',artist:'Cover artist',image:{mime:'image/png',type:{id:3,name:'front cover'},description:'Front',imageBuffer:coverPng}},coverPath),true);
// Exercise the complete online-cover flow without depending on external services.
const replacementPng=nativeImage.createFromBitmap(Buffer.alloc(256*256*4,Buffer.from([0,0,255,255])),{width:256,height:256}).toPNG();
const originalFetch=net.fetch.bind(net);
net.fetch=(url,options)=>{
  if(url.startsWith('https://musicbrainz.org/ws/2/recording?'))return Promise.resolve(Response.json({recordings:[{title:'Covered song',score:100,'artist-credit':[{artist:{name:'Cover artist'}}],releases:[{id:'00000000-0000-0000-0000-000000000001',title:'Cover album',status:'Official'}]}]}));
  if(url.startsWith('https://coverartarchive.org/release/'))return Promise.resolve(new Response(replacementPng,{headers:{'Content-Type':'image/png'}}));
  return originalFetch(url,options);
};
const fatalErrors = [];
let finished = false;
let primary;
const timeout = setTimeout(() => finish(new Error('Desktop checks timed out.')), 25000);

function finish(error) {
  if (finished) return;finished = true;clearTimeout(timeout);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  if (error) { console.error(error); if(fatalErrors.length)console.error('Renderer errors:',fatalErrors); }
  else console.log('PASS: isolated Electron checks (CSP, quotes, IPC, inline editing, tag writes, scanning, playback, live spectrum, embedded artwork, progress alignment, click timing, IndexedDB rollback).');
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
      const artworkTrack=await execute(`window.electronAPI.readTrack(${JSON.stringify(coverPath)})`);
      assert(artworkTrack.artwork.startsWith('data:image/png;base64,'));
      assert.deepEqual(nativeImage.createFromDataURL(artworkTrack.artwork).getSize(),{width:128,height:128});
      await execute(`window.originalTracks=state.tracks;state.tracks=[{id:'cover-test',key:${JSON.stringify(coverPath)},path:${JSON.stringify(coverPath)},title:'Old song',artist:'Artist',album:'Album',duration:0}];refreshSavedMetadata()`);
      assert.equal(await execute(`state.tracks[0].artwork`),artworkTrack.artwork);
      assert.equal(await execute(`(async()=>{const tracks=await all('tracks');return tracks.find(track=>track.id==='cover-test').artwork})()`),artworkTrack.artwork);
      assert.equal(await execute(`(async()=>{const image=document.querySelector('.mini-art img');await image.decode();return image.naturalWidth})()`),128);
      await execute(`state.playlists.push({id:'cover-playlist',name:'Covers',trackKeys:[${JSON.stringify(coverPath)}]});state.selected='cover-playlist';state.currentId='cover-test';render()`);
      assert.equal(await execute(`document.querySelector('.mini-art img').src===state.tracks[0].artwork&&document.querySelector('#artwork img').src===state.tracks[0].artwork`),true);
      // Add-files uses the browser parser, so verify that route on the same tagged MP3.
      const browserCover=await execute(`trackMetadata(new File([new Uint8Array(${JSON.stringify([...fs.readFileSync(coverPath)])})],'cover.mp3',{type:'audio/mpeg'}))`);
      assert.equal(browserCover.title,'Covered song');
      assert(browserCover.artwork.startsWith('data:image/png;base64,'));
      await execute(`state.tracks[0].artwork='data:image/png;base64,AAAA';render();new Promise(resolve=>setTimeout(resolve,50))`);
      assert.equal(await execute(`Boolean(document.querySelector('.mini-art img'))`),false);
      await execute(`state.tracks=window.originalTracks;state.playlists=[];state.selected='all';state.currentId=null;render()`);
      assert.equal(await execute(`document.querySelector('.mini-art').textContent`),'♫');
      await execute(`(async()=>{window.thumbnailTestTrack={id:'thumbnail-test',...await window.electronAPI.readTrack(${JSON.stringify(coverPath)})};state.tracks=[thumbnailTestTrack];state.currentId='thumbnail-test';render();songMenu('thumbnail-test',document.querySelector('.row-menu'));})()`);
      assert.equal(await execute(`document.querySelector('[data-action="artwork"]').textContent`),'Update thumbnail');
      await execute(`document.querySelector('[data-action="artwork"]').click();new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(document.querySelector('.artwork-result button')){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Cover search did not finish'))}},20)})`);
      assert.equal(await execute(`document.querySelector('.artwork-result strong').textContent`),'Cover album');
      // Search alone must leave the file unchanged.
      assert.deepEqual(require('node-id3').read(coverPath).image.imageBuffer,coverPng);
      await execute(`document.querySelector('.artwork-result button').click();new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(!document.querySelector('.artwork-dialog')){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Cover save did not finish'))}},20)})`);
      const savedCoverTags=require('node-id3').read(coverPath);
      assert.equal(savedCoverTags.title,'Covered song');assert.equal(savedCoverTags.artist,'Cover artist');
      assert.equal(savedCoverTags.image.mime,'image/jpeg');
      assert.equal(savedCoverTags.raw.APIC.type.id,3);
      assert.equal(nativeImage.createFromBuffer(savedCoverTags.image.imageBuffer).isEmpty(),false);
      assert.equal(await execute(`document.querySelector('.mini-art img').src===state.tracks[0].artwork&&document.querySelector('#artwork img').src===state.tracks[0].artwork`),true);
      assert.equal(await execute(`window.electronAPI.saveArtwork({filePath:${JSON.stringify(coverPath)},token:'invalid'}).then(()=>false,()=>true)`),true);
      assert.equal(await execute(`window.electronAPI.searchArtwork({filePath:${JSON.stringify(audioPath)},title:'Song',artist:'Artist'}).then(()=>false,()=>true)`),true);
      await execute(`state.tracks=window.originalTracks;state.currentId=null;render()`);
      // Resolve the fill stop in Chromium and compare it with the native thumb's
      // centre across slider widths and fractional progress values.
      const sliderChecks = await execute(`(()=>{
        const progress=$('#progress'),originalWidth=progress.style.width,results=[];
        const probe=document.createElement('div'),fill=document.createElement('div');
        probe.style.cssText='position:fixed;visibility:hidden';probe.append(fill);document.body.append(probe);
        for(const width of [240,640]){
          progress.style.width=width+'px';
          for(const percent of [0,12.345,50,87.654,100]){
            progress.value=percent;progress.dispatchEvent(new Event('input',{bubbles:true}));
            const style=getComputedStyle(progress),fraction=Number(progress.value)/100;
            probe.style.width=progress.getBoundingClientRect().width+'px';
            fill.style.width=style.getPropertyValue('--progress-position');
            const thumbWidth=parseFloat(style.getPropertyValue('--thumb-size'));
            results.push({value:Number(progress.value),percent,fill:fill.getBoundingClientRect().width,
              thumb:thumbWidth/2+fraction*(progress.getBoundingClientRect().width-thumbWidth),
              gradient:style.backgroundImage});
          }
        }
        progress.style.width=originalWidth;probe.remove();stopPlayback();
        return {results,reset:Number(progress.value),resetFraction:Number(progress.style.getPropertyValue('--progress-fraction'))};
      })()`);
      for (const result of sliderChecks.results) {
        assert.equal(result.value, result.percent);
        assert(Math.abs(result.fill - result.thumb) < 0.1, 'Fill must meet the thumb centre');
        assert(result.gradient.startsWith('linear-gradient('), 'Progress gradient must resolve');
      }
      assert.equal(sliderChecks.reset, 0);
      assert.equal(sliderChecks.resetFraction, 0);
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
      // A real tone must reach the analyser from a native file URL, while the
      // canvas follows playback and returns to a quiet baseline after pausing.
      await execute(`(async()=>{audio.muted=false;audio.volume=1;audio.loop=true;audio.src=await window.electronAPI.fileUrl(${JSON.stringify(tonePath)});await audio.play();await new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(sidebarVisualizer.analyser){sidebarVisualizer.draw();if(Math.max(...sidebarVisualizer.bins)>0){clearInterval(timer);resolve();return}}if(++attempts>100){clearInterval(timer);reject(Error('Local audio did not reach the spectrum analyser'))}},20)})})()`);
      assert.equal(await execute(`document.querySelector('#sidebar-visualizer').classList.contains('is-playing')`),true);
      assert.equal(await execute(`Math.max(...sidebarVisualizer.levels)>0`),true);
      await execute(`window.originalSpectrumSource=sidebarVisualizer.source;audio.pause();void 0`);
      assert.equal(await execute(`Math.max(...sidebarVisualizer.levels)===0&&sidebarVisualizer.frame===0`),true);
      assert.equal(await execute(`document.querySelector('#sidebar-visualizer').classList.contains('is-playing')`),false);
      await execute(`(async()=>{await audio.play();await sidebarVisualizer.play();audio.pause();audio.loop=false;audio.muted=true})()`);
      assert.equal(await execute(`sidebarVisualizer.source===window.originalSpectrumSource`),true);
      await execute(`(async()=>{window.spectrumBlobUrl=URL.createObjectURL(new Blob([new Uint8Array(${JSON.stringify([...toneWave])})],{type:'audio/wav'}));audio.src=spectrumBlobUrl;audio.muted=false;await audio.play();await new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{sidebarVisualizer.draw();if(Math.max(...sidebarVisualizer.bins)>0){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Blob audio did not reach the spectrum'))}},20)})})()`);
      assert.equal(await execute(`sidebarVisualizer.source===window.originalSpectrumSource`),true);
      await execute(`document.documentElement.style.setProperty('--sidebar-width','415px');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await execute(`sidebarVisualizer.width>350&&sidebarVisualizer.width<415`),true);
      await execute(`audio.pause();audio.muted=true;URL.revokeObjectURL(spectrumBlobUrl);document.documentElement.style.removeProperty('--sidebar-width');void 0`);
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
