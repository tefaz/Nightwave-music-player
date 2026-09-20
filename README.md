# Nightwave Music Player

Nightwave is a local desktop music player built with Electron. It lets you load a music folder, organize songs into playlists, and play your collection without uploading your library to a streaming service.

![Nightwave showing a playlist, active playback controls, and phone sync progress](https://raw.githubusercontent.com/tefaz/Nightwave-music-player/362bf66fb2095032b4b50353febcbc37350786f1/Nightwave.png)

## Features

- Load an entire music folder, including nested folders
- Play MP3, M4A, WAV, OGG, FLAC, AAC, and Opus files
- Search and sort the music library
- Create, rename, delete, and reorder playlists
- Drag songs into playlists
- Keep playlist memberships when songs are unloaded and loaded again
- Edit title, artist, and album tags in MP3 files
- Show a song in the system file manager
- Shuffle, repeat, seek, and control volume
- Sync a playlist to an MTP-connected phone on Linux with GIO or KDE KIO
- Store library and playlist data locally on the device

## Run locally

Install [Node.js](https://nodejs.org/) and npm, then run:

```bash
npm install
npm start
```

## Install on Linux

Download a release asset from GitHub—there is no need to install Node.js or clone this repository.

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
5. Double-click a song to play it.

Your library and playlists are saved locally with the app. If you clear or unload the library, playlist assignments are retained and return when the same files are loaded again.

## Phone sync

Phone sync is designed for Linux desktop environments with an MTP-capable file manager integration. Connect and unlock your phone, select **File transfer**, open a playlist, and choose **Sync to phone**. Nightwave copies the playlist into a matching folder under the phone's `Music` directory and skips files that are already present.

For KDE systems, Nightwave can fall back to `kioclient5` when GIO cannot access the connected phone.

## Project structure

| File or folder | Purpose |
| --- | --- |
| `app.js` | Renderer UI, playback, library, playlist, and local storage logic |
| `main.js` | Electron main process, music-folder scanning, metadata, and phone sync |
| `preload.js` | Secure renderer-to-main-process API bridge |
| `index.html` and `styles.css` | Application interface and visual styling |
| `assets/` | App icon and visual assets |
| `vendor/` | Browser-side metadata parsing dependency |

## Development

The project currently has no automated test suite. Before committing JavaScript changes, run:

```bash
node --check app.js
node --check main.js
node --check preload.js
```
