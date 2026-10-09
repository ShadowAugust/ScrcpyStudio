<p align="center">
  <img src="docs/art/banner.png" alt="Scrcpy Studio" width="100%">
</p>

<p align="center">
  <a href="https://github.com/ShadowAugust/ScrcpyStudio/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ShadowAugust/ScrcpyStudio?style=for-the-badge&color=7c5cff&label=release"></a>
  <a href="https://github.com/ShadowAugust/ScrcpyStudio/releases/latest"><img alt="Downloads" src="https://img.shields.io/github/downloads/ShadowAugust/ScrcpyStudio/total?style=for-the-badge&color=0ea5e9"></a>
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-10b981?style=for-the-badge&logo=windows11&logoColor=white">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/ShadowAugust/ScrcpyStudio?style=for-the-badge&color=f59e0b"></a>
</p>

<p align="center">
  <a href="https://github.com/ShadowAugust/ScrcpyStudio/releases/latest/download/ScrcpyStudio-Setup.exe"><img src="docs/art/download.png" alt="Download for Windows" width="390"></a>
  <a href="https://github.com/ShadowAugust/ScrcpyStudio/releases/latest/download/ScrcpyStudio-Portable.exe"><img src="docs/art/portable.png" alt="Portable exe" width="270"></a>
</p>

<p align="center">
  A polished desktop app for <a href="https://github.com/Genymobile/scrcpy">scrcpy</a> and adb: mirror and control your Android,<br>
  use its camera like a pro webcam, and turn the phone into your PC's <b>webcam, microphone and speakers</b>.
</p>

<p align="center">
  <img src="docs/art/hero.png" alt="Camera Studio and Phone Link" width="100%">
</p>

## ✨ Highlights

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/phone-link.png" alt="Phone Link" align="right" width="190">
      <h3>📱 Phone Link</h3>
      One small window, three switches: your phone as <b>webcam</b>, <b>microphone</b> and <b>speakers</b> for Discord, Zoom, Teams, OBS, vMix and any Windows app.
      Each part runs only while it is on, so the phone stays cool.
      <br><br>
      Live preview, lens switching, tap to focus, zoom, exposure, white balance, torch, plus its own desktop shortcut.
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/camera.png" alt="Camera Studio">
      <h3>📸 Camera Studio</h3>
      Pro-mode control of the phone camera while it streams: ISO, shutter, manual focus, Kelvin white balance, EV, zoom, lens switching, OIS/EIS, anti-flicker, looks, histogram.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/devices.png" alt="Home">
      <h3>🏠 One-click everything</h3>
      Live screen preview, battery and connection at a glance, one-click mirror, record, screen-off, desktop mode, audio and screenshots. USB or Wi-Fi (QR pairing).
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/mirror.png" alt="Mirroring profiles">
      <h3>🎛️ Every scrcpy option</h3>
      Built-in and custom profiles with an editor for every scrcpy 4.x option, live command preview, conflict checks and "detect from device".
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/control.png" alt="Control">
      <h3>🕹️ Remote control</h3>
      Keys, text, clipboard, quick-settings tiles, brightness, timeouts, animation speed, resolution and density overrides, reboot modes.
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/files.png" alt="Files">
      <h3>🗂️ Files, apps & shell</h3>
      Drag & drop file manager, app manager (launch, extract APK, uninstall…), adb shell, live logcat, device info and a media gallery.
    </td>
  </tr>
</table>

## 🚀 Get started

