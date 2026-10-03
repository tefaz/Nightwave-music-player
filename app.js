const $ = (selector) => document.querySelector(selector);
const audio = $('#audio');
const { transaction, writeBatch, PlaybackQueue, TrackClicks } = NightwaveCore;
const playbackQueue = new PlaybackQueue();
const trackClicks = new TrackClicks();
let playbackRequest = 0, scanning = false;
let metadataEdit = null, renderingTracks = false;
const savedLibraryFolders=(()=>{try{const folders=JSON.parse(localStorage.getItem('nightwave-library-folders')||'[]');return Array.isArray(folders)?folders.filter(folder=>typeof folder==='string'&&folder):[]}catch{return []}})();
let db, state = { tracks: [], playlists: [], selected: 'all', currentId: null, shuffle: false, repeat: false, objectUrl: null, query: '', sort: { key: 'artist', direction: 'asc' }, selectedTrackIds: new Set(), selectionAnchor: null, libraryFolders: savedLibraryFolders };
const metadataParser = import('./vendor/music-metadata.bundle.mjs').then(module=>module.parseBlob).catch(()=>null);
const sidebarMin=265,sidebarMax=415,savedSidebarWidth=Number(localStorage.getItem('nightwave-sidebar-width'));if(savedSidebarWidth>=sidebarMin&&savedSidebarWidth<=sidebarMax)document.documentElement.style.setProperty('--sidebar-width',`${savedSidebarWidth}px`);
const lyricsMin=370,lyricsMax=620,savedLyricsWidth=Number(localStorage.getItem('nightwave-lyrics-width'));if(savedLyricsWidth>=lyricsMin&&savedLyricsWidth<=lyricsMax)document.documentElement.style.setProperty('--lyrics-width',`${savedLyricsWidth}px`);

