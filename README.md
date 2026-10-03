# Nightwave Music Player

Nightwave is a local desktop music player built with Electron. It lets you load a music folder, organize songs into playlists, and play your collection without uploading your library to a streaming service.

![Nightwave showing a playlist, active playback controls, and phone sync progress](https://raw.githubusercontent.com/tefaz/Nightwave-music-player/362bf66fb2095032b4b50353febcbc37350786f1/Nightwave.png)

## Features

- Load an entire music folder, including nested folders
- Play MP3, M4A, WAV, OGG, FLAC, AAC, and Opus files
- Show embedded album covers in song rows and the current-song player
- Search for album covers from each song's menu and save a chosen cover into its MP3
- Search and sort the music library
- Create, rename, delete, and reorder playlists
- Drag songs into playlists
- Drag a locally loaded song directly onto another desktop app to open its source file there
- Keep playlist memberships when songs are unloaded and loaded again
- Edit title, artist, and album tags in MP3 files
- Show a song in the system file manager
- Shuffle, repeat, seek, and control volume
- View a live sunset-colored audio spectrum in the sidebar
- Sync a playlist to an MTP-connected phone on Linux with GIO or KDE KIO
- Store library and playlist data locally on the device

## Run from source (for development)

Use these instructions only if you have cloned this repository and want to run or develop Nightwave from its source code. Install [Node.js](https://nodejs.org/) and npm, then run:

```bash
npm install
npm start
```

## Install on Linux (no source code required)

For normal use, skip the **Run from source** section. Download a release asset from GitHub instead—there is no need to install Node.js, clone this repository, or run any source code.

- **AppImage**: works across many Linux distributions. Make the downloaded file executable, then open it:

  ```bash
  chmod +x Nightwave-*.AppImage
  ./Nightwave-*.AppImage
  ```

- **Debian/Ubuntu package**: install the downloaded `.deb` file with:

  ```bash
  sudo apt install ./nightwave-music-player_*.deb
  ```

## Using Nightwave

1. Choose **Add a music folder** and select the folder containing your music.
2. Create a playlist with the **+** button in the sidebar.
3. Drag songs from **All music** or one playlist onto another playlist, or use the song options menu. Dragging adds the songs to the destination playlist and keeps them in the original one.
4. Drag playlist rows in the sidebar to arrange them in the order you prefer.
5. Double-click a song quickly to play it. To edit a title, artist, or album in an MP3 song row, click the same field twice more slowly: clicks up to 300 ms apart play; clicks more than 300 ms and up to 900 ms apart open an inline editor. Press Enter or click ✓ to save directly to the source MP3; press Escape or click × to cancel. Switching to a view that hides the row cancels an unsaved edit. Ctrl/Cmd-click and Shift-click remain selection gestures.

Playback keeps the queue you started, even when you filter, sort, or browse another playlist. Shuffle plays each queued song once per cycle, and Previous retraces that order. Folder scans show progress, retain readable songs when a subfolder is unavailable, and reuse metadata for files that have not changed during the current session.

For MP3 files loaded from a folder, open the song's three-dot menu and choose **Update thumbnail**. The app searches MusicBrainz and Cover Art Archive using the song and artist names, with matches to the existing album shown first. You can adjust the search names without changing the song's tags. Choose **Save cover** to replace the embedded front cover and update the row and player thumbnails. Searching or cancelling does not modify the file. Other embedded pictures and the song's text tags are retained. This action requires an internet connection; embedding covers in other audio formats is not supported yet.

Your library and playlists are saved locally with the app. If you clear or unload the library, playlist assignments are retained and return when the same files are loaded again.

## Phone sync

Phone sync is designed for Linux desktop environments with an MTP-capable file manager integration. Connect and unlock your phone, select **File transfer**, open a playlist, and choose **Sync to phone**. Nightwave copies the playlist into a matching folder under the phone's `Music` directory. Destination filenames include a short content fingerprint, so different songs with the same filename can coexist and changed source files get distinct copies. Existing copies are checked before they are skipped, and incomplete copies are retried.

Sync remains additive: it does not delete music from your phone. Files copied by older Nightwave versions keep their original names and may coexist with the new copies on the first sync after upgrading.

For KDE systems, Nightwave can fall back to `kioclient5` when GIO cannot access the connected phone.

## Project structure

| File or folder | Purpose |
| --- | --- |
| `app.js` | Renderer UI, playback, library, playlist, and local storage logic |
| `main.js` | Electron main process, music-folder scanning, metadata, and phone sync |
| `preload.js` | Secure renderer-to-main-process API bridge |
| `renderer-core.js` | Transaction handling, playback queues, text escaping, and click timing |
| `music-library.js` | Bounded scanning and metadata caching |
| `artwork-search.js` | Online cover lookup, bounded downloads, and temporary cover selections |
| `visualizer.js` | Live audio analysis and the sidebar spectrum canvas |
| `phone-sync.js` | File fingerprints and verified phone transfers |
| `tag-worker.js` | Tag writes outside the Electron main thread |
| `index.html` and `styles.css` | Application interface and visual styling |
| `assets/` | App icon and visual assets |
| `vendor/` | Browser-side metadata parsing dependency |

## Development

Run the regression suite and JavaScript syntax checks before committing changes:

```bash
npm test
node --check app.js
node --check main.js
node --check preload.js
```

`npm run test:electron` runs isolated desktop checks with temporary app storage, including actual IndexedDB rollback, metadata quoting, playback, and the preload bridge. This headless test command disables Chromium's OS sandbox for constrained test environments; normal `npm start` does not. Phone transfers use mocked backends in the regression suite and still need verification with a connected device.
