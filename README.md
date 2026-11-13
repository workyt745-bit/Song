# Pulse

A fast, lightweight, good-looking music player for your own song files (MP3, M4A, FLAC, OGG, WAV).

## Get the installer (pick one)

**On your Windows PC**
1. Install Node.js (LTS) from https://nodejs.org
2. Install Rust from https://rustup.rs (accept the C++ Build Tools step)
3. Double-click `build-windows.bat`
4. Open the folder it shows and run `Pulse_0.1.0_x64-setup.exe`

**Without installing anything**
Upload this folder to a GitHub repository, open Actions, run "Build Pulse for Windows", and download the installer from the finished run.

## Adding music
- **Add music** (bottom left) lets you add songs (one or hundreds) or a whole folder.
- Or just drag and drop songs and folders anywhere into the window.
- Pulse remembers everything. It opens instantly and only re-reads files that changed.

## Shortcuts
| Key | Action |
| --- | --- |
| Space | Play / pause |
| Left / Right | Seek 5 seconds |
| Ctrl + Left / Right | Previous / next song |
| Up / Down | Volume |
| M | Mute |
| L | Like current song |
| S / R | Shuffle / repeat |
| Q | Show queue |
| F | Full screen player (Esc to close) |
| / or Ctrl + F | Search |

Right-click any song, album or playlist for more actions.

## How it stays light
- Native Rust back end reads tags and builds small 320 px cover thumbnails once, then caches them.
- The song list only draws the rows you can see, so 10,000 songs cost the same as 20.
- No frameworks, no background animation, no blur effects.
- Progress updates only run while a song plays and the window is visible.

## Preview the design in a browser
Open `src/index.html` in Chrome. It starts with demo songs; click "Try with your own songs" and pick your music folder to play your real files (nothing is uploaded).

## Project layout
- `src/` the interface (HTML, CSS, JavaScript)
- `src-tauri/src/library.rs` scanning, tags, cover art, dominant colour
- `src-tauri/src/lib.rs` the app shell and commands
