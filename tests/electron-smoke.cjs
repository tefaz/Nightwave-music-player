// Isolated headless desktop checks. The --no-sandbox flag belongs only to this test runner.
const { app, BrowserWindow, globalShortcut, nativeImage, net, shell } = require('electron');
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
const karaokePath=path.join(temporary,'karaoke.mp3');fs.writeFileSync(karaokePath,Buffer.alloc(100));
assert.equal(require('node-id3').update({synchronisedLyrics:{language:'eng',timeStampFormat:2,contentType:1,shortText:'Test',synchronisedText:[{text:'\nFirst karaoke line',timeStamp:0},{text:'\nSecond karaoke line',timeStamp:500}]}},karaokePath),true);
// Exercise the complete online-cover flow without depending on external services.
const replacementPng=nativeImage.createFromBitmap(Buffer.alloc(256*256*4,Buffer.from([0,0,255,255])),{width:256,height:256}).toPNG();
const originalFetch=net.fetch.bind(net);
let coverMetadataRequests=0,coverDownloadRequests=0;
net.fetch=(url,options)=>{
  if(url.startsWith('https://musicbrainz.org/ws/2/recording?')){coverMetadataRequests++;return Promise.resolve(Response.json({recordings:[{title:'Covered song',score:100,'artist-credit':[{artist:{name:'Cover artist'}}],releases:Array.from({length:9},(_,index)=>({id:`00000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`,title:index?`Alternative album ${index}`:'Cover album',status:'Official'}))}]}))}
  if(url.startsWith('https://musicbrainz.org/ws/2/release?'))return Promise.resolve(Response.json({releases:[]}));
  if(url.startsWith('https://coverartarchive.org/release/')){coverDownloadRequests++;return Promise.resolve(new Response(replacementPng,{headers:{'Content-Type':'image/png'}}))}
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
  else console.log('PASS: isolated Electron checks (CSP, quotes, IPC, header menus, row dragging, native file drops, playlist drops and reordering, inline editing, tag writes, scanning, playback, live spectrum, five main visualizers, saved view and visualizer selection, equalizer visibility, embedded artwork, karaoke timing and controls, progress alignment, click timing, IndexedDB rollback).');
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
      // Timed lyrics occupy their own quiet column between time and options.
      assert.deepEqual(await execute(`(()=>{const saved=state.tracks;state.tracks=[{id:'timed',title:'Timed',artist:'Artist',duration:5,hasTimedLyrics:true},{id:'plain',title:'Plain',artist:'Artist',duration:5,hasTimedLyrics:false}];render();const cells=[...document.querySelectorAll('.timed-lyrics-cell')];const result=cells.map(cell=>({marker:!!cell.querySelector('svg'),label:cell.getAttribute('aria-label'),before:cell.previousElementSibling.className,after:cell.nextElementSibling.className}));state.tracks=saved;render();return result})()`),[
        {marker:true,label:'Embedded timed lyrics',before:'time-cell',after:'track-actions'},
        {marker:false,label:'No embedded timed lyrics',before:'time-cell',after:'track-actions'}
      ]);
      // The persistent header shortcut opens Karaoke lounge and enables karaoke.
      assert.equal(await execute(`document.querySelector('#show-playing').nextElementSibling.id`),'open-karaoke');
      assert.equal(await execute(`document.querySelector('#show-playing').textContent.trim()`),'♫Go to playing');
      assert.equal(await execute(`document.querySelector('#open-karaoke').closest('.topbar')!==null&&document.querySelector('.content-actions #open-karaoke')===null&&getComputedStyle(document.querySelector('#open-karaoke')).webkitAppRegion==='no-drag'`),true);
      await execute(`document.querySelector('#open-karaoke').click()`);
      assert.equal(await execute(`!document.querySelector('#tunnel-visualizer').hidden&&document.querySelector('#visualizer-name').textContent==='Karaoke lounge'&&document.querySelector('#karaoke-toggle').textContent==='Karaoke: On'&&document.querySelector('#karaoke-mode').textContent==='Karaoke Mode: Scrolling lines'&&document.querySelector('#karaoke-highlight').textContent==='Word highlighting: On'&&state.currentId===null`),true);
      await execute(`document.querySelector('#open-karaoke').click()`);
      assert.equal(await execute(`document.querySelector('#karaoke-toggle').getAttribute('aria-pressed')`),'true');
      await execute(`document.querySelector('#karaoke-toggle').click();musicVisualizer.setPreset('tunnel');setAppView('library')`);
      // Header menus must be clickable in the draggable title bar, exclusive,
      // dismissible, and still connected to the existing file input action.
      assert.deepEqual(await execute(`Array.from(document.querySelectorAll('#files-menu button'),button=>button.id)`),['load-folder','refresh-folders','manage-folders','add-files','clear-library']);
      assert.equal(await execute(`getComputedStyle(document.querySelector('#files-menu')).webkitAppRegion`),'no-drag');
      await execute(`document.querySelector('#files-menu summary').click()`);
      assert.equal(await execute(`document.querySelector('#files-menu').open&&document.querySelector('#load-folder').getBoundingClientRect().height>0`),true);
      await execute(`document.querySelector('#view-menu summary').click()`);
      assert.equal(await execute(`!document.querySelector('#files-menu').open&&document.querySelector('#view-menu').open`),true);
      await execute(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
      assert.equal(await execute(`!document.querySelector('#view-menu').open&&document.activeElement===document.querySelector('#view-menu summary')`),true);
      await execute(`document.querySelector('#files-menu summary').click();document.querySelector('.content-head').click()`);
      assert.equal(await execute(`Boolean(document.querySelector('.header-menu[open]'))`),false);
      await execute(`document.querySelector('#file-input').addEventListener('click',event=>{event.preventDefault();window.filePickerClicked=true},{once:true});document.querySelector('#files-menu summary').click();document.querySelector('#add-files').click()`);
      assert.equal(await execute(`window.filePickerClicked&&!document.querySelector('#files-menu').open`),true);
      const title = 'Song "Live" <img src=x onerror="window.injected=true">';
      await execute(`state.tracks=[{id:'test-track',key:${JSON.stringify(audioPath)},path:${JSON.stringify(audioPath)},title:${JSON.stringify(title)},artist:'Artist',album:'Album',duration:1}];render();audio.muted=true;`);
      assert.equal(await execute(`document.querySelector('.track-title').textContent`), title);
      assert.equal(await execute(`Boolean(document.querySelector('.external-drag'))`), false);
      assert.equal(await execute(`document.querySelector('.track-row').title.includes('Drag to a playlist or another desktop app')`), true);
      assert.equal(await execute(`Boolean(document.querySelector('#track-list img') || window.injected)`), false);
      // Keep the real preload + IPC + file validation, replacing only the OS drag
      // call, which needs an interactive desktop. Exercise every part of the row.
      const nativeDrags=[], originalStartDrag=window.webContents.startDrag;
      window.webContents.startDrag=item=>nativeDrags.push(item);
      const dragFrom=selector=>execute(`(()=>{const transfer=new DataTransfer(),event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer});document.querySelector(${JSON.stringify(selector)}).dispatchEvent(event);return {cancelled:event.defaultPrevented,text:transfer.getData('text/plain')}})()`);
      const waitForDrags=async count=>{
        const deadline=Date.now()+2000;
        while(nativeDrags.length<count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(nativeDrags.length,count);
      };
      for(const selector of ['.track-title','.artist-cell','.album-cell','.time-cell','.mini-art','.track-row']){
        const beforeDrag=nativeDrags.length;
        assert.equal((await dragFrom(selector)).cancelled,true);
        await waitForDrags(beforeDrag+1);
        assert.deepEqual(nativeDrags.at(-1).files,[audioPath]);
        assert.equal(nativeDrags.at(-1).icon.isEmpty(),false);
      }
      const beforeMenuDrag=nativeDrags.length;
      assert.equal((await dragFrom('.row-menu')).cancelled,true);
      assert.equal(nativeDrags.length,beforeMenuDrag);
      await execute(`state.tracks.push({id:'tone-test',key:${JSON.stringify(tonePath)},path:${JSON.stringify(tonePath)},title:'Tone',artist:'Artist',album:'Album',duration:1});state.selectedTrackIds=new Set(['test-track','tone-test']);state.playlists=[{id:'drag-playlist',name:'Drag target',trackKeys:[]},{id:'other-playlist',name:'Other',trackKeys:[]}];render()`);
      const beforeMultiDrag=nativeDrags.length;
      await dragFrom('[data-track="test-track"] .track-title');
      await waitForDrags(beforeMultiDrag+1);
      assert.deepEqual(nativeDrags.at(-1).files,[audioPath,tonePath]);
      // Chromium creates real, disk-backed File objects for these native drops.
      // This verifies path lookup through the isolated preload, the playlist UI,
      // and IndexedDB persistence rather than merely calling a helper function.
      window.webContents.debugger.attach('1.3');
      const dropFiles=async files=>{
        const {x,y}=await execute(`(()=>{const rect=document.querySelector('[data-playlist-row="drag-playlist"]').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
        for(const type of ['dragEnter','dragOver','drop'])await window.webContents.debugger.sendCommand('Input.dispatchDragEvent',{type,x,y,data:{items:[],files,dragOperationsMask:1}});
      };
      await dropFiles([audioPath,tonePath]);
      await execute(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(state.playlists[0].trackKeys.length===2){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Native playlist drop did not finish'))}},10)})`);
      assert.deepEqual(await execute(`state.playlists[0].trackKeys`),[audioPath,tonePath]);
      assert.deepEqual(await execute(`all('playlists').then(playlists=>playlists.find(p=>p.id==='drag-playlist').trackKeys)`),[audioPath,tonePath]);
      await dropFiles([audioPath,tonePath]);
      await execute(`new Promise(resolve=>setTimeout(resolve,30))`);
      assert.deepEqual(await execute(`state.playlists[0].trackKeys`),[audioPath,tonePath]);
      assert.equal(await execute(`Boolean(document.querySelector('.drop-target'))`),false);
      await dropFiles([tagPath]);
      await execute(`new Promise(resolve=>setTimeout(resolve,30))`);
      assert.deepEqual(await execute(`state.playlists[0].trackKeys`),[audioPath,tonePath]);
      // Individual file imports must retain their disk path, just like folder scans.
      const {root}=await window.webContents.debugger.sendCommand('DOM.getDocument');
      const {nodeId}=await window.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'#file-input'});
      await window.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[audioPath]});
      await execute(`addTrack(document.querySelector('#file-input').files[0])`);
      assert.equal(await execute(`state.tracks.find(t=>t.file)?.path`),audioPath);
      assert.equal(await execute(`all('tracks').then(tracks=>tracks.find(t=>t.file)?.path)`),audioPath);
      // A file loaded twice can have two library keys; a native drop recognizes both.
      await dropFiles([audioPath]);
      await execute(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(state.playlists[0].trackKeys.length===3){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Imported file drop did not finish'))}},10)})`);
      const importedKey=await execute(`state.tracks.find(t=>t.file).key`);
      assert.deepEqual(await execute(`state.playlists[0].trackKeys`),[audioPath,tonePath,importedKey]);
      await execute(`state.tracks=state.tracks.filter(t=>!t.file);state.playlists[0].trackKeys=state.playlists[0].trackKeys.filter(key=>key!==${JSON.stringify(importedKey)})`);
      window.webContents.debugger.detach();
      // Browser-only tracks retain HTML playlist dragging, even in mixed selections.
      await execute(`state.tracks.push({id:'browser-track',key:'browser-key',title:'Browser',artist:'Artist',album:'Album',duration:1});state.selectedTrackIds=new Set(['test-track','browser-track']);render()`);
      const fallback=await dragFrom('[data-track="browser-track"] .track-title');
      assert.equal(fallback.cancelled,false);
      assert.deepEqual(JSON.parse(fallback.text),['test-track','browser-track']);
      await execute(`(()=>{const transfer=new DataTransfer();transfer.setData('text/plain',${JSON.stringify(fallback.text)});return document.querySelector('#playlist-list').ondrop({preventDefault(){},target:document.querySelector('[data-playlist-row="drag-playlist"]'),dataTransfer:transfer})})()`);
      assert.deepEqual(await execute(`state.playlists[0].trackKeys`),[audioPath,tonePath,'browser-key']);
      await execute(`(()=>{const row=document.querySelector('[data-track="test-track"]');document.querySelector('#track-list').ondragend({target:row});const transfer=new DataTransfer();document.querySelector('#playlist-list').ondragstart({target:document.querySelector('[data-playlist-row="other-playlist"]'),dataTransfer:transfer});return document.querySelector('#playlist-list').ondrop({preventDefault(){},target:document.querySelector('[data-playlist-row="drag-playlist"]'),dataTransfer:transfer})})()`);
      assert.deepEqual(await execute(`state.playlists.map(p=>p.id)`),['other-playlist','drag-playlist']);
      window.webContents.startDrag=originalStartDrag;
      await execute(`state.tracks=state.tracks.filter(t=>t.id==='test-track');state.playlists=[];state.selectedTrackIds=new Set();render()`);
      const artworkTrack=await execute(`window.electronAPI.readTrack(${JSON.stringify(coverPath)})`);
      assert(artworkTrack.artwork.startsWith('data:image/png;base64,'));
      assert.deepEqual(nativeImage.createFromDataURL(artworkTrack.artwork).getSize(),{width:128,height:128});
      await execute(`window.originalTracks=state.tracks;state.tracks=[{id:'cover-test',key:${JSON.stringify(coverPath)},path:${JSON.stringify(coverPath)},title:'Old song',artist:'Artist',album:'Album',duration:0}];refreshSavedMetadata()`);
      assert.equal(await execute(`state.tracks[0].artwork`),artworkTrack.artwork);
      assert.equal(await execute(`(async()=>{const tracks=await all('tracks');return tracks.find(track=>track.id==='cover-test').artwork})()`),artworkTrack.artwork);
      assert.equal(await execute(`(async()=>{const image=document.querySelector('.mini-art img');await image.decode();return image.naturalWidth})()`),128);
      await execute(`state.playlists.push({id:'cover-playlist',name:'Covers',trackKeys:[${JSON.stringify(coverPath)}]});state.selected='cover-playlist';state.currentId='cover-test';render()`);
      assert.equal(await execute(`document.querySelector('.mini-art img').src===state.tracks[0].artwork&&document.querySelector('#artwork img').src===state.tracks[0].artwork`),true);
      // The viewer reads the original embedded image, rather than enlarging the thumbnail.
      assert.equal(await execute(`(()=>{const cover=document.querySelector('#artwork'),rect=cover.getBoundingClientRect(),footer=document.querySelector('.player'),bounds=footer.getBoundingClientRect(),style=getComputedStyle(cover);return bounds.height===126&&rect.left===bounds.left&&rect.top===bounds.top+footer.clientTop&&rect.bottom===bounds.bottom&&rect.width===rect.height&&style.boxShadow==='none'&&style.borderRadius==='0px'})()`),true);
      await execute(`document.querySelector('#artwork').focus();openAlbumCover()`);
      const coverView=await execute(`(async()=>{const dialog=document.querySelector('.cover-viewer'),image=dialog.querySelector('img');await image.decode();await new Promise(resolve=>requestAnimationFrame(resolve));const rect=image.getBoundingClientRect(),style=getComputedStyle(dialog);return {width:image.naturalWidth,height:image.naturalHeight,centerX:rect.left+rect.width/2,centerY:rect.top+rect.height/2,viewportWidth:innerWidth,viewportHeight:innerHeight,border:style.borderWidth,background:style.backgroundColor}})()`);
      assert.equal(coverView.width,256);assert.equal(coverView.height,256);
      assert(Math.abs(coverView.centerX-coverView.viewportWidth/2)<1);
      assert(Math.abs(coverView.centerY-coverView.viewportHeight/2)<1);
      assert.equal(coverView.border,'0px');assert.equal(coverView.background,'rgba(0, 0, 0, 0)');
      await execute(`document.querySelector('.cover-close').click();new Promise(resolve=>requestAnimationFrame(resolve))`);
      assert.equal(await execute(`!document.querySelector('.cover-viewer')&&document.activeElement===document.querySelector('#artwork')`),true);
      // Browser-imported files also preserve the full image dimensions.
      await execute(`window.coverNativePath=state.tracks[0].path;state.tracks[0].path=null;state.tracks[0].file=new File([new Uint8Array(${JSON.stringify([...fs.readFileSync(coverPath)])})],'cover.mp3',{type:'audio/mpeg'});openAlbumCover()`);
      assert.equal(await execute(`(async()=>{const image=document.querySelector('.cover-viewer img');await image.decode();return image.naturalWidth})()`),256);
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await execute(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await execute(`Boolean(document.querySelector('.cover-viewer'))`),false);
      await execute(`state.tracks[0].path=window.coverNativePath;state.tracks[0].file=null`);
      // A single click on a row thumbnail opens that song's cover without starting playback.
      await execute(`state.currentId=null;render();window.coverSelectionBefore=[...state.selectedTrackIds];document.querySelector('.mini-art img').click();new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{const image=document.querySelector('.cover-viewer img');if(image?.complete&&image.naturalWidth){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Row cover did not open'))}},10)})`);
      assert.equal(await execute(`document.querySelector('.cover-viewer img').naturalWidth`),256);
      assert.equal(await execute(`state.currentId`),null);
      assert.equal(await execute(`JSON.stringify([...state.selectedTrackIds])===JSON.stringify(window.coverSelectionBefore)`),true);
      await execute(`document.querySelector('.cover-close').click();new Promise(resolve=>requestAnimationFrame(resolve))`);
      await execute(`state.currentId='cover-test';render()`);
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
      assert.equal(await execute(`document.querySelectorAll('.artwork-result').length`),4);
      assert.equal(await execute(`document.querySelector('.artwork-search input[name="album"]').value`),'');
      assert.equal(await execute(`document.querySelector('[data-previous]').disabled&&!document.querySelector('[data-next]').disabled`),true);
      const coverPageNames=await execute(`Array.from(document.querySelectorAll('.artwork-result strong'),name=>name.textContent)`);
      const waitForCoverPage = label => execute(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(document.querySelector('[data-page]').textContent===${JSON.stringify(label)}&&!document.querySelector('.artwork-search button').disabled){clearInterval(timer);resolve()}else if(++attempts>250){clearInterval(timer);reject(Error('Cover page did not finish: '+document.querySelector('.artwork-status').textContent))}},20)})`);
      await execute(`document.querySelector('[data-next]').click()`);await waitForCoverPage('Covers 5–8');
      assert.equal(await execute(`document.querySelectorAll('.artwork-result').length`),4);
      assert.equal(await execute(`Array.from(document.querySelectorAll('.artwork-result strong'),name=>name.textContent).some(name=>${JSON.stringify(coverPageNames)}.includes(name))`),false);
      await execute(`document.querySelector('[data-next]').click()`);await waitForCoverPage('Covers 9–9');
      assert.equal(await execute(`document.querySelectorAll('.artwork-result').length===1&&document.querySelector('[data-next]').disabled`),true);
      const downloadsAfterPaging=coverDownloadRequests;
      await execute(`document.querySelector('[data-previous]').click();document.querySelector('[data-previous]').click()`);
      assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.artwork-result strong'),name=>name.textContent)`),coverPageNames);
      assert.equal(coverMetadataRequests,1);assert.equal(coverDownloadRequests,downloadsAfterPaging);
      // Correcting the album search starts a fresh search and leaves the MP3 tags alone.
      await execute(`document.querySelector('.artwork-search input[name="album"]').value='Cover album';document.querySelector('.artwork-search').requestSubmit()`);
      await waitForCoverPage('Covers 1–4');
      assert.equal(coverMetadataRequests,2);
      assert.equal(await execute(`document.querySelector('[data-previous]').disabled`),true);
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
      // Hiding the visualizer stops drawing but preserves the active audio path.
      await execute(`window.toggleSpectrumSource=sidebarVisualizer.source;window.toggleSpectrumContext=sidebarVisualizer.context;document.querySelector('#view-menu summary').click();document.querySelector('#show-equalizer').click();new Promise(resolve=>setTimeout(resolve,30))`);
      assert.equal(await execute(`document.querySelector('#sidebar-visualizer').hidden&&getComputedStyle(document.querySelector('#sidebar-visualizer')).display==='none'&&sidebarVisualizer.frame===0`),true);
      assert.equal(await execute(`document.querySelector('#show-equalizer').getAttribute('aria-pressed')`),'false');
      assert.equal(await execute(`localStorage.getItem('nightwave-show-equalizer')`),'false');
      assert.equal(await execute(`!audio.paused&&sidebarVisualizer.context.state==='running'&&sidebarVisualizer.source===window.toggleSpectrumSource`),true);
      await execute(`document.querySelector('#view-menu summary').click();document.querySelector('#show-equalizer').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await execute(`!document.querySelector('#sidebar-visualizer').hidden&&sidebarVisualizer.width>0&&!audio.paused&&sidebarVisualizer.source===window.toggleSpectrumSource&&sidebarVisualizer.context===window.toggleSpectrumContext`),true);
      assert.equal(await execute(`document.querySelector('#show-equalizer').getAttribute('aria-pressed')`),'true');
      // The tunnel replaces only the middle panels and reuses the playing source.
      await execute(`window.savedLibraryView={selected:state.selected,query:state.query};document.querySelector('#view-menu summary').click();document.querySelector('#view-visualizer').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await execute(`document.querySelector('.sidebar').hidden&&document.querySelector('.main-content').hidden&&!document.querySelector('#tunnel-visualizer').hidden&&document.querySelector('#sidebar-visualizer').hidden`),true);
      assert.equal(await execute(`document.querySelector('#view-visualizer').getAttribute('aria-pressed')==='true'&&document.querySelector('#view-library').getAttribute('aria-pressed')==='false'`),true);
      assert.equal(await execute(`(()=>{const header=document.querySelector('.topbar').getBoundingClientRect(),footer=document.querySelector('.player').getBoundingClientRect(),panel=document.querySelector('#tunnel-visualizer').getBoundingClientRect();return header.height>0&&footer.height>0&&panel.top===header.bottom&&panel.bottom===footer.top&&panel.width===document.documentElement.clientWidth})()`),true);
      assert.deepEqual(await execute(`window.electronAPI.readTimedLyrics(${JSON.stringify(karaokePath)})`),[{time:0,text:'First karaoke line'},{time:.5,text:'Second karaoke line'}]);
      assert.equal(await execute(`(()=>{const back=document.querySelector('#visualizer-library').getBoundingClientRect(),toggle=document.querySelector('#karaoke-toggle').getBoundingClientRect();return toggle.top>back.bottom&&Math.abs(toggle.right-back.right)<1})()`),true);
      await execute(`audio.pause();document.querySelector('#karaoke-toggle').click();NightwaveKaraoke.refresh({path:${JSON.stringify(karaokePath)}})`);
      await execute(`audio.currentTime=.1;audio.dispatchEvent(new Event('seeked'));void 0`);
      assert.equal(await execute(`document.querySelector('#karaoke-lyrics .karaoke-line').textContent`),'First karaoke line');
      assert.equal(await execute(`document.querySelector('#karaoke-mode').textContent`),'Karaoke Mode: Scrolling lines');
      assert.equal(await execute(`document.querySelector('#karaoke-toggle').textContent`),'Karaoke: On');
      await execute(`document.querySelector('#karaoke-mode').click();void 0`);
      assert.equal(await execute(`!document.querySelector('#karaoke-mode').hidden&&document.querySelector('#karaoke-mode').textContent==='Karaoke Mode: Current line'`),true);
      assert.equal(await execute(`document.querySelectorAll('#karaoke-lyrics .karaoke-sung').length`),1);
      assert.equal(await execute(`(()=>{const toggle=document.querySelector('#karaoke-toggle').getBoundingClientRect(),highlight=document.querySelector('#karaoke-highlight').getBoundingClientRect(),mode=document.querySelector('#karaoke-mode').getBoundingClientRect();return !document.querySelector('#karaoke-highlight').hidden&&highlight.top>toggle.bottom&&mode.top>highlight.bottom})()`),true);
      await execute(`document.querySelector('#karaoke-highlight').click();void 0`);
      assert.equal(await execute(`document.querySelector('#karaoke-highlight').textContent==='Word highlighting: Off'&&document.querySelector('#karaoke-highlight').getAttribute('aria-pressed')==='false'&&document.querySelectorAll('#karaoke-lyrics .karaoke-sung').length===0&&localStorage.getItem('nightwave-karaoke-highlight')==='false'`),true);
      await execute(`document.querySelector('#karaoke-mode').click();audio.currentTime=.4;audio.dispatchEvent(new Event('seeked'));void 0`);
      assert.equal(await execute(`document.querySelector('#karaoke-mode').textContent==='Karaoke Mode: Scrolling lines'&&document.querySelectorAll('#karaoke-lyrics .karaoke-sung').length===0`),true);
      await execute(`document.querySelector('#karaoke-highlight').click();document.querySelector('#karaoke-mode').click();audio.currentTime=.1;audio.dispatchEvent(new Event('seeked'));void 0`);
      assert.equal(await execute(`document.querySelectorAll('#karaoke-lyrics .karaoke-sung').length`),1);

      await execute(`document.querySelector('#karaoke-mode').click();audio.currentTime=.4;audio.dispatchEvent(new Event('seeked'));void 0`);
      assert.equal(await execute(`document.querySelector('#karaoke-mode').textContent`),'Karaoke Mode: Scrolling lines');
      assert.equal(await execute(`document.querySelectorAll('#karaoke-lyrics .karaoke-line').length`),2);
      assert.equal(await execute(`document.querySelectorAll('#karaoke-lyrics .karaoke-line:first-child .karaoke-sung').length`),3);
      assert.equal(await execute(`document.querySelectorAll('#karaoke-lyrics .karaoke-line:last-child .karaoke-sung').length`),0);
      assert.equal(await execute(`parseFloat(document.querySelector('#karaoke-lyrics .karaoke-line').style.opacity)<1`),true);
      await execute(`audio.currentTime=.1;audio.dispatchEvent(new Event('seeked'));void 0`);
      assert.equal(await execute(`document.querySelectorAll('#karaoke-lyrics .karaoke-sung').length`),1);
      if(process.argv.includes('--capture-visualizer'))fs.writeFileSync(path.join(os.tmpdir(),'nightwave-karaoke-scrolling-preview.png'),(await window.webContents.capturePage()).toPNG());
      await execute(`document.querySelector('#karaoke-mode').click();void 0`);
      await execute(`audio.currentTime=.7;audio.dispatchEvent(new Event('seeked'));void 0`);
      assert.equal(await execute(`document.querySelector('#karaoke-lyrics').textContent`),'Second karaoke line');
      await execute(`NightwaveKaraoke.refresh({path:${JSON.stringify(audioPath)}})`);
      assert.equal(await execute(`document.querySelector('#karaoke-lyrics').hidden&&!document.querySelector('#karaoke-status').hidden&&!document.querySelector('#karaoke-mode').hidden&&!document.querySelector('#karaoke-highlight').hidden`),true);
      assert.equal(await execute(`(()=>{const status=document.querySelector('#karaoke-status'),link=status.querySelector('a');return status.textContent.includes('or another tool')&&status.textContent.includes('SYLT')&&status.textContent.includes('LRC')&&link.textContent==='Tracksmith on GitHub'&&getComputedStyle(link).pointerEvents==='auto'})()`),true);
      const externalLinks=[],originalOpenExternal=shell.openExternal;
      shell.openExternal=async url=>{externalLinks.push(url)};
      try{
        await execute(`(()=>{const link=document.querySelector('#karaoke-status a'),event=new MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(event);return event.defaultPrevented})()`);
        await execute(`window.electronAPI.openTracksmith()`);
        assert.deepEqual(externalLinks,['https://github.com/tefaz/Tracksmith-mp3-enricher','https://github.com/tefaz/Tracksmith-mp3-enricher']);
      }finally{shell.openExternal=originalOpenExternal}
      await execute(`document.querySelector('#karaoke-toggle').click();audio.currentTime=0;audio.play()`);
      assert.equal(await execute(`document.querySelector('#karaoke-toggle').getAttribute('aria-pressed')==='false'&&document.querySelector('#karaoke-toggle').textContent==='Karaoke: Off'&&document.querySelector('#karaoke-lyrics').hidden&&document.querySelector('#karaoke-status').hidden&&document.querySelector('#karaoke-mode').hidden&&document.querySelector('#karaoke-highlight').hidden`),true);
      await execute(`musicVisualizer.time=2;musicVisualizer.travel=0.43;for(let frame=0;frame<8;frame++)musicVisualizer.draw();document.querySelector('.toast')?.classList.remove('show');void 0`);
      assert.equal(await execute(`musicVisualizer.mid>0.01&&!audio.paused&&sidebarVisualizer.source===window.toggleSpectrumSource&&sidebarVisualizer.context===window.toggleSpectrumContext`),true);
      assert.equal(await execute(`musicVisualizer.analyser!==sidebarVisualizer.analyser&&musicVisualizer.analyser.smoothingTimeConstant<sidebarVisualizer.analyser.smoothingTimeConstant`),true);
      // Freeze the scene and compare an attack with its resting frame. Each
      // animated preset must respond; still scenes and reduced motion suppress pulses.
      const beatResponses=await execute(`(()=>{
        const visualizer=musicVisualizer,ctx=visualizer.paint,canvas=visualizer.canvas;
        const savedBeat=visualizer.beat,savedMotion=visualizer.motion;
        const sample=()=>ctx.getImageData(0,0,canvas.width,canvas.height).data;
        const render=preset=>{ctx.save();try{visualizer[preset.render](true)}finally{ctx.restore()}return sample()};
        try{return visualizer.presets.map(preset=>{
          visualizer.motion={matches:false};visualizer.beat=0;const rest=render(preset);
          visualizer.beat=1;const attack=render(preset);
          let difference=0;for(let index=0;index<rest.length;index+=400)difference+=Math.abs(rest[index]-attack[index])+Math.abs(rest[index+1]-attack[index+1])+Math.abs(rest[index+2]-attack[index+2]);
          visualizer.motion={matches:true};const reduced=render(preset);
          let reducedDifference=0;for(let index=0;index<rest.length;index+=400)reducedDifference+=Math.abs(rest[index]-reduced[index])+Math.abs(rest[index+1]-reduced[index+1])+Math.abs(rest[index+2]-reduced[index+2]);
          return {id:preset.id,difference,reducedDifference};
        })}finally{visualizer.beat=savedBeat;visualizer.motion=savedMotion;visualizer.draw()}
      })()`);
      for(const response of beatResponses){if(['midnight','karaoke'].includes(response.id))assert.equal(response.difference,0,JSON.stringify(response));else assert(response.difference>1000,JSON.stringify(response));assert.equal(response.reducedDifference,0,JSON.stringify(response))}
      // Optional screenshot for visual inspection; normal checks keep no images.
      if(process.argv.includes('--capture-visualizer'))fs.writeFileSync(path.join(os.tmpdir(),'nightwave-tunnel-preview.png'),(await window.webContents.capturePage()).toPNG());
      const tunnelPixels=await execute(`(()=>{const canvas=musicVisualizer.canvas,data=musicVisualizer.paint.getImageData(0,0,canvas.width,canvas.height).data;let lit=0,maximum=0;for(let index=0;index<data.length;index+=400){const value=Math.max(data[index],data[index+1],data[index+2]);maximum=Math.max(maximum,value);if(value>80)lit++}return {lit,maximum,width:canvas.width,height:canvas.height}})()`);
      assert(tunnelPixels.maximum>100&&tunnelPixels.lit>tunnelPixels.width*tunnelPixels.height/100*0.006,JSON.stringify(tunnelPixels));
      assert.equal(await execute(`(()=>{const panel=document.querySelector('#tunnel-visualizer').getBoundingClientRect(),button=document.querySelector('#visualizer-next').getBoundingClientRect();return Math.abs(button.y+button.height/2-panel.y-panel.height/2)<1&&button.right<panel.right&&button.right>panel.right-100})()`),true);
      // Clicking the same control cycles all effects without recreating audio.
      const signatures=[];
      const signature=()=>execute(`(()=>{const canvas=musicVisualizer.canvas,data=musicVisualizer.paint.getImageData(0,0,canvas.width,canvas.height).data;let value=0;for(let index=0;index<data.length;index+=400)value=(value*31+data[index]+data[index+1]*3+data[index+2]*7)>>>0;return value})()`);
      signatures.push(await signature());
      for(const preset of [{id:'midnight',name:'Midnight',next:'Karaoke lounge'},{id:'karaoke',name:'Karaoke lounge',next:'Aurora'},{id:'aurora',name:'Aurora',next:'Kaleidoscope'},{id:'kaleidoscope',name:'Kaleidoscope',next:'Space tunnel'},{id:'tunnel',name:'Space tunnel',next:'Midnight'}]){
        await execute(`document.querySelector('#visualizer-next').click();for(let frame=0;frame<4;frame++)musicVisualizer.draw();void 0`);
        assert.equal(await execute(`document.querySelector('#visualizer-name').textContent`),preset.name);
        assert.equal(await execute(`document.querySelector('#visualizer-next').getAttribute('aria-label')`),`Next visualizer: ${preset.next}`);
        assert.equal(await execute(`localStorage.getItem('nightwave-visualizer')`),preset.id);
        assert.equal(await execute(`!audio.paused&&sidebarVisualizer.source===window.toggleSpectrumSource&&sidebarVisualizer.context===window.toggleSpectrumContext`),true);
        if(['midnight','karaoke'].includes(preset.id))assert.equal(await execute(`musicVisualizer.frame`),0);
        if(preset.id!=='tunnel'){
          signatures.push(await signature());
          if(process.argv.includes('--capture-visualizer'))fs.writeFileSync(path.join(os.tmpdir(),`nightwave-${preset.id}-preview.png`),(await window.webContents.capturePage()).toPNG());
        }
      }
      assert.equal(new Set(signatures).size,5);
      await execute(`document.querySelector('#visualizer-library').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await execute(`document.querySelector('#tunnel-visualizer').hidden&&!document.querySelector('.sidebar').hidden&&!document.querySelector('.main-content').hidden&&!document.querySelector('#sidebar-visualizer').hidden&&musicVisualizer.frame===0`),true);
      assert.equal(await execute(`state.selected===window.savedLibraryView.selected&&state.query===window.savedLibraryView.query&&!audio.paused&&sidebarVisualizer.source===window.toggleSpectrumSource`),true);
      await execute(`document.querySelector('#view-visualizer').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));void 0`);
      assert.equal(await execute(`document.querySelector('#tunnel-visualizer').hidden&&localStorage.getItem('nightwave-view')==='library'`),true);
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
      // Follow shuffled playback in long lists immediately, including when CSS
      // requests smooth scrolling. Inspect the geometry in the playback turn.
      const playbackScrollChecks=await execute(`(async()=>{
        const saved={tracks:state.tracks,playlists:state.playlists,selected:state.selected,query:state.query,sort:state.sort,shuffle:state.shuffle,random:playbackQueue.random};
        const content=document.querySelector('.main-content'),savedBehavior=content.style.scrollBehavior;
        const tracks=Array.from({length:80},(_,index)=>({id:'scroll-'+index,key:'scroll-key-'+index,path:${JSON.stringify(audioPath)},title:'Song '+String(index).padStart(3,'0'),artist:'Artist',album:'Album',duration:1}));
        const checks=[];
        const visible=()=>{const row=document.querySelector('.track-row.playing')?.getBoundingClientRect(),viewport=content.getBoundingClientRect();return Boolean(row&&row.top>=viewport.top&&row.bottom<=viewport.bottom)};
        const change=action=>new Promise(resolve=>{const originalRender=render;render=()=>{originalRender();render=originalRender;queueMicrotask(resolve)};action()});
        try{
          state.tracks=tracks;state.playlists=[{id:'scroll-playlist',name:'Long playlist',trackKeys:tracks.map(track=>track.key)},{id:'other-playlist',name:'Other playlist',trackKeys:tracks.slice(0,40).map(track=>track.key)}];
          state.query='';state.sort={key:'title',direction:'asc'};state.shuffle=true;playbackQueue.random=()=>0.25;audio.loop=true;content.style.scrollBehavior='smooth';
          for(const view of ['all','scroll-playlist']){
            state.selected=view;render();content.scrollTo({top:0,behavior:'instant'});
            await playTrack('scroll-0');content.scrollTo({top:0,behavior:'instant'});
            const nextId=playbackQueue.order[1];
            await change(()=>audio.onended());
            checks.push({view,phase:'shuffle ended',current:state.currentId,expected:nextId,visible:visible(),scroll:content.scrollTop});
            const rowBounds=document.querySelector('.track-row.playing').getBoundingClientRect(),viewBounds=content.getBoundingClientRect();
            checks.push({view,phase:'centered',offset:Math.abs((rowBounds.top+rowBounds.bottom)/2-(viewBounds.top+content.clientTop+content.clientHeight/2))});
            const atBottom=content.scrollTop;
            render();checks.push({view,phase:'rerender',samePosition:content.scrollTop===atBottom});
            await change(()=>nextTrack(true));
            checks.push({view,phase:'previous',current:state.currentId,expected:'scroll-0',unchanged:content.scrollTop===atBottom});
            await nextTrack();
            checks.push({view,phase:'manual next',current:state.currentId,expected:nextId,unchanged:content.scrollTop===atBottom});
            await playTrack('scroll-79');
            checks.push({view,phase:'manual selection',current:state.currentId,expected:'scroll-79',unchanged:content.scrollTop===atBottom});
          }
          // A queue can continue while browsing a playlist or filter without its song.
          state.selected='other-playlist';render();content.scrollTo({top:400,behavior:'instant'});const before=content.scrollTop;
          await playTrack('scroll-79',true);
          checks.push({phase:'other playlist',selected:state.selected,unchanged:content.scrollTop===before});
          state.selected='all';state.query='Song 000';render();await playTrack('scroll-79',true);
          checks.push({phase:'filtered',query:state.query,noRow:!document.querySelector('.track-row.playing')});
          setAppView('visualizer');await playTrack('scroll-0',true);
          checks.push({phase:'visualizer',hidden:content.hidden});setAppView('library');
          return checks;
        }finally{stopPlayback();audio.loop=false;Object.assign(state,{tracks:saved.tracks,playlists:saved.playlists,selected:saved.selected,query:saved.query,sort:saved.sort,shuffle:saved.shuffle});playbackQueue.random=saved.random;content.style.scrollBehavior=savedBehavior;render();content.scrollTo({top:0,behavior:'instant'})}
      })()`);
      for(const check of playbackScrollChecks){
        if(check.phase==='shuffle ended'){assert.equal(check.current,check.expected);assert(check.visible&&check.scroll>0,JSON.stringify(check))}
        else if(['previous','manual next','manual selection'].includes(check.phase)){assert.equal(check.current,check.expected);assert(check.unchanged,JSON.stringify(check))}
        else if(check.phase==='centered')assert(check.offset<1,JSON.stringify(check));
        else if(check.phase==='rerender')assert(check.samePosition,JSON.stringify(check));
        else if(check.phase==='other playlist'){assert.equal(check.selected,'other-playlist');assert(check.unchanged)}
        else if(check.phase==='filtered'){assert.equal(check.query,'Song 000');assert(check.noRow)}
        else if(check.phase==='visualizer')assert(check.hidden);
      }
      await execute(`playTrack('test-track').then(()=>audio.pause())`);
      assert.equal(await execute(`state.currentId`), 'test-track');
      const keyboardPlayback=await execute(`(async()=>{
        const savedSelection=state.selectedTrackIds,savedAnchor=state.selectionAnchor;
        state.tracks.push({...state.tracks.find(track=>track.id==='test-track'),id:'keyboard-track'});audio.loop=true;
        state.selectedTrackIds=new Set(['keyboard-track']);state.selectionAnchor='keyboard-track';render();
        const key=(key,target=document.querySelector('#next'),options={})=>{const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event.defaultPrevented};
        const start=()=>new Promise(resolve=>{const originalRender=render;render=()=>{originalRender();render=originalRender;resolve()};key('Enter')});
        try{
          await start();const selectedStarted=state.currentId==='keyboard-track'&&!audio.paused;
          audio.currentTime=.6;await start();const restarted=audio.currentTime<.2&&!audio.paused;
          const spaceHandled=key(' '),paused=audio.paused;
          key(' ',undefined,{repeat:true});const repeatIgnored=audio.paused;
          const resumed=new Promise(resolve=>audio.addEventListener('playing',resolve,{once:true}));key(' ');await resumed;
          const resumedPlayback=!audio.paused;
          setAppView('visualizer');key(' ');const visualizerPaused=audio.paused;setAppView('library');
          const search=document.querySelector('#search'),searchIgnored=!key(' ',search)&&!key('Enter',search)&&audio.paused;
          const pending=askText('Keyboard test');const input=document.querySelector('dialog input');const dialogIgnored=!key(' ',input)&&!key('Enter',input);document.querySelector('[data-cancel]').click();await pending;
          const before=playbackRequest;state.selectedTrackIds=new Set();key('Enter');const noSelectionIgnored=playbackRequest===before;
          return {selectedStarted,restarted,spaceHandled,paused,repeatIgnored,resumedPlayback,visualizerPaused,searchIgnored,dialogIgnored,noSelectionIgnored};
        }finally{audio.pause();audio.loop=false;state.tracks=state.tracks.filter(track=>track.id!=='keyboard-track');state.selectedTrackIds=savedSelection;state.selectionAnchor=savedAnchor;await playTrack('test-track');audio.pause()}
      })()`);
      for(const [behavior,passed] of Object.entries(keyboardPlayback))assert(passed,behavior);
      const keyboardSelection=await execute(`(()=>{
        const saved={tracks:state.tracks,selected:state.selected,query:state.query,sort:state.sort,ids:state.selectedTrackIds,anchor:state.selectionAnchor};
        const key=(key,target=document.body,options={})=>{const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event.defaultPrevented};
        const selected=()=>[...state.selectedTrackIds][0];
        try{
          state.tracks=Array.from({length:50},(_,index)=>({id:'arrow-'+index,title:'Song '+String(index).padStart(2,'0'),artist:'Artist',album:'Album',duration:1}));state.selected='all';state.query='';state.sort={key:'title',direction:'desc'};state.selectedTrackIds=new Set();state.selectionAnchor=null;render();
          const before=playbackRequest;key('ArrowDown');const first=selected()==='arrow-49';key('ArrowDown');const down=selected()==='arrow-48';key('ArrowUp');key('ArrowUp');const topBoundary=selected()==='arrow-49';
          state.selectedTrackIds=new Set(['arrow-1']);state.selectionAnchor='arrow-1';key('ArrowDown',undefined,{repeat:true});key('ArrowDown');const bottomBoundary=selected()==='arrow-0';
          const row=document.querySelector('.selected-track').getBoundingClientRect(),content=document.querySelector('.main-content').getBoundingClientRect(),visible=row.top>=content.top&&row.bottom<=content.bottom;
          const inputIgnored=!key('ArrowUp',document.querySelector('#search'))&&selected()==='arrow-0';
          state.query='Song 4';render();key('ArrowDown');key('ArrowDown');const filtered=selected()==='arrow-48';
          state.query='no matches';render();const emptyIgnored=key('ArrowDown')&&selected()==='arrow-48';
          return {first,down,topBoundary,bottomBoundary,visible,inputIgnored,filtered,emptyIgnored,noPlayback:playbackRequest===before};
        }finally{Object.assign(state,{tracks:saved.tracks,selected:saved.selected,query:saved.query,sort:saved.sort,selectedTrackIds:saved.ids,selectionAnchor:saved.anchor});render();document.querySelector('.main-content').scrollTo({top:0,behavior:'instant'})}
      })()`);
      for(const [behavior,passed] of Object.entries(keyboardSelection))assert(passed,behavior);
      // Drive the actual handler with explicit timestamps so desktop click settings cannot affect the test.
      assert.equal(await execute(`(()=>{let plays=0,edits=0;const originalPlay=playTrack,originalEdit=editMetadata;playTrack=()=>plays++;editMetadata=()=>edits++;const target=document.querySelector('.track-title');const click=timeStamp=>document.querySelector('#track-list').onclick({target,timeStamp,shiftKey:false,ctrlKey:false,metaKey:false});trackClicks.reset();click(100);click(300);click(1200);click(1800);playTrack=originalPlay;editMetadata=originalEdit;return plays===1&&edits===1})()`), true);
      // Right-click anywhere on a song row reuses the three-dot menu.
      const rowMenus=await execute(`(async()=>{
        const row=document.querySelector('.track-row'),snapshot=()=>Array.from(document.querySelectorAll('.song-popover button'),button=>({action:button.dataset.action,text:button.textContent,disabled:button.disabled}));
        row.querySelector('.row-menu').click();const expected=snapshot();await new Promise(resolve=>setTimeout(resolve,0));
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        const results=[];
        for(const selector of ['.track-title','.artist-cell','.album-cell','.mini-art','.row-menu',null]){
          trackClicks.click(row.dataset.track,'title',100);
          const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:400,clientY:220});
          (selector?row.querySelector(selector):row).dispatchEvent(event);
          const bounds=document.querySelector('.song-popover').getBoundingClientRect();
          results.push({prevented:event.defaultPrevented,menu:snapshot(),reset:trackClicks.previous===null,current:state.currentId,left:bounds.left,top:bounds.top});
          await new Promise(resolve=>setTimeout(resolve,0));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        }
        const edgeEvent=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:innerWidth-1,clientY:innerHeight-1});row.dispatchEvent(edgeEvent);
        const edge=document.querySelector('.song-popover').getBoundingClientRect(),fits= edge.left>=0&&edge.top>=0&&edge.right<=innerWidth&&edge.bottom<=innerHeight;
        await new Promise(resolve=>setTimeout(resolve,0));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        return {expected,results,fits};
      })()`);
      for(const result of rowMenus.results){assert(result.prevented&&result.reset);assert.deepEqual(result.menu,rowMenus.expected);assert.equal(result.current,'test-track');assert.equal(result.left,400);assert.equal(result.top,220)}
      assert(rowMenus.fits);
      // Exercise the inline editor against a real temporary MP3 and the actual tag worker.
      await execute(`state.query='';state.tracks=[{id:'inline-test',key:${JSON.stringify(tagPath)},path:${JSON.stringify(tagPath)},title:'Song "Live"',artist:'Artist',album:'Album',duration:0}];render();window.normalRowHeight=document.querySelector('.track-row').getBoundingClientRect().height`);
      for(const field of ['title','artist','album']){
        const menuEdit=await execute(`(async()=>{document.querySelector('.track-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:400,clientY:220}));const button=document.querySelector('[data-action="edit-${field}"]'),label=button.textContent;button.click();await Promise.resolve();const input=document.querySelector('.metadata-input');return {label,field:metadataEdit.field,track:metadataEdit.trackId,value:input.value,expected:state.tracks[0]['${field}'],focused:document.activeElement===input,selected:input.selectionStart===0&&input.selectionEnd===input.value.length,menuClosed:!document.querySelector('.song-popover')}})()`);
        assert.equal(menuEdit.label,`Edit ${field}`);assert.equal(menuEdit.field,field);assert.equal(menuEdit.track,'inline-test');assert.equal(menuEdit.value,menuEdit.expected);
        assert(menuEdit.focused&&menuEdit.selected&&menuEdit.menuClosed);
        await execute(`cancelMetadataEdit()`);
      }
      const playlistPicker=await execute(`(async()=>{
        const savedPlaylists=state.playlists,savedSelected=state.selected;
        const names=['Chill "mix" <favorites>','Same name','Same name'];
        state.playlists=names.map((name,index)=>({id:'picker-'+index,name,trackKeys:[],order:index}));state.selected='all';render();
        try{
          document.querySelector('.track-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));
          document.querySelector('[data-action="playlist"]').click();await Promise.resolve();
          const dialog=document.querySelector('.playlist-picker'),buttons=[...dialog.querySelectorAll('[data-playlist-choice]')];
          const labels=buttons.map(button=>button.textContent),noInput=!dialog.querySelector('input');
          buttons[2].click();
          await new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(state.playlists[2].trackKeys.length){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Playlist choice did not save'))}},10)});
          const memberships=state.playlists.map(playlist=>playlist.trackKeys.includes(state.tracks[0].key));
          const stored=(await all('playlists')).find(playlist=>playlist.id==='picker-2');
          const duplicate=addToPlaylist('inline-test');document.querySelector('[data-playlist-choice="picker-2"]').click();await duplicate;
          const count=state.playlists[2].trackKeys.length;
          const cancelled=addToPlaylist('inline-test');document.querySelector('.playlist-picker [data-cancel]').click();await cancelled;
          return {labels,noInput,memberships,stored:stored.trackKeys.includes(state.tracks[0].key),count,closed:!document.querySelector('.playlist-picker'),unchanged:state.playlists[0].trackKeys.length===0};
        }finally{state.playlists=savedPlaylists;state.selected=savedSelected;await writeBatch(db,'playlists',[],['picker-0','picker-1','picker-2']);render()}
      })()`);
      assert.deepEqual(playlistPicker.labels,['Chill "mix" <favorites>','Same name','Same name']);
      assert.deepEqual(playlistPicker.memberships,[false,false,true]);assert.equal(playlistPicker.count,1);
      assert(playlistPicker.noInput&&playlistPicker.stored&&playlistPicker.closed&&playlistPicker.unchanged);
      await execute(`editMetadata('inline-test','title')`);
      assert.equal(await execute(`document.querySelector('.metadata-input').value`), 'Song "Live"');
      assert.equal(await execute(`document.querySelector('.track-row').getBoundingClientRect().height`),await execute(`normalRowHeight`));
      assert.equal(await execute(`Boolean(document.querySelector('.metadata-edit-status,.metadata-save,.metadata-cancel'))`),false);
      assert.equal(await execute(`Boolean(document.querySelector('dialog[open]'))`), false);
      assert.equal(await execute(`(()=>{const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2});document.querySelector('.metadata-input').dispatchEvent(event);return !event.defaultPrevented&&!document.querySelector('.song-popover')})()`),true);
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
      // Clicking another row saves the active field and still selects that row.
      await execute(`(()=>{state.tracks.push({id:'other-row',title:'Other',artist:'Artist',album:'Album',duration:0});render();editMetadata('inline-test','album');const input=document.querySelector('.metadata-input');input.value='Updated album';input.dispatchEvent(new Event('input'));document.querySelector('[data-track="other-row"] .track-title').click();})()`);
      await execute(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(!metadataEdit){clearInterval(timer);resolve()}else if(metadataEdit.error||++attempts>100){clearInterval(timer);reject(Error(metadataEdit.error||'Click-away save timed out'))}},20)})`);
      assert.equal(require('node-id3').read(tagPath).album,'Updated album');
      assert.equal(await execute(`state.selectedTrackIds.has('other-row')`),true);
      // A write error retains the draft and marks the input, without enlarging its row.

      await execute(`state.tracks[0].path=${JSON.stringify(path.join(temporary, 'missing.mp3'))};editMetadata('inline-test','album');const input=document.querySelector('.metadata-input');input.value='Unsaved album';input.dispatchEvent(new Event('input'));void 0`);
      await execute(`saveMetadataEdit()`);
      assert.equal(await execute(`document.querySelector('.metadata-input').value`), 'Unsaved album');
      assert.equal(await execute(`Boolean(metadataEdit.error)&&!metadataEdit.saving&&!document.querySelector('dialog[open]')`), true);
      await execute(`document.querySelector('.metadata-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
      assert.equal(await execute(`(async()=>{await writeBatch(db,'playlists',[{id:'one',name:'First',order:0},{id:'two',name:'Second',order:1}]);let aborted=false;try{await transaction(db,'playlists','readwrite',store=>{store.put({id:'one',name:'Changed'});store.put({missingKey:true})})}catch{aborted=true}const values=await all('playlists');return aborted&&values.find(item=>item.id==='one').name==='First'&&values.find(item=>item.id==='two').name==='Second'})()`), true);
      // Restore the saved preference on a fresh page, and initialize the analyser
      // when it is first shown during playback that began with it hidden.
      await execute(`document.querySelector('#show-equalizer').click();document.querySelector('#shuffle').click();document.querySelector('#repeat').click()`);
      assert.equal(await execute(`state.shuffle&&state.repeat&&localStorage.getItem('nightwave-shuffle')==='true'&&localStorage.getItem('nightwave-repeat')==='true'`),true);
      await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload()});
      assert.equal(await execute(`state.shuffle&&state.repeat&&playbackQueue.shuffle&&['shuffle','repeat'].every(mode=>{const button=document.getElementById(mode);return button.classList.contains('active')&&button.getAttribute('aria-pressed')==='true'})`),true);
      await execute(`document.querySelector('#shuffle').click()`);
      assert.equal(await execute(`!state.shuffle&&state.repeat&&!playbackQueue.shuffle&&localStorage.getItem('nightwave-shuffle')==='false'`),true);
      assert.equal(await execute(`document.querySelector('#sidebar-visualizer').hidden&&document.querySelector('#show-equalizer').getAttribute('aria-pressed')==='false'`),true);
      await execute(`(async()=>{audio.muted=true;audio.loop=true;audio.src=await window.electronAPI.fileUrl(${JSON.stringify(tonePath)});await audio.play()})()`);
      assert.equal(await execute(`!sidebarVisualizer.context&&!audio.paused`),true);
      await execute(`document.querySelector('#view-menu summary').click();document.querySelector('#show-equalizer').click();new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(sidebarVisualizer.analyser&&sidebarVisualizer.width>0){clearInterval(timer);resolve()}else if(++attempts>100){clearInterval(timer);reject(Error('Showing the equalizer did not initialize it'))}},10)})`);
      assert.equal(await execute(`!audio.paused&&sidebarVisualizer.context.state==='running'&&localStorage.getItem('nightwave-show-equalizer')==='true'`),true);
      await execute(`document.querySelector('#view-visualizer').click();musicVisualizer.setPreset('kaleidoscope')`);
      await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload()});
      assert.equal(await execute(`!document.querySelector('#tunnel-visualizer').hidden&&document.querySelector('.sidebar').hidden&&document.querySelector('#view-visualizer').getAttribute('aria-pressed')==='true'`),true);
      assert.equal(await execute(`document.querySelector('#visualizer-name').textContent`),'Kaleidoscope');
      assert.equal(await execute(`!state.shuffle&&state.repeat&&!document.querySelector('#shuffle').classList.contains('active')&&document.querySelector('#shuffle').getAttribute('aria-pressed')==='false'&&document.querySelector('#repeat').getAttribute('aria-pressed')==='true'`),true);
      // Start playback with the library hidden: the tunnel initializes the one
      // shared analyser, then returning to the spectrum preserves that source.
      await execute(`(async()=>{audio.muted=true;audio.loop=true;audio.src=await window.electronAPI.fileUrl(${JSON.stringify(tonePath)});await audio.play();await musicVisualizer.play()})()`);
      assert.equal(await execute(`Boolean(sidebarVisualizer.source)&&!audio.paused&&sidebarVisualizer.context.state==='running'`),true);
      await execute(`window.savedTunnelSource=sidebarVisualizer.source;document.querySelector('#visualizer-library').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await execute(`sidebarVisualizer.source===window.savedTunnelSource&&!audio.paused&&!document.querySelector('#sidebar-visualizer').hidden`),true);
      await execute(`document.querySelector('#repeat').click()`);
      assert.equal(await execute(`!state.repeat&&localStorage.getItem('nightwave-repeat')==='false'`),true);
      await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload()});
      assert.equal(await execute(`!state.shuffle&&!state.repeat&&['shuffle','repeat'].every(mode=>{const button=document.getElementById(mode);return !button.classList.contains('active')&&button.getAttribute('aria-pressed')==='false'})`),true);
      // Saved mode and highlighting preferences survive a reload and the shortcut.
      await execute(`localStorage.setItem('nightwave-karaoke-mode','current');localStorage.setItem('nightwave-karaoke-highlight','false')`);
      await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.webContents.reload()});
      await execute(`setAppView('library');document.querySelector('#open-karaoke').click()`);
      assert.equal(await execute(`document.querySelector('#visualizer-name').textContent==='Karaoke lounge'&&localStorage.getItem('nightwave-visualizer')==='karaoke'&&document.querySelector('#karaoke-toggle').getAttribute('aria-pressed')==='true'&&document.querySelector('#karaoke-mode').textContent==='Karaoke Mode: Current line'&&document.querySelector('#karaoke-highlight').getAttribute('aria-pressed')==='false'&&!document.querySelector('#karaoke-highlight').hidden&&localStorage.getItem('nightwave-karaoke-mode')==='current'&&localStorage.getItem('nightwave-karaoke-highlight')==='false'`),true);
      assert.deepEqual(fatalErrors, []);
      finish();
    } catch (error) { finish(error); }
  });
});
require('../main');