function openDB() { return new Promise((resolve, reject) => { const req = indexedDB.open('nightwave-player', 1); req.onupgradeneeded = () => { const d=req.result; d.createObjectStore('tracks',{keyPath:'id'}); d.createObjectStore('playlists',{keyPath:'id'}); }; req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); }); }
function all(store) { return transaction(db, store, 'readonly', (objectStore, result) => { const request=objectStore.getAll();request.onsuccess=()=>result(request.result); }); }
function put(store, value) { return writeBatch(db, store, [value]); }
function del(store, key) { return writeBatch(db, store, [], [key]); }
const id = () => crypto.randomUUID();
const time = seconds => { if(!Number.isFinite(seconds)) return '—'; const m=Math.floor(seconds/60),s=Math.floor(seconds%60); return `${m}:${String(s).padStart(2,'0')}`; };
const fileTitle = name => name.replace(/\.[^.]+$/,'').replace(/[_.-]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
const decodeText = bytes => new TextDecoder('utf-8').decode(bytes).replace(/\0/g,'').trim();
const read32 = (bytes, offset) => ((bytes[offset]<<24)|(bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3])>>>0;
const readLE32 = (bytes, offset) => (bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16)|(bytes[offset+3]<<24))>>>0;
function parseCommentBlock(bytes,start=0){const result={};let offset=start;const vendor=readLE32(bytes,offset);offset+=4+vendor;const count=readLE32(bytes,offset);offset+=4;for(let i=0;i<count&&offset+4<=bytes.length;i++){const length=readLE32(bytes,offset);offset+=4;const [key,...value]=decodeText(bytes.subarray(offset,offset+length)).split('=');offset+=length;if(key&&value.length)result[key.toLowerCase()]=value.join('=')}return result}
function parseId3(bytes){if(decodeText(bytes.subarray(0,3))!=='ID3')return {};const version=bytes[3],limit=10+((bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9]),result={},isV22=version===2,headerSize=isV22?6:10;let offset=10;while(offset+headerSize<=limit&&offset+headerSize<=bytes.length){const id=decodeText(bytes.subarray(offset,offset+(isV22?3:4)));const size=isV22?((bytes[offset+3]<<16)|(bytes[offset+4]<<8)|bytes[offset+5]):version===4?((bytes[offset+4]<<21)|(bytes[offset+5]<<14)|(bytes[offset+6]<<7)|bytes[offset+7]):read32(bytes,offset+4);if(!id||!size)break;const value=bytes.subarray(offset+headerSize,Math.min(offset+headerSize+size,bytes.length));const encoding=value[0];const text=(encoding===1||encoding===2?new TextDecoder('utf-16').decode(value.subarray(1)):decodeText(value.subarray(1))).replace(/\0/g,'').trim();if(id==='TIT2'||id==='TT2')result.title=text;if(id==='TPE1'||id==='TP1')result.artist=text;if(id==='TALB'||id==='TAL')result.album=text;offset+=headerSize+size}return result}
function parseFlac(bytes){if(decodeText(bytes.subarray(0,4))!=='fLaC')return {};let offset=4;while(offset+4<=bytes.length){const header=bytes[offset],type=header&127,length=(bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3];if(type===4){const tags=parseCommentBlock(bytes,offset+4);return {title:tags.title,artist:tags.artist,album:tags.album}}offset+=4+length;if(header&128)break}return {}}
function parseMp4(bytes){const result={},wanted={'©nam':'title','©ART':'artist','aART':'artist','©alb':'album'},containers=new Set(['moov','udta','meta','ilst']);function walk(start,end,parent=''){let offset=start;while(offset+8<=end){let size=read32(bytes,offset),header=8;if(size===1&&offset+16<=end){size=read32(bytes,offset+8);header=16}if(!size||offset+size>end)break;const type=String.fromCharCode(bytes[offset+4],bytes[offset+5],bytes[offset+6],bytes[offset+7]);const content=offset+header;if(type==='data'&&wanted[parent]&&content+8<=offset+size){const value=decodeText(bytes.subarray(content+8,offset+size));if(value&&!result[wanted[parent]])result[wanted[parent]]=value}else if(containers.has(type)||wanted[type])walk(content+(type==='meta'?4:0),offset+size,type);offset+=size}}walk(0,bytes.length);return result}
async function embeddedTags(file){const bytes=new Uint8Array(await file.arrayBuffer());const tags={...parseId3(bytes),...parseFlac(bytes),...parseMp4(bytes)};if(!tags.title&&!tags.artist&&!tags.album){const text=decodeText(bytes);const marker=text.indexOf('vorbis');if(marker>=0){const comments=parseCommentBlock(bytes,marker+6);tags.title=comments.title;tags.artist=comments.artist;tags.album=comments.album}}return tags}
async function coverThumbnail(pictures = []) {
  const picture=pictures.find(item=>/front/i.test(item.type||item.name||''))||pictures[0];
  if(!picture?.data?.length||picture.data.length>10*1024*1024)return null;
  let image;
  try {
    image=await createImageBitmap(new Blob([picture.data],{type:picture.format}));
    const scale=Math.min(1,128/Math.max(image.width,image.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/png');
  } catch { return null; } finally { image?.close(); }
}
async function trackMetadata(file){
  const fallback=fileTitle(file.name).split(' - '),defaults={title:fallback.length>1?fallback.slice(1).join(' - '):fileTitle(file.name),artist:fallback.length>1?fallback[0]:'Unknown artist',album:'Local files',artwork:null};
  const parseBlob=await metadataParser;
  if(parseBlob){try{
    const metadata=await parseBlob(file,{skipCovers:false}),tags=metadata.common;
    return {...defaults,title:tags.title?.trim()||defaults.title,artist:tags.artist?.trim()||defaults.artist,album:tags.album?.trim()||defaults.album,artwork:await coverThumbnail(tags.picture)};
  }catch{}}
  try{const tags=await embeddedTags(file);return {...defaults,title:tags.title?.trim()||defaults.title,artist:tags.artist?.trim()||defaults.artist,album:tags.album?.trim()||defaults.album}}catch{return defaults}
}
function artworkMarkup(artwork,fallback='♫',lazy=false){
  return fallback+(typeof artwork==='string'&&/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(artwork)?`<img src="${artwork}" alt="" draggable="false"${lazy?' loading="lazy"':''}>`:'');
}
function renderArtwork(){
  const track=state.tracks.find(item=>item.id===state.currentId);
  $('#artwork').innerHTML=artworkMarkup(track?.artwork);
  document.querySelectorAll('.mini-art img,.artwork img').forEach(image=>{image.onerror=()=>image.remove()});
}
// Playlist memberships use a file key rather than the library's temporary track ID.
// That lets a playlist survive when its tracks are unloaded and later loaded again.
const playlistTrackKeys = playlist => playlist.trackKeys || [];
function visibleTracks(){ const p=state.playlists.find(p=>p.id===state.selected); let tracks=p ? state.tracks.filter(t=>playlistTrackKeys(p).includes(t.key)) : [...state.tracks]; const query=state.query.trim().toLowerCase(); if(query)tracks=tracks.filter(t=>[t.title,t.artist,t.album].some(value=>(value||'').toLowerCase().includes(query))); if(state.sort.key){const {key,direction}=state.sort;tracks.sort((a,b)=>{const one=key==='duration'?(a[key]||0):(a[key]||'').toLowerCase(),two=key==='duration'?(b[key]||0):(b[key]||'').toLowerCase();return (one>two?1:one<two?-1:0)*(direction==='asc'?1:-1)});} return tracks; }
function selectedPlaylist(){ return state.playlists.find(p=>p.id===state.selected); }

function render(){ renderingTracks=true;try{const editFocus=captureMetadataFocus();const tracks=visibleTracks(), playlist=selectedPlaylist(); $('#track-count').textContent=state.tracks.length; const canRefresh=Boolean(window.electronAPI&&state.libraryFolders.length);$('#refresh-folders').disabled=scanning||!canRefresh;$('#manage-folders').disabled=scanning||!canRefresh; $('.nav-item').classList.toggle('active',state.selected==='all'); $('#view-title').textContent=playlist?.name || 'All music'; $('#view-kicker').textContent=playlist ? 'PLAYLIST' : 'LIBRARY'; $('#view-subtitle').textContent=tracks.length ? `${tracks.length} ${tracks.length===1?'track':'tracks'}${state.query?' matching filter':''} · saved to this device` : state.query ? 'No songs match this filter.' : playlist ? 'No tracks in this playlist yet.' : 'Your saved collection will appear here.'; $('#play-all').style.visibility=tracks.length?'visible':'hidden'; $('#sync-playlist').hidden=!playlist||!tracks.length; $('#show-playing').disabled=!state.currentId;
 $('#playlist-list').innerHTML=state.playlists.map(p=>`<div class="playlist-item ${p.id===state.selected?'selected':''}" data-playlist-row="${escapeHTML(p.id)}" draggable="true" title="Drag to reorder this playlist"><button class="playlist-select" data-playlist="${escapeHTML(p.id)}"${p.id===state.selected?' aria-current="page"':''}><span>☷</span><span>${escapeHTML(p.name)}</span></button><span class="playlist-actions"><button data-rename="${escapeHTML(p.id)}" aria-label="Rename ${escapeHTML(p.name)}">✎</button><button data-delete="${escapeHTML(p.id)}" aria-label="Delete ${escapeHTML(p.name)}">×</button></span></div>`).join('');
 $('#empty-state').hidden=tracks.length>0; $('#track-area').hidden=!tracks.length;
 document.querySelectorAll('[data-sort]').forEach(button=>{const active=button.dataset.sort===state.sort.key;button.classList.toggle('sorted',active);button.querySelector('i').textContent=active?(state.sort.direction==='asc'?'↑':'↓'):''});
 $('#track-list').innerHTML=tracks.map(t=>`<div class="track-row ${t.id===state.currentId?'playing':''} ${state.selectedTrackIds.has(t.id)?'selected-track':''}" data-track="${escapeHTML(t.id)}" draggable="true" title="Fast double-click to play · Slow double-click a field to edit · Click to select · Ctrl/Cmd-click for multiple · Shift-click for a range · Drag to a playlist or another desktop app"><div class="title-cell"><div class="mini-art">${artworkMarkup(t.artwork,t.id===state.currentId?'▶':'♫',true)}</div><span class="track-title" data-edit="title">${escapeHTML(t.title)}</span></div><span class="artist-cell" data-edit="artist">${escapeHTML(t.artist || 'Unknown artist')}</span><span class="album-cell" data-edit="album">${escapeHTML(t.album || '—')}</span><span class="time-cell">${time(t.duration)}</span><span class="track-actions"><button class="row-menu" title="Song options" data-menu="${escapeHTML(t.id)}">•••</button></span></div>`).join('');
 renderArtwork();
 restoreMetadataEditor(editFocus);
 }finally{renderingTracks=false}
}
function escapeHTML(s){return NightwaveCore.escapeHTML(s)}
async function addTrack(file){ const path=window.electronAPI?.getPathForFile(file)||null; const key=`${file.name}-${file.size}-${file.lastModified}`,metadata=await trackMetadata(file); const existing=state.tracks.find(t=>t.key===key); if(existing){Object.assign(existing,metadata,{path,file,handle:null});await put('tracks',existing);return} const temp=URL.createObjectURL(file), probe=new Audio(temp); const duration=await new Promise(resolve=>{probe.onloadedmetadata=()=>resolve(probe.duration);probe.onerror=()=>resolve(0)}); URL.revokeObjectURL(temp); const track={id:id(),key,...metadata,duration,path,handle:null,file}; await put('tracks',track);state.tracks.push(track); }
async function addNativeTracks(tracks,showToast=true){
  let added=0;
  const byKey=new Map(state.tracks.map(track=>[track.key,track]));
  const updates=tracks.map(native=>{const existing=byKey.get(native.key);if(!existing)added++;return {...existing,...native,id:existing?.id||id(),file:null,handle:null}});
  await writeBatch(db,'tracks',updates);
  const byId=new Map(updates.map(track=>[track.id,track]));
  state.tracks=state.tracks.map(track=>byId.get(track.id)||track);
  state.tracks.push(...updates.filter(track=>!byKey.has(track.key)));
  render();if(showToast)toast(`${added||tracks.length} file${(added||tracks.length)===1?'':'s'} loaded from folder`);return added;
}
function saveLibraryFolders(){localStorage.setItem('nightwave-library-folders',JSON.stringify(state.libraryFolders))}
function scanStatus(progress){$('#refresh-folders').textContent=progress.phase==='discovering'?`↻ Found ${progress.discovered} files…`:`↻ Reading ${progress.completed}/${progress.total}…`}
function scanFailures(result){const count=result.failures?.length||result.unavailableFolders?.length||0;if(count)console.warn('Music scan failures:',result.failures||result.unavailableFolders);return count?` · ${count} file or folder${count===1?'':'s'} unavailable`:''}
function setScanning(value){scanning=value;$('#load-folder').disabled=value;$('#empty-load').disabled=value;$('#refresh-folders').disabled=value||!state.libraryFolders.length;if(!value)$('#refresh-folders').textContent='↻ Refresh folders'}
async function loadFolder(){
  if(window.electronAPI){
    if(scanning)return;setScanning(true);
    try{
      const result=await window.electronAPI.pickMusicFolder(scanStatus);if(!result)return;
      if(!state.libraryFolders.includes(result.directory)){state.libraryFolders.push(result.directory);saveLibraryFolders()}
      const added=await addNativeTracks(result.tracks,false);
      toast(`${added} new file${added===1?'':'s'} loaded${scanFailures(result)}.`);
    }catch(error){toast(error.message||'Could not load the music folder.')}
    finally{setScanning(false);render()}
    return;
  }
  const picker=$('#folder-input');if('webkitdirectory' in picker)picker.click();else{$('#file-input').click();toast('Your browser does not support folder selection. Select your music files instead.')}
}
async function refreshLoadedFolders(){
  if(scanning||!state.libraryFolders.length||!window.electronAPI)return;setScanning(true);
  try{const result=await window.electronAPI.refreshMusicFolders(state.libraryFolders,scanStatus),added=await addNativeTracks(result.tracks,false);toast(`${added?`${added} new file${added===1?'':'s'} found`:'Folders are up to date'}${scanFailures(result)}.`)}
  catch(error){toast(error.message||'Could not refresh the music folders.')}
  finally{setScanning(false);render()}
}
function manageLibraryFolders(){if(!state.libraryFolders.length)return;const dialog=document.createElement('dialog');dialog.className='text-dialog folder-dialog';dialog.innerHTML='<form method="dialog"><p>Refresh will scan the folders listed here. Removing a folder does not remove music already loaded in Nightwave.</p><ul class="folder-list"></ul><div><button class="dialog-primary" value="done">Done</button></div></form>';const list=dialog.querySelector('.folder-list'),paint=()=>{list.innerHTML=state.libraryFolders.map((folder,index)=>`<li><code>${escapeHTML(folder)}</code><button type="button" data-remove-folder="${index}" aria-label="Remove ${escapeHTML(folder)}">Remove</button></li>`).join('')};paint();dialog.onclick=event=>{const button=event.target.closest('[data-remove-folder]');if(!button)return;state.libraryFolders.splice(Number(button.dataset.removeFolder),1);saveLibraryFolders();render();paint()};dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal()}
async function addFiles(files){for(const file of files)await addTrack(file);render();toast(`${files.length} file${files.length===1?'':'s'} saved to your library`)}
function releaseAudio(){audio.pause();audio.removeAttribute('src');audio.load();if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);state.objectUrl=null}
// The fill ends at the thumb centre, whose travel excludes the thumb width.
function updateSongProgress(value) {
  const progress = $('#progress');
  progress.value = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  progress.style.setProperty('--progress-fraction', Number(progress.value) / 100);
}
function stopPlayback(){
  playbackRequest++;releaseAudio();state.currentId=null;playbackQueue.clear();
  $('#now-title').textContent='Nothing playing';$('#now-artist').textContent='Choose a track from your library';$('#play').textContent='▶';
  $('#current-time').textContent=$('#duration').textContent='0:00';updateSongProgress(0);$('#artwork').textContent='♫';updateMediaSession();
}
async function clearLibrary(){
  if(!state.tracks.length){toast('Your library is already empty.');return}
  closeHeaderMenus();
  if(!await askConfirm(`Unload all ${state.tracks.length} saved music file${state.tracks.length===1?'':'s'}? Your playlists will keep their song assignments when you load these files again.`,'Continue'))return;
  if(!await askConfirm('Final confirmation: this will remove every loaded track from Nightwave. Your source files and playlist assignments will remain unchanged.','Unload all music'))return;
  await writeBatch(db,'tracks',[],[],true);
  stopPlayback();state.tracks=[];state.selectedTrackIds=new Set();state.selectionAnchor=null;trackClicks.reset();render();toast('Library cleared. Playlist assignments were kept.');
}
async function removeSelectedTracks(){
  const ids=[...state.selectedTrackIds];if(!ids.length)return;const playlist=selectedPlaylist(),count=ids.length;
  if(playlist){
    if(!await askConfirm(`Remove ${count} selected track${count===1?'':'s'} from “${playlist.name}”? The audio files remain in All Music.`,'Remove tracks'))return;
    const keys=new Set(state.tracks.filter(track=>ids.includes(track.id)).map(track=>track.key));
    const updated={...playlist,trackKeys:playlistTrackKeys(playlist).filter(trackKey=>!keys.has(trackKey))};
    await put('playlists',updated);Object.assign(playlist,updated);
  }else{
    if(!await askConfirm(`Unload ${count} selected track${count===1?'':'s'} from Nightwave? The source audio files will not be deleted, and their playlist assignments will be kept.`,'Unload tracks'))return;
    await writeBatch(db,'tracks',[],ids);
    if(ids.includes(state.currentId))stopPlayback();
    state.tracks=state.tracks.filter(track=>!ids.includes(track.id));playbackQueue.prune(new Set(state.tracks.map(track=>track.id)));
  }
  state.selectedTrackIds=new Set();state.selectionAnchor=null;trackClicks.reset();render();
  toast(playlist?`${count} tracks removed from ${playlist.name}.`:`${count} tracks unloaded. Playlist assignments were kept.`);
}
async function playTrack(trackId,keepQueue=false){
  const track=state.tracks.find(t=>t.id===trackId);if(!track)return;
  if(!keepQueue)playbackQueue.start(visibleTracks().map(item=>item.id),trackId,state.shuffle);
  const request=++playbackRequest;releaseAudio();
  try{
    let source,objectUrl=null;
    if(track.path&&window.electronAPI)source=await window.electronAPI.fileUrl(track.path);
    else {if(!track.file)throw Error('File unavailable');objectUrl=URL.createObjectURL(track.file);source=objectUrl}
    if(request!==playbackRequest){if(objectUrl)URL.revokeObjectURL(objectUrl);return}
    if(!source)throw Error('File unavailable');
    state.objectUrl=objectUrl;
    audio.src=source;state.currentId=track.id;
    await audio.play();if(request!==playbackRequest)return;
    $('#now-title').textContent=track.title;$('#now-artist').textContent=track.artist;$('#play').textContent='Ⅱ';render();
  }catch(error){
    if(request!==playbackRequest)return;
    stopPlayback();render();toast('This file could not be played. Check that it is available and supported.');
  }
}
function nextTrack(back=false){
  playbackQueue.prune(new Set(state.tracks.map(track=>track.id)));
  if(!playbackQueue.order.length){const track=visibleTracks()[0];if(track)playTrack(track.id);return}
  const trackId=playbackQueue.move(back);if(trackId)playTrack(trackId,true);
}
async function newPlaylist(){ const name=await askText('Name your playlist');if(!name)return; const p={id:id(),name,trackKeys:[],order:state.playlists.length};await put('playlists',p);state.playlists.push(p);state.selected=p.id;render(); }
async function renamePlaylist(playlistId){const playlist=state.playlists.find(p=>p.id===playlistId);if(!playlist)return;const name=await askText('Rename playlist',playlist.name);if(!name||name===playlist.name)return;await put('playlists',{...playlist,name});playlist.name=name;render();}
async function deletePlaylist(playlistId){const playlist=state.playlists.find(p=>p.id===playlistId);if(!playlist||!await askConfirm(`Delete the playlist “${playlist.name}”? Its music files will stay in your library.`,'Delete playlist'))return;await del('playlists',playlistId);state.playlists=state.playlists.filter(p=>p.id!==playlistId);if(state.selected===playlistId)state.selected='all';render();toast('Playlist deleted.');}
async function songMenu(trackId,anchor){const track=state.tracks.find(item=>item.id===trackId);if(!track)return;const choice=await askSongAction(anchor,track);if(choice==='playlist')return addToPlaylist(trackId);if(choice==='lyrics')return openLyrics(track);if(choice==='artwork')return updateThumbnail(track);if(choice==='reveal'){if(track.path&&window.electronAPI)await window.electronAPI.showInFolder(track.path);else toast('This file must be loaded through the Electron folder picker first.')}}
function captureMetadataFocus(){
  const focused=document.activeElement;
  if(!focused?.closest('.inline-metadata-editor'))return null;
  return {control:focused.dataset.metadataControl,start:focused.selectionStart,end:focused.selectionEnd};
}
function restoreMetadataEditor(focus=null){
  const edit=metadataEdit;if(!edit)return;
  const row=[...document.querySelectorAll('#track-list [data-track]')].find(element=>element.dataset.track===edit.trackId);
  if(!row)return
  const cell=row.querySelector(`[data-edit="${edit.field}"]`);if(!cell)return;
  const editor=document.createElement('span');editor.className='inline-metadata-editor';
  editor.ondragstart=event=>event.stopPropagation();
  const input=document.createElement('input');input.className='metadata-input';input.type='text';input.value=edit.value;input.maxLength=10000;
  input.dataset.metadataControl='input';input.setAttribute('aria-label',`Edit ${edit.field}`);input.disabled=edit.saving;input.setAttribute('aria-invalid',String(Boolean(edit.error)));
  input.title=edit.error||'';
  input.oninput=()=>{edit.value=input.value;edit.error='';input.title='';input.setAttribute('aria-invalid','false')};
  input.onblur=()=>{if(!renderingTracks&&input.isConnected&&metadataEdit===edit&&!edit.saving)saveMetadataEdit()};
  editor.onkeydown=event=>{
    event.stopPropagation();if(event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();cancelMetadataEdit()}
    else if(event.key==='Enter'&&event.target===input){event.preventDefault();saveMetadataEdit()}
  };
  editor.append(input);cell.replaceChildren(editor);cell.classList.add('metadata-editing');row.draggable=false;
  if(focus&&!edit.saving){
    const target=editor.querySelector(`[data-metadata-control="${focus.control}"]`);target?.focus({preventScroll:true});
    if(target===input&&focus.start!=null)input.setSelectionRange(focus.start,focus.end);
  }
}
function editMetadata(trackId,field){
  const track=state.tracks.find(item=>item.id===trackId);if(!track||!['title','artist','album'].includes(field)||metadataEdit?.saving)return;
  if(!window.electronAPI||!track.path){toast('Metadata editing is available for files loaded through the Electron folder picker.');return}
  if(!/\.mp3$/i.test(track.path)){toast('Editing tags is currently supported for MP3 files only.');return}
  metadataEdit={trackId,field,value:track[field]||'',saving:false,error:''};trackClicks.reset();render();
  const input=$('#track-list .metadata-input');input?.focus({preventScroll:true});input?.select();
}
function cancelMetadataEdit(){if(metadataEdit?.saving)return;metadataEdit=null;trackClicks.reset();render()}
async function saveMetadataEdit(){
  const edit=metadataEdit;if(!edit||edit.saving)return;
  const track=state.tracks.find(item=>item.id===edit.trackId);if(!track){cancelMetadataEdit();return}
  const value=edit.value.trim();if(value===(track[edit.field]||'')){cancelMetadataEdit();return}
  edit.saving=true;edit.error='';
  const input=$('#track-list .metadata-input');if(input){input.disabled=true;input.setAttribute('aria-invalid','false')}
  try{
    const updated=await window.electronAPI.writeTags({filePath:track.path,title:track.title,artist:track.artist,album:track.album,[edit.field]:value});
    // Unloading a track during a write must not add it back to the saved library.
    const current=state.tracks.find(item=>item.id===edit.trackId);
    if(current){await put('tracks',{...current,...updated});Object.assign(current,updated)}
    if(state.currentId===track.id){$('#now-title').textContent=updated.title;$('#now-artist').textContent=updated.artist;updateMediaSession()}
    if(metadataEdit===edit)metadataEdit=null;render();toast(`${{title:'Title',artist:'Artist',album:'Album'}[edit.field]} updated.`);
  }catch(error){
    if(metadataEdit!==edit)return;edit.saving=false;edit.error=error.message||'Could not save this tag. Please try again.';
    render();toast(edit.error);$('#track-list .metadata-input')?.focus({preventScroll:true});
  }
}
async function addToPlaylist(trackId){const track=state.tracks.find(item=>item.id===trackId);if(!track)return;if(!state.playlists.length){await newPlaylist();if(!state.playlists.length)return} const name=await askText(`Add to playlist (${state.playlists.map((p,i)=>`${i+1}: ${p.name}`).join(' · ')})`);const p=state.playlists.find(p=>p.name.toLowerCase()===name?.toLowerCase())||state.playlists[Number(name)-1];if(!p){if(name)toast('Playlist not found.');return}if(!playlistTrackKeys(p).includes(track.key)){p.trackKeys=[...playlistTrackKeys(p),track.key];await put('playlists',p);toast('Added to '+p.name)}}
function toast(message){let el=document.querySelector('.toast');if(!el){el=document.createElement('div');el.className='toast';document.body.append(el)}el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2800)}
function askText(label,initial=''){
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='text-dialog';
    dialog.innerHTML='<form method="dialog"><label><span></span><input autofocus /></label><div><button type="button" data-cancel>Cancel</button><button class="dialog-primary" value="confirm">Save</button></div></form>';
    dialog.querySelector('label span').textContent=label;
    const input=dialog.querySelector('input');input.value=initial;
    document.body.append(dialog);dialog.querySelector('[data-cancel]').onclick=()=>dialog.close('cancel');
    dialog.addEventListener('close',()=>{const value=dialog.returnValue==='confirm'?input.value.trim():null;dialog.remove();resolve(value)});
    dialog.showModal();input.select();
  });
}
function askConfirm(message,action='Confirm'){return new Promise(resolve=>{const dialog=document.createElement('dialog');dialog.className='text-dialog';dialog.innerHTML=`<form method="dialog"><p>${escapeHTML(message)}</p><div><button type="button" data-cancel>Cancel</button><button class="dialog-primary" value="confirm">${escapeHTML(action)}</button></div></form>`;document.body.append(dialog);dialog.querySelector('[data-cancel]').onclick=()=>dialog.close('cancel');dialog.addEventListener('close',()=>{const accepted=dialog.returnValue==='confirm';dialog.remove();resolve(accepted)});dialog.showModal()})}
function askSongAction(anchor,track){return new Promise(resolve=>{const menu=document.createElement('div'),rect=anchor.getBoundingClientRect();menu.className='song-popover';menu.innerHTML=`<button data-action="playlist">Add to playlist</button><button data-action="lyrics">Lyrics</button><button data-action="artwork"${window.electronAPI?.searchArtwork&&track.path&&/\.mp3$/i.test(track.path)?'':' disabled title="Available for MP3 files loaded from a folder"'}>Update thumbnail</button><button data-action="reveal">Show in file manager</button>`;document.body.append(menu);const width=menu.offsetWidth,height=menu.offsetHeight;menu.style.left=`${Math.max(10,Math.min(window.innerWidth-width-10,rect.right-width))}px`;menu.style.top=`${Math.max(10,Math.min(window.innerHeight-height-10,rect.bottom+6))}px`;const close=action=>{menu.remove();document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',escape);resolve(action)};const outside=event=>{if(!menu.contains(event.target)&&event.target!==anchor)close('cancel')};const escape=event=>{if(event.key==='Escape')close('cancel')};menu.onclick=event=>{const button=event.target.closest('[data-action]');if(button&&!button.disabled)close(button.dataset.action)};setTimeout(()=>{document.addEventListener('mousedown',outside);document.addEventListener('keydown',escape)},0)})}
function updateThumbnail(track){
  if(!window.electronAPI?.searchArtwork||!track.path||!/\.mp3$/i.test(track.path)){toast('Saving album covers is available for MP3 files loaded from a folder.');return}
  const dialog=document.createElement('dialog');dialog.className='text-dialog artwork-dialog';
  dialog.innerHTML='<h2>Update thumbnail</h2><p>Choose a cover to save into this MP3. It will replace the existing embedded cover.</p><form class="artwork-search"><label>Song<input name="title" maxlength="200" required></label><label>Artist<input name="artist" maxlength="200" required></label><button class="dialog-primary" type="submit">Search</button></form><p class="artwork-status" role="status" aria-live="polite"></p><div class="artwork-results"></div><p class="artwork-source">Covers from MusicBrainz / Cover Art Archive</p><div class="artwork-dialog-actions"><button type="button" data-cancel>Cancel</button></div>';
  const form=dialog.querySelector('form'),title=form.elements.title,artist=form.elements.artist,status=dialog.querySelector('.artwork-status'),results=dialog.querySelector('.artwork-results'),cancel=dialog.querySelector('[data-cancel]');
  title.value=track.title||'';artist.value=track.artist==='Unknown artist'?'':track.artist||'';
  let requestId=0,saving=false;
  const setBusy=busy=>{form.querySelectorAll('input,button').forEach(control=>control.disabled=busy);results.querySelectorAll('button').forEach(button=>button.disabled=busy)};
  cancel.onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault()});
  dialog.addEventListener('close',()=>{requestId++;dialog.remove()},{once:true});
  async function search(){
    if(!form.reportValidity())return;
    const request=++requestId;setBusy(true);results.replaceChildren();status.textContent='Searching for album covers…';
    try{
      const covers=await window.electronAPI.searchArtwork({filePath:track.path,title:title.value.trim(),artist:artist.value.trim(),album:track.album||''});
      if(!dialog.open||request!==requestId)return;
      status.textContent=covers.length?'Choose the correct album cover below.':'No matching covers found. Try adjusting the song or artist name.';
      for(const cover of covers){
        const card=document.createElement('div');card.className='artwork-result';
        const image=document.createElement('img');image.src=cover.preview;image.alt=`Cover for ${cover.album}`;
        const name=document.createElement('strong');name.textContent=cover.album;
        const detail=document.createElement('span');detail.textContent=`${cover.title} · ${cover.artist}`;
        const save=document.createElement('button');save.type='button';save.className='dialog-primary';save.textContent='Save cover';save.setAttribute('aria-label',`Save cover for ${cover.album}`);
        save.onclick=async()=>{
          if(saving)return;saving=true;setBusy(true);cancel.disabled=true;status.textContent='Saving cover into the song file…';
          try{
            const updated=await window.electronAPI.saveArtwork({filePath:track.path,token:cover.token});
            const current=state.tracks.find(item=>item.id===track.id);
            if(current){await put('tracks',{...current,...updated});Object.assign(current,updated)}
            render();dialog.close();toast('Album cover saved into the song file.');
          }catch(error){status.textContent=error.message||'Could not save this cover. Try again.'}
          finally{saving=false;cancel.disabled=false;setBusy(false)}
        };
        card.append(image,name,detail,save);results.append(card);
      }
    }catch(error){if(dialog.open&&request===requestId)status.textContent=error.message||'Cover search failed. Check your connection and try again.'}
    finally{if(dialog.open&&request===requestId)setBusy(false)}
  }
  form.onsubmit=event=>{event.preventDefault();search()};
  document.body.append(dialog);dialog.showModal();
  if(title.value&&artist.value)search();else status.textContent='Enter the song title and artist to search for a cover.';
}
let lyricsRequestId=0;
async function openLyrics(track){const panel=$('#lyrics-panel'),requestId=++lyricsRequestId;panel.hidden=false;$('.app-shell').classList.add('lyrics-open');$('#lyrics-title').textContent=track.title;$('#lyrics-artist').textContent=track.artist||'Unknown artist';$('#lyrics-status').textContent='Searching for lyrics…';$('#lyrics-text').hidden=true;$('#lyrics-text').textContent='';$('#lyrics-credit').hidden=true;if(!window.electronAPI?.findLyrics){$('#lyrics-status').textContent='Lyrics are available in the desktop app.';return}const result=await window.electronAPI.findLyrics({title:track.title,artist:track.artist,album:track.album,duration:track.duration});if(requestId!==lyricsRequestId)return;if(result.status==='found'){if(result.title!==track.title||result.artist!==track.artist)$('#lyrics-status').textContent=`Found: ${result.title} — ${result.artist}`;else $('#lyrics-status').textContent='';$('#lyrics-text').textContent=result.lyrics;$('#lyrics-text').hidden=false;$('#lyrics-credit').hidden=false}else $('#lyrics-status').textContent=result.status==='not-found'?'No lyrics were found for this song.':'Lyrics could not be reached. Check your internet connection and try again.'}
function paintSelection(){document.querySelectorAll('#track-list [data-track]').forEach(row=>row.classList.toggle('selected-track',state.selectedTrackIds.has(row.dataset.track)))}
function selectTracks(trackId,event){const tracks=visibleTracks(),ids=tracks.map(track=>track.id);if(event.shiftKey&&state.selectionAnchor){const start=ids.indexOf(state.selectionAnchor),end=ids.indexOf(trackId);if(start>=0&&end>=0)state.selectedTrackIds=new Set(ids.slice(Math.min(start,end),Math.max(start,end)+1));}else if(event.ctrlKey||event.metaKey){if(state.selectedTrackIds.has(trackId))state.selectedTrackIds.delete(trackId);else state.selectedTrackIds.add(trackId);state.selectedTrackIds=new Set(state.selectedTrackIds);state.selectionAnchor=trackId;}else{state.selectedTrackIds=new Set([trackId]);state.selectionAnchor=trackId;}paintSelection();}
function showPlayingTrack(){if(!state.currentId){toast('Nothing is playing.');return}const track=state.tracks.find(item=>item.id===state.currentId),playlist=selectedPlaylist();if(!track){toast('The playing track is no longer in your library.');return}setAppView('library');if(playlist&&!playlistTrackKeys(playlist).includes(track.key))state.selected='all';state.query='';$('#search').value='';state.selectedTrackIds=new Set([state.currentId]);state.selectionAnchor=state.currentId;render();requestAnimationFrame(()=>document.querySelector(`#track-list [data-track="${state.currentId}"]`)?.scrollIntoView({behavior:'smooth',block:'center'}));}
function showSyncProgress(total){const panel=document.createElement('div'),title=document.createElement('strong'),detail=document.createElement('span'),bar=document.createElement('progress');panel.className='sync-progress';panel.setAttribute('role','status');panel.setAttribute('aria-live','polite');title.textContent='Syncing to phone';detail.textContent=`Preparing ${total} track${total===1?'':'s'}…`;bar.max=total;bar.value=0;panel.append(title,detail,bar);document.body.append(panel);return {update:({completed,fileName})=>{bar.value=completed;detail.textContent=`${Math.min(completed+1,total)} of ${total} · ${fileName}`},remove:()=>panel.remove()}}
async function syncPlaylistToPhone(){const playlist=selectedPlaylist();if(!playlist)return;const tracks=state.tracks.filter(track=>playlistTrackKeys(playlist).includes(track.key)&&track.path);if(!tracks.length){toast('This playlist has no tracks available to sync. Load its music from a folder first.');return}if(!await askConfirm(`Copy ${tracks.length} track${tracks.length===1?'':'s'} from “${playlist.name}” to a matching folder in your phone’s Music directory? Songs use distinct filenames, and verified existing copies are skipped. Older copies made by previous versions are kept.`,'Sync to phone'))return;const button=$('#sync-playlist'),progress=showSyncProgress(tracks.length);button.disabled=true;button.querySelector('span').textContent='Syncing…';try{const result=await window.electronAPI.syncToPhone({filePaths:tracks.map(track=>track.path),playlistName:playlist.name},progress.update);const summary=`${result.copied} copied${result.skipped?`, ${result.skipped} already on phone`:''}${result.failed.length?`, ${result.failed.length} failed`:''}.`;toast(summary);if(result.failed.length)console.warn('Phone sync failures:',result.failed)}catch(error){toast(error.message||'Could not sync to the phone.')}finally{progress.remove();button.disabled=false;button.querySelector('span').textContent='Sync to phone'}}

$('#load-folder').onclick=$('#empty-load').onclick=loadFolder; $('#add-files').onclick=()=>$('#file-input').click();$('#clear-library').onclick=clearLibrary;$('#show-playing').onclick=showPlayingTrack;$('#sync-playlist').onclick=syncPlaylistToPhone;$('#file-input').onchange=async e=>{await addFiles(e.target.files);e.target.value=''};$('#folder-input').onchange=async e=>{await addFiles(e.target.files);e.target.value=''};$('#new-playlist').onclick=newPlaylist;
$('#close-lyrics').onclick=()=>{$('#lyrics-panel').hidden=true;$('.app-shell').classList.remove('lyrics-open');lyricsRequestId++};
$('#refresh-folders').onclick=refreshLoadedFolders;$('#manage-folders').onclick=manageLibraryFolders;
function closeHeaderMenus(){document.querySelectorAll('.header-menu[open]').forEach(menu=>menu.open=false)}
document.addEventListener('click',event=>{
  if(!event.target.closest('.header-menu')||event.target.closest('.header-dropdown button'))closeHeaderMenus();
});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  const menu=document.querySelector('.header-menu[open]');
  if(menu){event.preventDefault();closeHeaderMenus();menu.querySelector('summary').focus();return}
  if($('.app-shell').classList.contains('visualizer-view')&&!document.querySelector('dialog[open]')&&!event.target.closest?.('input,textarea,[contenteditable]')){
    event.preventDefault();setAppView('library');$('#view-menu summary').focus();
  }
});
function setEqualizerVisible(visible){
  $('#sidebar-visualizer').hidden=!visible||$('.app-shell').classList.contains('visualizer-view');
  $('#show-equalizer').setAttribute('aria-pressed',String(visible));
  localStorage.setItem('nightwave-show-equalizer',String(visible));
}
setEqualizerVisible(localStorage.getItem('nightwave-show-equalizer')!=='false');
$('#show-equalizer').onclick=()=>setEqualizerVisible($('#show-equalizer').getAttribute('aria-pressed')!=='true');
function setAppView(view){
  const visualizer=view==='visualizer';
  $('.app-shell').classList.toggle('visualizer-view',visualizer);
  $('.sidebar').hidden=visualizer;$('.main-content').hidden=visualizer;
  $('#tunnel-visualizer').hidden=!visualizer;
  $('#view-library').setAttribute('aria-pressed',String(!visualizer));
  $('#view-visualizer').setAttribute('aria-pressed',String(visualizer));
  $('#show-equalizer').disabled=visualizer;
  setEqualizerVisible(localStorage.getItem('nightwave-show-equalizer')!=='false');
  localStorage.setItem('nightwave-view',visualizer?'visualizer':'library');
}
$('#view-library').onclick=$('#visualizer-library').onclick=()=>setAppView('library');
$('#view-visualizer').onclick=()=>setAppView('visualizer');
setAppView(localStorage.getItem('nightwave-view')==='visualizer'?'visualizer':'library');
const setMaximizeButton=maximized=>{const button=$('#window-maximize');button.textContent=maximized?'❐':'□';button.title=maximized?'Restore':'Maximize';button.setAttribute('aria-label',button.title+' window')};$('#window-minimize').onclick=()=>window.electronAPI?.minimizeWindow();$('#window-maximize').onclick=async()=>setMaximizeButton(await window.electronAPI?.toggleMaximizeWindow());$('#window-close').onclick=()=>window.electronAPI?.closeWindow();window.electronAPI?.onWindowMaximized(setMaximizeButton);
$('#sidebar-resizer').onpointerdown=e=>{e.preventDefault();const resizer=e.currentTarget;resizer.setPointerCapture(e.pointerId);document.body.classList.add('resizing-sidebar');const resize=event=>{const width=Math.max(sidebarMin,Math.min(sidebarMax,event.clientX));document.documentElement.style.setProperty('--sidebar-width',`${width}px`);localStorage.setItem('nightwave-sidebar-width',width)};const stop=event=>{document.body.classList.remove('resizing-sidebar');resizer.releasePointerCapture(event.pointerId);resizer.removeEventListener('pointermove',resize);resizer.removeEventListener('pointerup',stop);resizer.removeEventListener('pointercancel',stop)};resizer.addEventListener('pointermove',resize);resizer.addEventListener('pointerup',stop);resizer.addEventListener('pointercancel',stop)};
$('#lyrics-resizer').onpointerdown=e=>{e.preventDefault();const resizer=e.currentTarget;resizer.setPointerCapture(e.pointerId);document.body.classList.add('resizing-lyrics');const resize=event=>{const width=Math.max(lyricsMin,Math.min(lyricsMax,window.innerWidth-event.clientX));document.documentElement.style.setProperty('--lyrics-width',`${width}px`);localStorage.setItem('nightwave-lyrics-width',width)};const stop=event=>{document.body.classList.remove('resizing-lyrics');resizer.releasePointerCapture(event.pointerId);resizer.removeEventListener('pointermove',resize);resizer.removeEventListener('pointerup',stop);resizer.removeEventListener('pointercancel',stop)};resizer.addEventListener('pointermove',resize);resizer.addEventListener('pointerup',stop);resizer.addEventListener('pointercancel',stop)};
$('#playlist-list').onclick=async e=>{const rename=e.target.closest('[data-rename]');if(rename){await renamePlaylist(rename.dataset.rename);return}const remove=e.target.closest('[data-delete]');if(remove){await deletePlaylist(remove.dataset.delete);return}const b=e.target.closest('[data-playlist]');if(b){state.selected=b.dataset.playlist;state.selectedTrackIds=new Set();state.selectionAnchor=null;render()}};
// Save before another row or navigation action can hide the active field.
document.addEventListener('click',event=>{
  if(metadataEdit&&!metadataEdit.saving&&!event.target.closest('.inline-metadata-editor'))saveMetadataEdit();
},true);
$('#track-list').onclick=e=>{
  if(e.target.closest('.inline-metadata-editor'))return;
  const menu=e.target.closest('[data-menu]');if(menu){trackClicks.reset();songMenu(menu.dataset.menu,menu);return}
  const row=e.target.closest('[data-track]');if(!row){trackClicks.reset();return}
  const field=e.target.closest('[data-edit]')?.dataset.edit;
  const action=trackClicks.click(row.dataset.track,field,e.timeStamp,e.shiftKey||e.ctrlKey||e.metaKey);
  selectTracks(row.dataset.track,e);
  if(action==='play')playTrack(row.dataset.track);
  else if(action==='edit')editMetadata(row.dataset.track,field);
};
// Both actions are classified from click timing; native dblclick must not trigger a second action.
$('#track-list').ondblclick=e=>{if(!e.target.closest('.inline-metadata-editor'))e.preventDefault()};
$('#track-list').ondragstart=e=>{
  const row=e.target.closest('[data-track]');if(!row)return;
  if(!row.draggable||e.target.closest('.inline-metadata-editor,[data-menu]')){e.preventDefault();return}
  trackClicks.reset();
  const ids=state.selectedTrackIds.has(row.dataset.track)?[...state.selectedTrackIds]:[row.dataset.track];
  if(!state.selectedTrackIds.has(row.dataset.track)){state.selectedTrackIds=new Set(ids);state.selectionAnchor=row.dataset.track;paintSelection()}
  const tracks=state.tracks.filter(track=>ids.includes(track.id));
  // Native drags carry actual files, including when dropped back onto our playlists.
  if(window.electronAPI&&tracks.length&&tracks.every(track=>track.path)){
    e.preventDefault();window.electronAPI.startExternalDrag(tracks.map(track=>track.path));return;
  }
  e.dataTransfer.setData('text/plain',JSON.stringify(ids));e.dataTransfer.effectAllowed='copy';row.classList.add('dragging');
};
$('#track-list').ondragend=e=>{e.target.closest('[data-track]')?.classList.remove('dragging');document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'))};
$('#playlist-list').ondragstart=e=>{const row=e.target.closest('[data-playlist-row]');if(!row||e.target.closest('.playlist-actions'))return;e.dataTransfer.setData('application/x-nightwave-playlist',row.dataset.playlistRow);e.dataTransfer.effectAllowed='move';row.classList.add('dragging')};
$('#playlist-list').ondragend=e=>{e.target.closest('[data-playlist-row]')?.classList.remove('dragging');document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'))};
$('#playlist-list').ondragover=e=>{const row=e.target.closest('[data-playlist-row]');if(!row)return;e.preventDefault();const reordering=Array.from(e.dataTransfer.types).includes('application/x-nightwave-playlist');e.dataTransfer.dropEffect=reordering?'move':'copy';document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));row.classList.add('drop-target')};
$('#playlist-list').ondragleave=e=>{if(!e.currentTarget.contains(e.relatedTarget))document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'))};
$('#playlist-list').ondrop=async e=>{
  e.preventDefault();trackClicks.reset();
  const row=e.target.closest('[data-playlist-row]'),sourceId=e.dataTransfer.getData('application/x-nightwave-playlist');
  document.querySelectorAll('.drop-target').forEach(el=>el.classList.remove('drop-target'));if(!row)return;
  if(sourceId){
    const from=state.playlists.findIndex(playlist=>playlist.id===sourceId),to=state.playlists.findIndex(playlist=>playlist.id===row.dataset.playlistRow);
    if(from<0||to<0||from===to)return;
    const reordered=[...state.playlists], [playlist]=reordered.splice(from,1);reordered.splice(to,0,playlist);
    const updates=reordered.map((item,index)=>({...item,order:index}));
    await writeBatch(db,'playlists',updates);state.playlists=updates;render();toast('Playlist order saved.');return;
  }
  let trackIds=[];
  if(e.dataTransfer.files.length&&window.electronAPI){
    const paths=new Set(Array.from(e.dataTransfer.files,file=>window.electronAPI.getPathForFile(file)));
    trackIds=state.tracks.filter(track=>track.path&&paths.has(track.path)).map(track=>track.id);
  }else{try{trackIds=JSON.parse(e.dataTransfer.getData('text/plain'))}catch{trackIds=[e.dataTransfer.getData('text/plain')]}}
  if(!Array.isArray(trackIds)||!trackIds.length)return;
  const playlist=state.playlists.find(p=>p.id===row.dataset.playlistRow);if(!playlist)return;
  const keys=[...new Set(state.tracks.filter(track=>trackIds.includes(track.id)).map(track=>track.key))];if(!keys.length)return;
  const added=keys.filter(trackKey=>!playlistTrackKeys(playlist).includes(trackKey));
  if(!added.length){toast('Those tracks are already in this playlist.');return}
  const updated={...playlist,trackKeys:[...playlistTrackKeys(playlist),...added]};
  await put('playlists',updated);Object.assign(playlist,updated);toast(`${added.length} track${added.length===1?'':'s'} added to ${playlist.name}`);
};
$('.track-header').onclick=e=>{const button=e.target.closest('[data-sort]');if(!button)return;const key=button.dataset.sort;state.sort={key,direction:state.sort.key===key&&state.sort.direction==='asc'?'desc':'asc'};render()};
$('#search').oninput=e=>{state.query=e.target.value;render()};
$('.nav-item').onclick=()=>{state.selected='all';state.selectedTrackIds=new Set();state.selectionAnchor=null;render()};$('#play-all').onclick=()=>{const t=visibleTracks()[0];if(t)playTrack(t.id)};
document.addEventListener('keydown',e=>{const target=e.target;if(e.key!=='Delete'||target.matches('input,textarea,[contenteditable]')||document.querySelector('dialog[open]'))return;if(!state.selectedTrackIds.size)return;e.preventDefault();removeSelectedTracks()});
async function togglePlayback(){if(!state.currentId){const track=visibleTracks()[0];if(track)await playTrack(track.id);return}if(audio.paused){try{await audio.play();$('#play').textContent='Ⅱ'}catch{toast('Playback could not be resumed.')}}else{audio.pause();$('#play').textContent='▶'}}
function updateMediaSession(){if(!('mediaSession' in navigator))return;const track=state.tracks.find(item=>item.id===state.currentId);navigator.mediaSession.playbackState=track&&!audio.paused?'playing':track?'paused':'none';if(track&&'MediaMetadata' in window)navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist,album:track.album});else if(!track)navigator.mediaSession.metadata=null}
function setupMediaSession(){if(!('mediaSession' in navigator))return;const handlers={play:()=>{if(audio.paused)togglePlayback()},pause:()=>{if(!audio.paused)togglePlayback()},previoustrack:()=>nextTrack(true),nexttrack:()=>nextTrack()};for(const [action,handler] of Object.entries(handlers)){try{navigator.mediaSession.setActionHandler(action,handler)}catch{}}}
$('#play').onclick=togglePlayback;$('#next').onclick=()=>nextTrack();$('#previous').onclick=()=>nextTrack(true);window.electronAPI?.onPlaybackCommand(command=>{if(command==='toggle')togglePlayback();else if(command==='next')nextTrack();else if(command==='previous')nextTrack(true)});setupMediaSession();$('#shuffle').onclick=e=>{state.shuffle=!state.shuffle;playbackQueue.setShuffle(state.shuffle);e.currentTarget.classList.toggle('active',state.shuffle)};$('#repeat').onclick=e=>{state.repeat=!state.repeat;e.currentTarget.classList.toggle('active',state.repeat)};
audio.ontimeupdate=()=>{const value=audio.duration?audio.currentTime/audio.duration*100:0;updateSongProgress(value);$('#current-time').textContent=time(audio.currentTime)};audio.onloadedmetadata=()=>{$('#duration').textContent=time(audio.duration)};audio.onplay=updateMediaSession;audio.onpause=updateMediaSession;audio.onended=()=>state.repeat?(audio.currentTime=0,audio.play()):nextTrack();$('#progress').oninput=e=>{updateSongProgress(Number(e.target.value));if(Number.isFinite(audio.duration)&&audio.duration>0){audio.currentTime=audio.duration*(e.target.value/100);$('#current-time').textContent=time(audio.currentTime)}};const savedVolumeValue=localStorage.getItem('nightwave-volume'),savedVolume=Number(savedVolumeValue),initialVolume=savedVolumeValue!==null&&Number.isFinite(savedVolume)&&savedVolume>=0&&savedVolume<=1?savedVolume:.8,volumeControl=$('#volume');audio.volume=initialVolume;volumeControl.value=initialVolume;volumeControl.style.setProperty('--value',`${initialVolume*100}%`);volumeControl.oninput=e=>{audio.volume=e.target.value;volumeControl.style.setProperty('--value',`${audio.volume*100}%`);localStorage.setItem('nightwave-volume',audio.volume)};
const looksTemporaryTitle = value => /^(?:video[_ -]?download|download[_ -]?(?:temp|video)?|temp(?:orary)?|unknown|untitled)[_ -]*/i.test(String(value||'').trim());
async function refreshSavedMetadata(){
  // Older library entries lack the artwork field. Read them once in the background.
  let changed=0;
  for(const track of [...state.tracks]){
    if(!track.file&&!(window.electronAPI&&track.path&&(track.artwork===undefined||looksTemporaryTitle(track.title))))continue;
    try{
      const metadata=track.file?await trackMetadata(track.file):await window.electronAPI.readTrack(track.path);
      if(!state.tracks.includes(track))continue;
      if(track.title!==metadata.title||track.artist!==metadata.artist||track.album!==metadata.album||track.artwork!==metadata.artwork){
        Object.assign(track,metadata);await put('tracks',track);if(++changed%20===0)render();
      }
    }catch{}
  }
  render();
}
async function migratePlaylists(){const keyForId=new Map(state.tracks.map(track=>[track.id,track.key]));let changed=false;state.playlists.sort((a,b)=>(a.order??Number.MAX_SAFE_INTEGER)-(b.order??Number.MAX_SAFE_INTEGER));for(const [index,playlist] of state.playlists.entries()){if(!Array.isArray(playlist.trackKeys)){playlist.trackKeys=(playlist.trackIds||[]).map(trackId=>keyForId.get(trackId)).filter(Boolean);delete playlist.trackIds;changed=true}if(playlist.order!==index){playlist.order=index;changed=true}}if(changed)await writeBatch(db,'playlists',state.playlists)}
(async()=>{db=await openDB();state.tracks=await all('tracks');state.playlists=await all('playlists');await migratePlaylists();render();const legacyCount=state.tracks.filter(track=>!track.file&&!track.path).length;if(legacyCount)toast(`${legacyCount} older ${legacyCount===1?'track needs':'tracks need'} to be loaded again to read their tags.`);refreshSavedMetadata()})().catch(()=>toast('Storage could not be opened.'));
window.addEventListener('unhandledrejection',event=>{console.error(event.reason);toast(event.reason?.message||'The operation could not be saved. Please try again.');event.preventDefault()});
window.addEventListener('beforeunload',()=>{playbackRequest++;releaseAudio()});
