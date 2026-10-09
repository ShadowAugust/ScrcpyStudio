// Demo backend used only when the UI is opened outside Electron (e.g. a plain
// browser for design work). Inside the app, preload.js provides window.api.
(function () {
  if (window.api) return;
  const listeners = {};
  const on = (ch) => (cb) => { (listeners[ch] ||= []).push(cb); return () => { listeners[ch] = listeners[ch].filter(f => f !== cb); }; };
  const emit = (ch, p) => (listeners[ch] || []).forEach(f => f(p));
  const ok = (x = {}) => Promise.resolve({ ok: true, ...x });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  let config = {
    settings: { theme: 'dark', accent: '#7c5cff', scrcpyPath: '', adbPath: '', screenshotDir: 'C:\\Users\\demo\\Pictures\\Scrcpy Studio', recordDir: 'C:\\Users\\demo\\Videos\\Scrcpy Studio', pullDir: 'C:\\Users\\demo\\Downloads', closeToTray: false, stopSessionsOnExit: true, autoReconnect: true, pollInterval: 2000, confirmDangerous: true, screenshotToClipboard: false, notifications: true, windowTitleFromAlias: true, recordFormat: 'mp4', reduceMotion: false },
    profiles: [{ id: 'p-demo', name: 'Streaming 60fps', icon: 'sliders-horizontal', description: 'Tuned for OBS capture', options: { 'max-fps': '60', 'video-bit-rate': '12M', 'window-borderless': true } }],
    activeProfileId: 'builtin-balanced', deviceAliases: { 'R5CT1234ABC': 'Work tablet' }, deviceProfiles: {},
    wirelessHistory: [{ address: '192.168.1.42:5555', name: 'Work tablet', lastUsed: Date.now() - 3600e3 }, { address: '192.168.1.77:40125', name: null, lastUsed: Date.now() - 86400e3 * 3 }],
    favoriteApps: {}, shellHistory: [], quickCommands: null, selectedSerial: '38121FDJH00ABC', onboarded: true,
  };
  const devices = [
    { serial: '38121FDJH00ABC', state: 'device', type: 'wifi', model: 'SM-G780G', brand: 'samsung', manufacturer: 'samsung', marketName: 'Galaxy S20 FE', density: 420, androidVersion: '13', sdk: 33, resolution: '1080x2400', physicalResolution: '1080x2400', battery: { level: 82, charging: true, temperature: 31.2, voltage: 4.21, health: 2, technology: 'Li-ion' }, deviceName: null, marketName: null },
    { serial: '192.168.1.42:5555', state: 'device', type: 'wifi', model: 'SM-X710', brand: 'samsung', manufacturer: 'samsung', marketName: 'Galaxy Tab S9', androidVersion: '14', sdk: 34, resolution: '2560x1600', physicalResolution: '2560x1600', density: 340, battery: { level: 23, charging: false }, characteristics: 'tablet' },
    { serial: 'ZY22H7KXLM', state: 'unauthorized', type: 'usb', model: null },
  ];
  config.deviceAliases = { '192.168.1.42:5555': 'Work tablet' };
  const sessions = [];
  let seq = 0;

  const apps = [['Chrome', 'com.android.chrome', true], ['YouTube', 'com.google.android.youtube', true], ['Spotify', 'com.spotify.music', false], ['WhatsApp', 'com.whatsapp', false], ['Instagram', 'com.instagram.android', false], ['Genshin Impact', 'com.miHoYo.GenshinImpact', false], ['Slack', 'com.Slack', false], ['Settings', 'com.android.settings', true], ['Camera', 'com.google.android.GoogleCamera', true], ['Termux', 'com.termux', false], ['Firefox', 'org.mozilla.firefox', false], ['Discord', 'com.discord', false], ['Maps', 'com.google.android.apps.maps', true], ['Gmail', 'com.google.android.gm', true]];

  window.api = {
    isElectron: false, platform: 'win32', pathForFile: (f) => f.name,
    app: {
      info: () => Promise.resolve({ version: '1.0.0', electron: '44.4.5', chrome: '146', node: '24', platform: 'win32', arch: 'x64', userData: 'C:\\Users\\demo\\AppData\\Roaming\\scrcpy-studio', tools: { scrcpy: 'C:\\scrcpy\\scrcpy.exe', adb: 'C:\\scrcpy\\adb.exe', scrcpyVersion: '4.1', adbVersion: '1.0.41' }, captureMode: false }),
      resolveTools: () => window.api.app.info().then(i => i.tools), setTitleBar: () => ok(), setProgress: () => ok(), flashFrame: () => ok(), focus: () => ok(), relaunch: () => ok(), systemDark: () => Promise.resolve(true),
    },
    store: {
      get: () => Promise.resolve(JSON.parse(JSON.stringify(config))),
      set: (patch) => { for (const [k, v] of Object.entries(patch)) config[k] = k === 'settings' ? { ...config.settings, ...v } : v; return Promise.resolve(JSON.parse(JSON.stringify(config))); },
      replace: (d) => { config = d; return Promise.resolve(config); }, reset: () => Promise.resolve(config),
    },
    dialog: { openFile: () => Promise.resolve(null), openFolder: () => Promise.resolve(null), saveFile: () => Promise.resolve(null) },
    fs: {
      writeText: () => ok(), readText: () => Promise.resolve('{}'), ensureDir: () => ok(), exists: () => Promise.resolve(true),
      listMedia: (dir, kind) => Promise.resolve(kind === 'image' ? Array.from({ length: 7 }, (_, i) => ({ name: `Pixel_8_Pro_2026-09-2${i}_14-3${i}-12.png`, path: 'x', url: 'icon.png', size: 1.2e6 + i * 3e5, mtime: Date.now() - i * 5e6, ext: 'png' })) : []),
    },
    shell: { openPath: () => ok(), showItem: () => ok(), openExternal: (u) => window.open(u), trash: () => ok() },
    clipboard: { text: () => ok(), image: () => Promise.resolve(true), readText: () => Promise.resolve('hello') },
    adb: {
      devices: () => Promise.resolve({ devices }), refresh: () => Promise.resolve(devices),
      details: async () => { await wait(400); return { ok: true, props: { 'ro.product.manufacturer': 'Google', 'ro.product.model': 'Pixel 8 Pro', 'ro.product.device': 'husky', 'ro.build.version.release': '15', 'ro.build.version.sdk': '35', 'ro.build.version.security_patch': '2026-09-05', 'ro.build.display.id': 'AP4A.260905.002', 'ro.build.fingerprint': 'google/husky/husky:15/AP4A.260905.002/1234567:user/release-keys', 'ro.soc.manufacturer': 'Google', 'ro.soc.model': 'Tensor G3', 'ro.product.cpu.abilist': 'arm64-v8a', 'persist.sys.locale': 'en-US', 'persist.sys.timezone': 'America/Sao_Paulo', 'ro.bootloader': 'ripcurrent-15.0', 'ro.crypto.state': 'encrypted', 'ro.treble.enabled': 'true' }, memory: { total: 11720000, available: 4930000 }, storage: { total: 244000000, used: 131000000, free: 113000000 }, cpu: { cores: 9, maxFreqKHz: 2910000 }, uptime: 312000, ip: '192.168.1.23', battery: devices[0].battery, wm: { physical: '1344x2992', density: 480 }, kernel: '6.1.75-android14-11' }; },
      screenPreview: async () => { await wait(200); const c = document.createElement('canvas'); c.width = 300; c.height = 640; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 300, 640); gr.addColorStop(0, '#4b2bd6'); gr.addColorStop(1, '#0fb5d4'); g.fillStyle = gr; g.fillRect(0, 0, 300, 640); g.fillStyle = 'rgba(255,255,255,.9)'; g.font = 'bold 64px Segoe UI'; g.fillText('12:45', 70, 170); g.font = '20px Segoe UI'; g.fillText('Tuesday, September 29', 55, 205); for (let i = 0; i < 12; i++) { g.fillStyle = `hsl(${i * 30} 70% 60%)`; g.beginPath(); g.roundRect(34 + (i % 4) * 62, 400 + Math.floor(i / 4) * 70, 46, 46, 14); g.fill(); } return { ok: true, url: c.toDataURL('image/jpeg', .8) }; },
      screenshot: async () => { await wait(500); return { ok: true, path: 'C:\\shot.png', url: 'icon.png', thumb: 'icon.png', width: 1344, height: 2992 }; },
      install: async (s, files) => files.map(f => ({ file: f, ok: true })),
      packages: async () => { await wait(300); return { ok: true, packages: apps.map(([, p, sys]) => ({ package: p, system: sys, disabled: p === 'com.Slack', apk: `/data/app/${p}/base.apk` })) }; },
      appDetails: () => Promise.resolve({ ok: true, versionName: '128.0.6613.88', versionCode: '661308833', targetSdk: '35', minSdk: '29', firstInstall: '2025-01-02 10:11:12', lastUpdate: '2026-09-20 08:00:00', installer: 'com.android.vending' }),
      appAction: async () => { await wait(300); return { ok: true, message: 'Success' }; },
      listDir: async (s, dir) => { await wait(200); return { ok: true, path: dir, entries: [['Alarms', 1], ['Android', 1], ['DCIM', 1], ['Documents', 1], ['Download', 1], ['Movies', 1], ['Music', 1], ['Pictures', 1], ['.thumbnails', 1], ['notes.txt', 0, 2048], ['recording_final.mp4', 0, 84e6], ['app-release.apk', 0, 23e6], ['photo_2026.jpg', 0, 3.4e6]].map(([name, dir, size]) => ({ name, dir: !!dir, type: dir ? 'directory' : 'regular file', size: size || 3452, mtime: Date.now() - Math.random() * 1e10, mode: dir ? 'drwxrwx--x' : '-rw-rw----' })) }; },
      fileOp: () => ok(), push: () => ok({ message: '1 file pushed' }), pull: () => ok(), openRemote: () => ok(),
      keyevent: () => ok(), text: () => ok(), shell: () => Promise.resolve({ ok: true, stdout: '', stderr: '' }), reboot: () => ok(),
      readSettings: async () => { await wait(300); return { ok: true, showTouches: false, pointerLocation: false, stayOn: true, darkMode: true, animWindow: 0.5, animTransition: 0.5, animAnimator: 0.5, brightness: 142, autoBrightness: false, screenTimeout: 60000, fontScale: 1, airplane: false, wifi: true, bluetooth: true, mobileData: false, autoRotate: true, wmSize: '1344x2992', wmPhysical: '1344x2992', wmDensity: 480, wmPhysicalDensity: 480 }; },
      applySetting: () => ok(), connect: async (a) => { await wait(500); return { ok: true, address: a, message: `connected to ${a}` }; }, disconnect: () => ok(), pair: () => ok(),
      enableWireless: () => ok({ address: '192.168.1.23:5555' }), deviceIp: () => Promise.resolve('192.168.1.23'),
      mdns: async () => { await wait(600); return { ok: true, services: [{ name: 'adb-38121FDJH00ABC-a1b2c3', type: '_adb-tls-connect._tcp', address: '192.168.1.23:38555', pairing: false }, { name: 'adb-RZ8N-xyz', type: '_adb-tls-pairing._tcp', address: '192.168.1.60:41234', pairing: true }] }; },
      restartServer: () => ok(),
      shellStream: async (s, cmd) => { const id = 'sh' + (++seq); setTimeout(() => { emit('stream:data', { id, data: `Output of "${cmd}"\nline 2\n` }); emit('stream:exit', { id, code: 0 }); }, 200); return { ok: true, id }; },
      logcat: async () => {
        const id = 'lc' + (++seq);
        const tags = ['ActivityManager', 'WindowManager', 'chromium', 'SurfaceFlinger', 'wifi', 'BatteryService', 'InputDispatcher', 'scrcpy'];
        const lv = ['V', 'D', 'I', 'I', 'I', 'W', 'E', 'D'];
        setInterval(() => {
          const d = new Date();
          const ts = `09-26 ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
          const lines = Array.from({ length: 3 }, () => { const i = Math.floor(Math.random() * tags.length); return `${ts}  1234  5678 ${lv[i]} ${tags[i]}: Demo log message number ${Math.floor(Math.random() * 1e5)} with some details`; });
          emit('stream:data', { id, data: lines.join('\n') + '\n' });
        }, 400);
        return { ok: true, id };
      },
      streamStop: () => ok(),
    },
    scrcpy: {
      start: async (o) => {
        const s = { id: 'session-' + (++seq), serial: o.serial, label: o.label, mode: o.mode, profileName: o.profileName, args: ['-s', o.serial, ...o.args], command: ['scrcpy.exe', '-s', o.serial, ...o.args], pid: 4000 + seq, status: 'running', studio: o.mode === 'camera' || o.mode === 'vcam', startedAt: Date.now(), endedAt: null, info: { texture: '1344x2992' }, recordPath: o.record ? 'C:\\rec.mp4' : null };
        sessions.unshift(s);
        setTimeout(() => emit('scrcpy:event', { type: 'update', session: s }), 10);
        return { ok: true, session: s };
      },
      stop: (id) => { const s = sessions.find(x => x.id === id); if (s) { s.endedAt = Date.now(); s.status = 'stopped'; emit('scrcpy:event', { type: 'update', session: { ...s } }); } return ok(); },
      stopAll: () => ok(), list: () => Promise.resolve(sessions), remove: () => ok(), clearEnded: () => ok(),
      logs: () => Promise.resolve([{ t: Date.now(), line: 'INFO: scrcpy 4.1 <https://github.com/Genymobile/scrcpy>', level: 'info' }, { t: Date.now(), line: 'INFO: Renderer: direct3d', level: 'info' }, { t: Date.now(), line: 'INFO: Texture: 1344x2992', level: 'info' }]),
      query: async (s, kind) => { await wait(400); return { ok: true, items: kind === 'apps' ? apps.map(([n, p, sys]) => ({ name: n, package: p, system: sys })) : kind === 'encoders' ? [{ kind: 'video', codec: 'h264', encoder: 'c2.exynos.h264.encoder', hw: true }, { kind: 'video', codec: 'h265', encoder: 'c2.exynos.hevc.encoder', hw: true }, { kind: 'audio', codec: 'opus', encoder: 'c2.android.opus.encoder', sw: true }] : kind === 'displays' ? [{ id: '0', size: '1344x2992' }] : [{ id: '0', facing: 'back', size: '4080x3072', sizes: ['1920x1080', '1280x720'] }, { id: '1', facing: 'front', size: '3280x2464', sizes: ['1920x1080'] }] }; },
    },
    camera: (() => {
      const caps = [{"id":"0","facing":"back","level":3,"capabilities":[0,9,3,7,4,5,1,6,2],"iso":[50,3200],"exposure":[57508,146700000],"maxFrameDuration":149988525,"minFocus":10,"hyperfocal":4.5000005,"focusCalibration":1,"evRange":[-20,20],"evStep":0.1,"afModes":[0,1,2,3,4],"aeModes":[0,1,2,3],"awbModes":[1,2,3,4,5,6,7,8,0],"antibanding":[0,1,2,3],"effects":[0,1,2,4],"scenes":[0,1,2,3,4,5,6,7,8,9,10,12,13,14,15,18],"eis":[0,1],"ois":[0,1],"nr":[0,1,2,3,4],"edge":[1,2,0,3],"tonemap":[0,1,2],"maxRegionsAe":1,"maxRegionsAf":1,"flash":true,"sensorOrientation":90,"manualWb":true,"zoom":[1,8],"aperture":1.7999999523162842,"focal":5.400000095367432,"sensorSize":[7.257599830627441,5.44320011138916],"focal35":26,"active":[4032,3024],"fpsRanges":[[15,15],[7,24],[24,24],[7,30],[30,30]],"sizes":["4032x3024","4032x2268","4032x1816","3024x3024","1920x824","3840x2160","1920x1080","2400x1080","1920x864","1920x1440","1440x1080","1088x1088","1280x720","960x720","720x480","640x480","640x360","352x288","320x240","256x144","176x144"],"highSpeed":["1280x720@120","1280x720@120","1280x720@240","1280x720@240","1920x1080@120","1920x1080@120","1920x1080@240","1920x1080@240","1920x824@120","1920x824@120"]},{"id":"1","facing":"front","level":0,"capabilities":[0,9,3,4,5,6],"iso":[50,100800],"exposure":[99900,279360000],"maxFrameDuration":279569520,"minFocus":0,"hyperfocal":3.9313633,"focusCalibration":1,"evRange":[-20,20],"evStep":0.1,"afModes":[0],"aeModes":[0,1],"awbModes":[1,2,3,4,5,6,7,8,0],"antibanding":[0,1,2,3],"effects":[0,1,2,4],"scenes":[0,1,2,3,4,5,6,7,8,9,10,12,13,14,15,18],"eis":[0,1],"ois":[0],"nr":[0,1,2,3,4],"edge":[1,2,0,3],"tonemap":[0,1,2],"maxRegionsAe":1,"maxRegionsAf":0,"flash":false,"sensorOrientation":270,"manualWb":true,"zoom":[1,8],"aperture":2.200000047683716,"focal":3.7200000286102295,"sensorSize":[5.222400188446045,3.916800022125244],"focal35":25,"active":[3264,2448],"fpsRanges":[[15,15],[7,24],[24,24],[7,30],[30,30]],"sizes":["3264x2448","3264x1836","3264x1468","2448x2448","1920x824","1920x1080","2400x1080","1920x864","1920x1440","1440x1080","1088x1088","1280x720","960x720","720x480","640x480","640x360","352x288","320x240","256x144","176x144"],"highSpeed":["1280x720@120","1280x720@120","1920x1080@120","1920x1080@120","1920x824@120","1920x824@120"]},{"id":"2","facing":"back","level":0,"capabilities":[0,3,4,5,1,6,7],"iso":[50,2400],"exposure":[40988,671434675],"maxFrameDuration":671537145,"minFocus":0,"hyperfocal":0.6143669,"focusCalibration":1,"evRange":[-20,20],"evStep":0.1,"afModes":[0],"aeModes":[0,1,2,3],"awbModes":[1,2,3,4,5,6,7,8,0],"antibanding":[0,1,2,3],"effects":[0,1,2,4],"scenes":[0,1,2,3,4,5,6,7,8,9,10,12,13,14,15,18],"eis":[0,1],"ois":[0],"nr":[0,1,2,3,4],"edge":[1,2,0,3],"tonemap":[0,1,2],"maxRegionsAe":1,"maxRegionsAf":0,"flash":true,"sensorOrientation":90,"manualWb":true,"zoom":[1,8],"aperture":2.200000047683716,"focal":1.7400000095367432,"sensorSize":[4.480000019073486,3.359999895095825],"focal35":13,"active":[4000,3000],"fpsRanges":[[15,15],[24,24],[7,30],[30,30]],"sizes":["4000x3000","4000x2256","4000x1800","2992x2992","1920x824","3840x2160","1920x1080","2400x1080","1920x864","1920x1440","1440x1080","1088x1088","1280x720","960x720","720x480","640x480","640x360","352x288","320x240","256x144","176x144"],"highSpeed":[]},{"id":"3","facing":"front","level":0,"capabilities":[0,9,3,4,5,6],"iso":[50,3200],"exposure":[99900,279360000],"maxFrameDuration":279569520,"minFocus":0,"hyperfocal":3.9313633,"focusCalibration":1,"evRange":[-20,20],"evStep":0.1,"afModes":[0],"aeModes":[0,1],"awbModes":[1,2,3,4,5,6,7,8,0],"antibanding":[0,1,2,3],"effects":[0,1,2,4],"scenes":[0,1,2,3,4,5,6,7,8,9,10,12,13,14,15,18],"eis":[0,1],"ois":[0],"nr":[0,1,2,3,4],"edge":[1,2,0,3],"tonemap":[0,1,2],"maxRegionsAe":1,"maxRegionsAf":0,"flash":false,"sensorOrientation":270,"manualWb":true,"zoom":[1,8],"aperture":2.200000047683716,"focal":3.7200000286102295,"sensorSize":[4.223999977111816,3.1679999828338623],"focal35":30,"active":[2640,1980],"fpsRanges":[[15,15],[7,24],[24,24],[7,30],[30,30]],"sizes":["2640x1980","2640x1488","2640x1188","1968x1968","1920x824","1920x1080","2400x1080","1920x864","1920x1440","1440x1080","1088x1088","1280x720","960x720","720x480","640x480","640x360","352x288","320x240","256x144","176x144"],"highSpeed":["1280x720@120","1280x720@120","1920x1080@120","1920x1080@120","1920x824@120","1920x824@120"]}];
      let timer = null, conf = {}, t = 0;
      const frame = () => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 360;
        const g = c.getContext('2d');
        const k = (conf.awb === 'manual' ? (conf.kelvin - 5200) / 5000 : 0);
        const gr = g.createLinearGradient(0, 0, 640, 360);
        gr.addColorStop(0, `hsl(${30 - k * 60} 45% ${conf.ae === 'manual' ? Math.min(70, conf.iso / 40) : 38}%)`); gr.addColorStop(1, `hsl(${220 - k * 40} 40% 16%)`);
        g.fillStyle = gr; g.fillRect(0, 0, 640, 360);
        g.fillStyle = 'rgba(255,220,160,.8)'; g.beginPath(); g.arc(470 + Math.sin(t / 9) * 12, 120, 46, 0, 7); g.fill();
        g.fillStyle = '#1b1c26'; g.fillRect(90, 210, 300, 150); g.fillStyle = '#2d3040'; g.fillRect(130, 150, 110, 70);
        g.filter = 'none'; return c.toDataURL('image/jpeg', .7);
      };
      return {
        info: () => Promise.resolve({ server: 'x', serverVersion: '4.1', scrcpyVersion: '4.1' }),
        caps: async () => { await wait(400); return { ok: true, cameras: caps }; },
        conf: (s, c) => { conf = c; return ok(); },
        watch: (serial) => {
          clearInterval(timer);
          if (serial) timer = setInterval(() => {
            t++;
            const man = conf.ae === 'manual';
            const hist = Array.from({ length: 64 }, (_, i) => Math.round(255 * Math.exp(-((i - (man ? conf.iso / 60 : 24)) ** 2) / 90) * (0.7 + Math.random() * .3)));
            emit('camera:status', { serial, status: { fps: 29.8, iso: man ? +conf.iso : 400 + Math.round(Math.sin(t / 5) * 40), exposure: man ? +conf.exposure : 16666667, focus: conf.af === 'manual' ? +conf.focus : 1.2, afState: conf.af === 'auto' ? 4 : 2, aperture: 1.8, kelvin: conf.awb === 'manual' ? +conf.kelvin : 4800, zoom: +conf.zoom || 1, hist } });
            emit('camera:preview', { serial, frame: frame() });
          }, 300);
          return ok();
        },
      };
    })(),
    vcam: {
      status: async () => ({ supported: true, available: true, name: 'Scrcpy Studio Camera', installed: true, installed64: true, installed32: true, ndi: true,
        outputs: [{ name: 'Speakers (Logitech G935)', default: true, virtual: false }, { name: 'CABLE Input (VB-Audio Virtual Cable)', default: false, virtual: true }], ndiMics: ['Webcam 1 (NDI Webcam Audio)'], cableMic: 'CABLE Output (VB-Audio Virtual Cable)' }),
      install: async () => ({ ok: true }), uninstall: async () => ({ ok: true }),
      start: async (o) => { const r = await window.api.scrcpy.start({ ...o, args: [], mode: 'vcam', label: 'Galaxy S20 FE · Virtual webcam' }); setInterval(() => emit('vcam:status', { serial: o.serial, running: true, stats: { fps: 30, width: 1920, height: 1080, camera: true, cameraInUse: true, ndi: true, ndiClients: 1, audio: true } }), 1000); return { ok: true, id: r.session.id, camera: true }; },
      stop: async () => ok(),
    },
    link: (() => {
      const cables = [{ id: 'c1', label: 'VB-Audio Virtual Cable', outputName: 'CABLE Input (VB-Audio Virtual Cable)', micName: 'CABLE Output (VB-Audio Virtual Cable)' }];
      const outputs = [{ id: 'o1', name: 'Speakers (JBL Clip 4)', default: true, virtual: false }, { id: 'o2', name: 'Headphones (Logitech G935)', default: false, virtual: false }, { id: 'c1', name: cables[0].outputName, default: false, virtual: true }];
      let settings = { cam: { size: '1920x1080', fps: 30, mirror: false, fit: 'contain', ndi: false, preview: true }, mic: { route: 'auto', source: 'voice-communication' }, spk: { route: 'auto', switchDefault: true } };
      const running = {};
      const timers = {};
      return {
        info: async () => ({ supported: true, camera: { installed: true, name: 'Scrcpy Studio Camera' }, ndi: true, cables, outputs,
          routes: { mic: { kind: 'cable', cable: { ...cables[0], render: {}, capture: {} }, auto: true }, spk: { kind: 'loop', device: outputs[0], auto: true } }, settings, running: {} }),
        settings: async (patch) => { if (patch) for (const [k, v] of Object.entries(patch)) settings[k] = typeof v === 'object' ? { ...settings[k], ...v } : v; return JSON.parse(JSON.stringify(settings)); },
        start: async (serial, kind) => {
          await wait(700);
          running[kind] = true;
          if (kind === 'cam') {
            window.api.camera.watch(serial);
            timers.cam = setInterval(() => emit('vcam:status', { serial, key: serial + '#cam', video: true, kind: 'stats', running: true, stats: { fps: 30, width: 1920, height: 1080, cameraInUse: true, ndi: false } }), 1000);
          } else if (kind === 'mic') {
            timers.mic = setInterval(() => emit('vcam:level', { serial, key: serial + '#mic', mic: Math.random() * 0.5 }), 100);
            setTimeout(() => emit('vcam:status', { serial, key: serial + '#mic', video: false, kind: 'started', running: true }), 50);
          } else {
            timers.spk = setInterval(() => emit('link:level', { serial, kind: 'spk', level: 0.2 + Math.random() * 0.5 }), 100);
            setTimeout(() => emit('link:status', { serial, kind: 'spk', running: true, stats: {} }), 50);
          }
          return { ok: true };
        },
        stop: async (serial, kind) => { clearInterval(timers[kind]); delete running[kind]; return true; },
        running: async () => ({}),
        volume: async (s, v) => ({ ok: true, value: v ?? 9, min: 0, max: 15 }),
        setDefaultOutput: async () => ({ ok: true }), open: () => ok(), shortcut: async () => ({ ok: true }), shortcutExists: async () => false, window: async () => false,
      };
    })(),
    update: (() => {
      let st = { status: 'idle', current: '1.0.0', mode: 'manual', repo: 'ShadowAugust/ScrcpyStudio', latest: null, progress: 0 };
      return {
        status: async () => st,
        check: async () => { await wait(500); st = { ...st, status: 'none', checkedAt: Date.now() }; emit('update:status', st); return st; },
        download: async () => st, install: async () => false, skip: async () => st,
      };
    })(),
    pair: { qrStart: async () => ({ ok: true, qr: 'icon.png', name: 'studio-abc', mdnsOk: true }), qrCancel: () => ok() },
    on: { vcamStatus: on('vcam:status'), vcamLevel: on('vcam:level'), linkStatus: on('link:status'), linkLevel: on('link:level'), updateStatus: on('update:status'), updateShow: on('update:show'), cameraStatus: on('camera:status'), cameraPreview: on('camera:preview'), devices: on('devices'), scrcpy: on('scrcpy:event'), streamData: on('stream:data'), streamExit: on('stream:exit'), pairStatus: on('pair:status'), installProgress: on('install:progress'), trayAction: on('tray:action') },
  };
})();
