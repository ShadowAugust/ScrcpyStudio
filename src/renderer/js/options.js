// Declarative schema of scrcpy 3.x/4.x options. The mirroring editor renders
// itself from this list and the command builder turns values into argv.

export const SECTIONS = [
  { id: 'video', label: 'Video', icon: 'video' },
  { id: 'audio', label: 'Audio', icon: 'volume-2' },
  { id: 'input', label: 'Input & control', icon: 'keyboard' },
  { id: 'window', label: 'Window', icon: 'app-window' },
  { id: 'device', label: 'Device', icon: 'smartphone' },
  { id: 'display', label: 'Virtual display', icon: 'monitor' },
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'record', label: 'Recording', icon: 'disc' },
  { id: 'advanced', label: 'Advanced', icon: 'wrench' },
];

// Dependency helpers: scrcpy refuses these options in the wrong context.
const CTRL = (v) => !v['no-control'];
const DISPLAY = (v) => v['video-source'] !== 'camera';
const CTRL_DISPLAY = (v) => CTRL(v) && DISPLAY(v);

const ORIENT = [['', 'Default'], ['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°'], ['flip0', 'Flip'], ['flip90', 'Flip + 90°'], ['flip180', 'Flip + 180°'], ['flip270', 'Flip + 270°']];

export const OPTIONS = [
  // ------------------------------------------------------------ video
  { key: 'video-source', section: 'video', type: 'select', label: 'Video source', default: 'display', choices: [['display', 'Device screen'], ['camera', 'Camera (Android 12+)']], desc: 'Mirror the screen or stream a device camera.' },
  { key: 'max-size', section: 'video', type: 'combo', label: 'Max resolution', unit: 'px', default: '', suggestions: ['720', '1024', '1280', '1600', '1920', '2560'], placeholder: 'Native', desc: 'Limit width and height (keeps aspect ratio). Lower values reduce latency.' },
  { key: 'video-bit-rate', section: 'video', type: 'combo', label: 'Video bit rate', default: '', suggestions: ['2M', '4M', '8M', '12M', '16M', '24M', '32M'], placeholder: '8M', desc: 'Higher is sharper but needs more bandwidth. Supports K/M suffixes.' },
  { key: 'max-fps', section: 'video', type: 'combo', label: 'Max frame rate', unit: 'fps', default: '', suggestions: ['24', '30', '60', '90', '120', '144'], placeholder: 'Unlimited', desc: 'Cap the capture frame rate (officially supported since Android 10).' },
  { key: 'video-codec', section: 'video', type: 'select', label: 'Video codec', default: 'h264', choices: [['h264', 'H.264 (compatible)'], ['h265', 'H.265 / HEVC'], ['av1', 'AV1'], ['vp8', 'VP8'], ['vp9', 'VP9']], desc: 'H.265 and AV1 give better quality at the same bit rate if the device supports them.' },
  { key: 'video-encoder', section: 'video', type: 'combo', label: 'Video encoder', default: '', dynamic: 'videoEncoders', placeholder: 'Automatic', desc: 'Pick a specific MediaCodec encoder. Use "Detect" to list them.' },
  { key: 'video-codec-options', section: 'video', type: 'text', label: 'Codec options', default: '', placeholder: 'profile=1,level=4096', mono: true, desc: 'Advanced MediaCodec key[:type]=value options.' },
  { key: 'video-buffer', section: 'video', type: 'number', label: 'Video buffer', unit: 'ms', default: '', min: 0, max: 5000, placeholder: '0', desc: 'Adds latency to smooth out network jitter.' },
  { key: 'crop', section: 'video', when: DISPLAY, whenHint: 'Video source = Device screen', type: 'text', label: 'Crop', default: '', placeholder: 'width:height:x:y', mono: true, desc: 'Mirror only part of the screen, e.g. 1224:1440:0:0.' },
  { key: 'capture-orientation', section: 'video', type: 'select', label: 'Capture orientation', default: '', choices: [...ORIENT, ['@', 'Lock to initial'], ['@0', 'Lock 0°'], ['@90', 'Lock 90°'], ['@180', 'Lock 180°'], ['@270', 'Lock 270°']], desc: 'Rotate or lock the captured video on the device side.' },
  { key: 'display-orientation', section: 'video', type: 'select', label: 'Display orientation', default: '', choices: ORIENT, desc: 'Rotate the mirrored picture in the window only.' },
  { key: 'angle', section: 'video', type: 'number', label: 'Custom angle', unit: '°', default: '', min: -360, max: 360, desc: 'Rotate the video content by an arbitrary angle.' },
  { key: 'min-size-alignment', section: 'video', type: 'select', label: 'Size alignment', default: '', choices: [['', 'Default (1)'], ['2', '2'], ['4', '4'], ['8', '8'], ['16', '16']], desc: 'Force the video size to be a multiple of this value.' },
  { key: 'no-video', section: 'video', type: 'bool', label: 'Disable video', desc: 'Only forward audio/control. Useful for audio-only streaming.' },
  { key: 'no-video-playback', section: 'video', type: 'bool', label: 'Disable video playback', desc: 'Capture video (e.g. to record) without displaying it.' },
  { key: 'no-downsize-on-error', section: 'video', type: 'bool', label: 'No downsize on error', desc: 'Do not retry with a lower resolution when the encoder fails.' },
  { key: 'ignore-video-encoder-constraints', section: 'video', type: 'bool', label: 'Ignore encoder constraints', desc: 'Don\'t clamp size to the encoder\'s reported limits.' },
  { key: 'print-fps', section: 'video', type: 'bool', label: 'Log FPS', desc: 'Print the frame rate in the session log.' },

  // ------------------------------------------------------------ audio
  { key: 'no-audio', section: 'audio', type: 'bool', label: 'Disable audio', desc: 'Audio forwarding requires Android 11+.' },
  { key: 'audio-source', section: 'audio', when: (v) => !v['no-audio'], whenHint: 'audio enabled', type: 'select', label: 'Audio source', default: 'output', choices: [
    ['output', 'Device output (mutes phone)'], ['playback', 'Playback capture'], ['mic', 'Microphone'], ['mic-unprocessed', 'Microphone (raw)'],
    ['mic-camcorder', 'Microphone (camcorder)'], ['mic-voice-recognition', 'Microphone (voice recognition)'], ['mic-voice-communication', 'Microphone (voice call tuned)'],
    ['voice-call', 'Voice call'], ['voice-call-uplink', 'Voice call uplink'], ['voice-call-downlink', 'Voice call downlink'], ['voice-performance', 'Voice performance (karaoke)']],
    desc: 'What to capture. "Playback" keeps sound on the phone with Audio dup.' },
  { key: 'audio-dup', section: 'audio', when: (v) => v['audio-source'] === 'playback', whenHint: 'Audio source = Playback', type: 'bool', label: 'Keep playing on device', desc: 'Duplicate audio (requires Playback source, Android 13+).' },
  { key: 'audio-codec', section: 'audio', type: 'select', label: 'Audio codec', default: 'opus', choices: [['opus', 'Opus'], ['aac', 'AAC'], ['flac', 'FLAC (lossless)'], ['raw', 'Raw PCM']] },
  { key: 'audio-bit-rate', section: 'audio', type: 'combo', label: 'Audio bit rate', default: '', suggestions: ['64K', '96K', '128K', '192K', '256K', '320K'], placeholder: '128K' },
  { key: 'audio-encoder', section: 'audio', type: 'combo', label: 'Audio encoder', default: '', dynamic: 'audioEncoders', placeholder: 'Automatic' },
  { key: 'audio-codec-options', section: 'audio', type: 'text', label: 'Codec options', default: '', mono: true, placeholder: 'key[:type]=value' },
  { key: 'audio-buffer', section: 'audio', type: 'number', label: 'Audio buffer', unit: 'ms', default: '', min: 0, max: 1000, placeholder: '50', desc: 'Lower = less latency, higher = fewer glitches.' },
  { key: 'audio-output-buffer', section: 'audio', type: 'number', label: 'Output buffer', unit: 'ms', default: '', min: 0, max: 1000, placeholder: '5', desc: 'SDL audio output buffer. Increase if you hear crackling.' },
  { key: 'no-audio-playback', section: 'audio', type: 'bool', label: 'Disable audio playback', desc: 'Capture audio (e.g. to record) without playing it.' },
  { key: 'require-audio', section: 'audio', type: 'bool', label: 'Require audio', desc: 'Fail instead of continuing without audio if capture fails.' },

  // ------------------------------------------------------------ input
  { key: 'no-control', section: 'input', type: 'bool', label: 'View only', desc: 'Disable all keyboard and mouse control.' },
  { key: 'keyboard', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'select', label: 'Keyboard mode', default: '', choices: [['', 'Default (sdk)'], ['sdk', 'SDK — Android API'], ['uhid', 'UHID — physical keyboard'], ['aoa', 'AOA — USB only'], ['disabled', 'Disabled']], desc: 'UHID simulates a real keyboard: better for games and non-Latin layouts.' },
  { key: 'mouse', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'select', label: 'Mouse mode', default: '', choices: [['', 'Default (sdk)'], ['sdk', 'SDK — touch events'], ['uhid', 'UHID — physical mouse'], ['aoa', 'AOA — USB only'], ['disabled', 'Disabled']], desc: 'UHID/AOA capture the mouse (press Alt to release).' },
  { key: 'gamepad', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'select', label: 'Gamepad mode', default: '', choices: [['', 'Disabled'], ['uhid', 'UHID'], ['aoa', 'AOA — USB only']], desc: 'Forward connected game controllers to the device.' },
  { key: 'mouse-bind', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'combo', label: 'Mouse bindings', default: '', suggestions: ['bhsn:++++', '++++:bhsn', '++++', 'bhsn'], mono: true, placeholder: 'bhsn:++++', desc: 'Right, middle, 4th, 5th click: + forward, - ignore, b back, h home, s switch, n notifications.' },
  { key: 'no-mouse-hover', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'No mouse hover', desc: 'Do not forward mouse motion without clicks.' },
  { key: 'prefer-text', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'Prefer text injection', desc: 'Inject letters as text (better for IME, breaks games WASD).' },
  { key: 'raw-key-events', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'Raw key events', desc: 'Always inject key events, never text.' },
  { key: 'no-key-repeat', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'No key repeat', desc: 'Do not forward repeated key events when a key is held.' },
  { key: 'legacy-paste', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'Legacy paste', desc: 'Paste by injecting key events (for devices where clipboard sync fails).' },
  { key: 'no-clipboard-autosync', section: 'input', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'No clipboard sync', desc: 'Disable automatic clipboard synchronization.' },
  { key: 'shortcut-mod', section: 'input', type: 'combo', label: 'Shortcut modifier', default: '', suggestions: ['lalt,lsuper', 'lctrl', 'lalt', 'ralt', 'lsuper', 'lctrl,lsuper', 'rctrl'], mono: true, placeholder: 'lalt,lsuper', desc: 'Keys used for scrcpy shortcuts (MOD+h = Home, MOD+b = Back…).' },

  // ------------------------------------------------------------ window
  { key: 'window-title', section: 'window', type: 'text', label: 'Window title', default: '', placeholder: 'Device name', desc: 'Leave empty to use the device name.' },
  { key: 'fullscreen', section: 'window', type: 'bool', label: 'Start fullscreen' },
  { key: 'always-on-top', section: 'window', type: 'bool', label: 'Always on top' },
  { key: 'window-borderless', section: 'window', type: 'bool', label: 'Borderless window' },
  { key: 'render-fit', section: 'window', type: 'select', label: 'Render fit', default: '', choices: [['', 'Default'], ['letterbox', 'Letterbox (keep ratio)'], ['stretched', 'Stretch to window'], ['unscaled', 'Unscaled (1:1)']], desc: 'How the picture fits the window (scrcpy 4.x).', minVersion: '4.0' },
  { key: 'background-color', section: 'window', type: 'color', label: 'Background color', default: '', desc: 'Color of the letterbox bars (scrcpy 4.x).', minVersion: '4.0' },
  { key: 'window-x', section: 'window', type: 'number', label: 'Window X', unit: 'px', default: '', placeholder: 'auto' },
  { key: 'window-y', section: 'window', type: 'number', label: 'Window Y', unit: 'px', default: '', placeholder: 'auto' },
  { key: 'window-width', section: 'window', type: 'number', label: 'Window width', unit: 'px', default: '', min: 0, placeholder: 'auto' },
  { key: 'window-height', section: 'window', type: 'number', label: 'Window height', unit: 'px', default: '', min: 0, placeholder: 'auto' },
  { key: 'no-window-aspect-ratio-lock', section: 'window', type: 'bool', label: 'Free aspect ratio', desc: 'Allow resizing the window to any aspect ratio.' },
  { key: 'disable-screensaver', section: 'window', type: 'bool', label: 'Disable PC screensaver', desc: 'Prevent your computer from sleeping while mirroring.' },
  { key: 'no-window', section: 'window', type: 'bool', label: 'No window', desc: 'Run headless (recording or audio only).' },
  { key: 'no-mipmaps', section: 'window', type: 'bool', label: 'Disable mipmaps', desc: 'Mipmaps improve downscaling quality; disable if you see issues.' },

  // ------------------------------------------------------------ device
  { key: 'turn-screen-off', section: 'device', when: CTRL_DISPLAY, whenHint: 'control enabled and screen (not camera) source', type: 'bool', label: 'Turn device screen off', desc: 'Mirror with the physical screen off — saves battery.' },
  { key: 'stay-awake', section: 'device', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'Stay awake', desc: 'Prevent the device from sleeping while plugged in.' },
  { key: 'keep-active', section: 'device', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'Keep active', desc: 'Keep the screen on by simulating user activity.' },
  { key: 'show-touches', section: 'device', when: CTRL_DISPLAY, whenHint: 'control enabled and screen (not camera) source', type: 'bool', label: 'Show touches', desc: 'Show physical touches on the device (great for demos).' },
  { key: 'power-off-on-close', section: 'device', when: CTRL, whenHint: 'control enabled (not View only)', type: 'bool', label: 'Lock device on close', desc: 'Turn the device screen off when scrcpy closes.' },
  { key: 'no-power-on', section: 'device', type: 'bool', label: 'Don\'t wake device', desc: 'Do not power on the device on start.' },
  { key: 'screen-off-timeout', section: 'device', when: CTRL, whenHint: 'control enabled (not View only)', type: 'number', label: 'Screen-off timeout', unit: 's', default: '', min: 0, placeholder: 'unchanged', desc: 'Temporary screen timeout while mirroring (restored on exit).' },
  { key: 'display-id', section: 'device', when: DISPLAY, whenHint: 'Video source = Device screen', type: 'combo', label: 'Display', default: '', dynamic: 'displays', placeholder: '0 (main)', desc: 'Mirror a secondary display.' },
  { key: 'start-app', section: 'device', when: CTRL_DISPLAY, whenHint: 'control enabled and screen (not camera) source', type: 'combo', label: 'Start app', default: '', dynamic: 'apps', placeholder: 'com.example.app', mono: true, desc: 'Launch an app on start. Prefix ? to search by name, + to force-stop first.' },
  { key: 'push-target', section: 'device', type: 'text', label: 'Drag & drop target', default: '', placeholder: '/sdcard/Download/', mono: true, desc: 'Where files dropped on the scrcpy window are pushed.' },

  // ------------------------------------------------------------ virtual display
  { key: 'new-display', section: 'display', when: DISPLAY, whenHint: 'Video source = Device screen', type: 'bool', label: 'Create virtual display', desc: 'Open a separate display — run apps on your PC without touching the phone screen (Android 10+).' },
  { key: 'new-display-size', section: 'display', type: 'combo', label: 'Resolution', default: '', suggestions: ['1280x720', '1600x900', '1920x1080', '2560x1440', '1080x1920', '1440x2560'], placeholder: 'Same as device', mono: true, requires: 'new-display', gui: true },
  { key: 'new-display-dpi', section: 'display', type: 'combo', label: 'Density (DPI)', default: '', suggestions: ['120', '160', '200', '240', '320', '420'], placeholder: 'Device DPI', requires: 'new-display', gui: true },
  { key: 'flex-display', section: 'display', type: 'bool', label: 'Flexible display', desc: 'Continuously resize the virtual display to match the window (scrcpy 4.x).', requires: 'new-display', minVersion: '4.0' },
  { key: 'display-ime-policy', section: 'display', when: (v) => v['new-display'] || (v['display-id'] && String(v['display-id']) !== '0'), whenHint: 'a virtual or secondary display', type: 'select', label: 'Keyboard (IME) location', default: '', choices: [['', 'Default'], ['local', 'On virtual display'], ['fallback', 'On main display'], ['hide', 'Hidden']] },
  { key: 'no-vd-destroy-content', section: 'display', type: 'bool', label: 'Keep apps on close', desc: 'Move apps to the main display instead of closing them.', requires: 'new-display' },
  { key: 'no-vd-system-decorations', section: 'display', type: 'bool', label: 'No system decorations', desc: 'Hide the launcher/navigation on the virtual display.', requires: 'new-display' },

  // ------------------------------------------------------------ camera
  { key: 'camera-facing', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'select', label: 'Camera', default: '', choices: [['', 'Default'], ['back', 'Back'], ['front', 'Front'], ['external', 'External']], desc: 'Requires Video source = Camera.' },
  { key: 'camera-id', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'combo', label: 'Camera ID', default: '', dynamic: 'cameras', placeholder: 'auto' },
  { key: 'camera-size', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'combo', label: 'Capture size', default: '', dynamic: 'cameraSizes', suggestions: ['1920x1080', '1280x720', '3840x2160', '640x480'], mono: true, placeholder: 'auto' },
  { key: 'camera-ar', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'combo', label: 'Aspect ratio', default: '', suggestions: ['sensor', '4:3', '16:9', '1:1'], placeholder: 'any' },
  { key: 'camera-fps', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'combo', label: 'Camera FPS', default: '', suggestions: ['15', '24', '30', '60', '120', '240'], placeholder: 'default' },
  { key: 'camera-zoom', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'number', label: 'Initial zoom', default: '', min: 0, step: 0.1, placeholder: '1.0', desc: 'Adjust live with MOD+↑/↓ (scrcpy 4.x).', minVersion: '4.0' },
  { key: 'camera-high-speed', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'bool', label: 'High-speed mode', desc: 'Enable high frame rate capture (restricted sizes).' },
  { key: 'camera-torch', section: 'camera', when: (v) => v['video-source'] === 'camera', whenHint: 'Video source = Camera', type: 'bool', label: 'Torch on', desc: 'Turn on the flashlight when starting.', minVersion: '3.3' },

  // ------------------------------------------------------------ recording
  { key: 'record', section: 'record', type: 'bool', label: 'Record session', desc: 'Save a video file to your recordings folder.', gui: true },
  { key: 'record-format', section: 'record', type: 'select', label: 'Container', default: '', choices: [['', 'Default (settings)'], ['mp4', 'MP4'], ['mkv', 'MKV (crash safe)'], ['m4a', 'M4A (audio)'], ['mka', 'MKA (audio)'], ['opus', 'Opus (audio)'], ['aac', 'AAC (audio)'], ['flac', 'FLAC (audio)'], ['wav', 'WAV (audio)']], gui: true },
  { key: 'record-orientation', section: 'record', requires: 'record', type: 'select', label: 'Record orientation', default: '', choices: [['', 'Default'], ['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']] },
  { key: 'time-limit', section: 'record', type: 'number', label: 'Time limit', unit: 's', default: '', min: 0, placeholder: 'none', desc: 'Stop automatically after this many seconds.' },
  { key: 'no-playback', section: 'record', type: 'bool', label: 'No playback', desc: 'Record without displaying video or playing audio.' },

  // ------------------------------------------------------------ advanced
  { key: 'render-driver', section: 'advanced', type: 'select', label: 'Render driver', default: '', choices: [['', 'Auto'], ['direct3d', 'Direct3D'], ['opengl', 'OpenGL'], ['opengles2', 'OpenGL ES 2'], ['opengles', 'OpenGL ES'], ['metal', 'Metal'], ['software', 'Software']] },
  { key: 'verbosity', section: 'advanced', type: 'select', label: 'Log verbosity', default: '', choices: [['', 'Info'], ['verbose', 'Verbose'], ['debug', 'Debug'], ['warn', 'Warnings'], ['error', 'Errors only']] },
  { key: 'otg', section: 'advanced', type: 'bool', label: 'OTG mode', desc: 'Control the device as a physical keyboard/mouse over USB, without mirroring or adb.' },
  { key: 'force-adb-forward', section: 'advanced', type: 'bool', label: 'Force adb forward', desc: 'Use "adb forward" instead of "adb reverse".' },
  { key: 'port', section: 'advanced', type: 'text', label: 'Local port(s)', default: '', placeholder: '27183:27199', mono: true },
  { key: 'tunnel-host', section: 'advanced', type: 'text', label: 'Tunnel host', default: '', placeholder: 'localhost', mono: true },
  { key: 'tunnel-port', section: 'advanced', type: 'number', label: 'Tunnel port', default: '' },
  { key: 'no-cleanup', section: 'advanced', type: 'bool', label: 'No cleanup', desc: 'Leave the scrcpy server on the device after closing.' },
  { key: 'kill-adb-on-close', section: 'advanced', type: 'bool', label: 'Kill adb on close' },
  { key: 'extra-args', section: 'advanced', type: 'text', label: 'Extra arguments', default: '', mono: true, placeholder: '--some-flag=value', desc: 'Appended verbatim to the command line.', gui: true },
];