1. **[Download the installer](https://github.com/ShadowAugust/ScrcpyStudio/releases/latest/download/ScrcpyStudio-Setup.exe)** and run it (installs for your user, no admin needed). It adds **Scrcpy Studio** and **Phone Link** shortcuts.
2. Install [scrcpy](https://github.com/Genymobile/scrcpy/releases) (or `winget install Genymobile.scrcpy`): it is detected automatically.
3. Enable **USB debugging** on your phone and plug it in, or pair it over Wi-Fi from the app.

Prefer no install? Grab **[ScrcpyStudio-Portable.exe](https://github.com/ShadowAugust/ScrcpyStudio/releases/latest/download/ScrcpyStudio-Portable.exe)**.

### 🔄 Updates

The app checks for new releases at startup and suggests them (**Update now**, **What's new**, **Skip this version**). Check any time in Settings → Updates, the tray menu, or `Ctrl+K` → "Check for updates". The installer version updates itself in place; the portable exe swaps itself on restart.

## 📱 Phone Link: webcam, mic & speakers

| | What Windows gets | Notes |
| --- | --- | --- |
| 🎥 **Webcam** | **Scrcpy Studio Camera**, a regular webcam (+ optional NDI) | One-time install from the app (asks for admin) |
| 🎙️ **Mic** | A microphone such as **CABLE Output**, or an NDI audio source | Natural / Voice (noise + echo reduction) / Raw |
| 🔊 **Speakers** | Windows sound played on the phone, in stereo | With a virtual cable it becomes its own output, otherwise it mirrors your speakers |

Windows only lists microphones and speakers that have a driver, so the mic and a separate "phone speakers" output use a free virtual audio cable such as [VB-CABLE](https://vb-audio.com/Cable/). Phone Link detects it automatically (VB-CABLE, CABLE A/B, Hi-Fi Cable, VoiceMeeter, Virtual Audio Cable).

<details>
<summary><b>All features</b></summary>

**Virtual webcam + microphone (Windows)**
- One click turns the phone into **"Scrcpy Studio Camera"**, a real webcam device for vMix, Discord, Zoom, Teams, OBS, Chrome/Edge and most Windows apps (DirectShow, 64- and 32-bit apps). It shows a "camera offline" card when the phone isn't streaming, so apps can always open it
- **NDI output** (video + audio) when NDI Tools are installed: native in vMix/OBS, and through NDI Webcam a camera *and* microphone for every app
- The phone microphone can be played into any audio device, e.g. a virtual audio cable (VB-CABLE), whose other end becomes a microphone in Discord & co.
- No scrcpy window needed: a native bridge decodes the stream with the Windows H.264 decoder. All pro camera controls keep working live
- Install once from Camera Studio → Virtual webcam → Install (asks for administrator permission)

**Camera Studio (pro mode + webcam)**
- Uses your phone camera as a webcam window (capture it in OBS → Start Virtual Camera), with **live manual controls** like a native Pro mode:
  ISO, shutter speed, EV, manual focus (distance scale) and tap-to-focus, Kelvin white balance + tint, zoom, lens switching (ultra-wide / wide / front)
- Metering (matrix / center / spot), AF modes, OIS / EIS, anti-flicker (50/60 Hz), noise reduction, sharpening, contrast, saturation, effects, scene modes, torch, AE/AWB lock
- In-app live preview with histogram, a HUD with the real ISO/shutter/Kelvin/focus chosen by the phone, grid overlay, and saved "Looks"
- Output: 4K/1080p/720p/4:3, 15–30 fps and high-speed 120/240 fps, rotation, microphone audio, borderless/always-on-top window, recording
- Only offers what each lens supports (read from the phone's Camera2 capabilities)

How it works: Scrcpy Studio ships a patched build of the scrcpy server (`native/server-overlay`, built by `npm run build:server`). It is the official server of the same version plus a small extension that applies Camera2 settings from a control file on the device and reports live readings. It is only used for camera sessions; everything else uses the stock server.

**Mirroring**
- One-click mirroring from device cards, the title bar (`Ctrl+M`), the tray, or the command palette
- 9 built-in profiles (Balanced, High quality, Low-latency gaming, Wi-Fi saver, Screen off, Presentation, Desktop mode, Camera, View only) plus unlimited custom profiles with import/export
- A complete editor for **every scrcpy 4.x option** (video, audio, input, window, device, virtual display, camera, recording, advanced) with search, per-section change counters, live colored command preview and conflict warnings
- Options scrcpy would reject in the current context (e.g. camera options without a camera source, `--stay-awake` in view-only mode) are skipped automatically; version-gated options are hidden for older scrcpy
- "Detect from device" fills encoders, displays, cameras/sizes and installed apps into the editor
- Quick modes: screen-off mirror, record, background (headless) recording, audio only, camera, virtual display, OTG keyboard & mouse
- Open any app in **its own window** on a virtual display
- Per-device default profile, multiple simultaneous sessions

**Sessions** — live list with status, elapsed time, resolution, graceful stop (recordings are finalized), force kill, relaunch and full logs (copy/save).

**Devices & wireless**
- Auto-detected devices with model, Android version, resolution, battery and connection type; rename devices
- Clear guidance for unauthorized/offline devices
- Wi-Fi: connect by IP, one-click **USB → Wi-Fi switch**, Android 11+ pairing by **code** or **QR code**, mDNS discovery, remembered history with auto-reconnect

**Device tools**
- **Remote control**: navigation/power/volume/media keys, text input, paste PC clipboard, quick settings tiles (Wi-Fi, Bluetooth, data, airplane, dark mode, auto-rotate, stay awake, show touches…), brightness, screen timeout, font size, animation speed, resolution/density overrides, reboot to system/recovery/bootloader, shortcuts to device settings pages
- **Apps**: user/system/disabled/favorites filters, launch, force stop, mirror in own window, details, extract APK, clear data, disable/enable, uninstall; install APKs (drag & drop anywhere)
- **Files**: browse storage, quick places, upload (drag & drop), download, open on PC, rename, delete, new folder, keyboard shortcuts
- **Shell**: streaming adb shell with history and an editable quick-command library
- **Logcat**: live, level/text/regex/package filters, highlight, follow, save
- **Device info**: battery, memory, storage, CPU, display, uptime + all system properties
- **Media**: gallery of screenshots and recordings with lightbox, copy to clipboard, trash

**App** — dark/light/system themes with accent colors, command palette (`Ctrl+K`), keyboard shortcuts, system tray, desktop notifications, settings export/import.

</details>

## 🛠️ Build from source

### Requirements

- [scrcpy](https://github.com/Genymobile/scrcpy/releases) 2.x+ (4.x recommended). Auto-detected from PATH, winget, scoop, chocolatey, or set manually in Settings. The adb bundled with scrcpy is used by default.
- Node.js 18+ (to run from source)

### Run

```bash
npm install
npm start
```

Build a Windows installer + portable exe:

```bash
npm run dist
```

Output goes to `dist/` (installer and portable `.exe`).

### Shortcuts

| Action | Keys |
| --- | --- |
| Command palette | `Ctrl+K` |
| Mirror selected device | `Ctrl+M` |
| Record selected device | `Ctrl+Shift+R` |
| Screenshot | `Ctrl+Shift+S` |
| Navigate pages | `Ctrl+1…9` |
| Settings | `Ctrl+,` |
| Refresh devices | `F5` |

### Rebuilding the camera server

Needed only if you update scrcpy (the server must match the client version exactly). Requires git, JDK 17+ and the Android SDK (platform + build-tools):

```bash
SCRCPY_VERSION=4.1 npm run build:server
```

### Rebuilding the virtual webcam

Requires Visual Studio 2022 with "Desktop development with C++" (builds the softcam-based DirectShow camera for x64/x86 and the `studio-vcam.exe` bridge):

```bash
npm run build:vcam
```

`node scripts/build-vcam.js --bridge` rebuilds only `studio-vcam.exe`. The phone-side speaker player (`com.genymobile.scrcpy.studio.Speaker`) is part of the Studio server jar (`npm run build:server`).

### Development

- `src/main` — Electron main process (`adb.js`, `scrcpy.js`, `pairing.js`, `store.js`, `tools.js`, `preload.js`)
- `src/renderer` — UI (vanilla ES modules, no build step). `js/options.js` is the declarative scrcpy option schema.
- `npm run preview` serves the UI in a browser with a demo backend (`js/mock-api.js`).
- `bash scripts/capture.sh out/` renders every view with demo data to PNGs.
- `npm run icons` regenerates the icon subset and the app icon.

### Releasing

Bump the version and push the tag; GitHub Actions builds the installer and portable exe and publishes the release (with `latest.yml` for the updater):

```bash
npm version patch
git push --follow-tags
```

The native parts in `resources/` (Studio scrcpy server, virtual camera DLLs, `studio-vcam.exe`) are committed prebuilt, so CI only needs Node. README artwork: `npm run art` (renders `docs/art/*.html`).

## 📄 License

MIT © Augusto Migotto. Bundles the scrcpy server (Apache-2.0, Genymobile), softcam (MIT) and Lucide icons (ISC).