export const OPTION_MAP = Object.fromEntries(OPTIONS.map(o => [o.key, o]));

export const BUILTIN_PROFILES = [
  { id: 'builtin-balanced', builtin: true, name: 'Balanced', icon: 'gauge', description: 'Sharp 1080p-class picture with audio. Great default for USB and Wi-Fi.',
    options: { 'max-size': '1920', 'video-bit-rate': '8M', 'stay-awake': true } },
  { id: 'builtin-quality', builtin: true, name: 'High quality', icon: 'sparkles', description: 'Native resolution, H.265, high bit rate and lossless-grade audio.',
    options: { 'video-codec': 'h265', 'video-bit-rate': '24M', 'audio-bit-rate': '256K', 'stay-awake': true } },
  { id: 'builtin-gaming', builtin: true, name: 'Low latency gaming', icon: 'gamepad-2', description: 'High FPS, tiny buffers, physical keyboard & gamepad forwarding.',
    options: { 'max-size': '1600', 'video-bit-rate': '16M', 'max-fps': '120', 'audio-buffer': 25, 'audio-output-buffer': 5, keyboard: 'uhid', gamepad: 'uhid', 'stay-awake': true, 'disable-screensaver': true } },
  { id: 'builtin-wifi', builtin: true, name: 'Wi-Fi saver', icon: 'wifi', description: 'Low bandwidth profile for wireless connections and weak networks.',
    options: { 'max-size': '1024', 'video-bit-rate': '2M', 'max-fps': '30', 'audio-bit-rate': '64K', 'video-buffer': 50 } },
  { id: 'builtin-screenoff', builtin: true, name: 'Screen off', icon: 'moon', description: 'Control the phone from your PC while its screen stays dark.',
    options: { 'max-size': '1920', 'turn-screen-off': true, 'stay-awake': true, 'power-off-on-close': true } },
  { id: 'builtin-present', builtin: true, name: 'Presentation', icon: 'monitor-play', description: 'Show touches, stay on top and keep the PC awake — ideal for demos.',
    options: { 'max-size': '1920', 'show-touches': true, 'always-on-top': true, 'stay-awake': true, 'disable-screensaver': true } },
  { id: 'builtin-desktop', builtin: true, name: 'Desktop mode', icon: 'monitor', description: 'A 1080p virtual display that doesn\'t touch the phone screen.',
    options: { 'new-display': true, 'new-display-size': '1920x1080', 'new-display-dpi': '160', 'no-vd-destroy-content': true, 'stay-awake': true } },
  { id: 'builtin-webcam', builtin: true, name: 'Camera', icon: 'camera', description: 'Use the phone camera as a high quality webcam feed.',
    options: { 'video-source': 'camera', 'camera-facing': 'back', 'camera-ar': '16:9', 'max-size': '1920', 'no-audio': true } },
  { id: 'builtin-viewonly', builtin: true, name: 'View only', icon: 'eye', description: 'Watch the screen without sending any input.',
    options: { 'no-control': true, 'max-size': '1920' } },
];

export const QUICK_MODES = [
  { id: 'mirror', label: 'Mirror', icon: 'cast', desc: 'Mirror with the active profile' },
  { id: 'screen-off', label: 'Screen off', icon: 'moon', desc: 'Mirror with the device screen off', overlay: { 'turn-screen-off': true, 'stay-awake': true } },
  { id: 'record', label: 'Record', icon: 'disc', desc: 'Mirror and record to a file', overlay: { record: true } },
  { id: 'record-bg', label: 'Record in background', icon: 'circle-dot', desc: 'Record without a window', overlay: { record: true, 'no-window': true, 'no-audio-playback': true, 'record-format': 'mkv' } },
  { id: 'audio', label: 'Audio only', icon: 'headphones', desc: 'Stream device audio to your PC', overlay: { 'no-video': true, 'no-window': true, 'no-control': true, 'no-audio': false } },
  { id: 'camera', label: 'Camera', icon: 'camera', desc: 'Stream a device camera', overlay: { 'video-source': 'camera', 'turn-screen-off': false } },
  { id: 'desktop', label: 'Virtual display', icon: 'monitor', desc: 'Open a separate virtual display', overlay: { 'new-display': true, 'turn-screen-off': false } },
  { id: 'otg', label: 'OTG keyboard & mouse', icon: 'keyboard', desc: 'Use PC input as a USB HID device', otg: true },
];
