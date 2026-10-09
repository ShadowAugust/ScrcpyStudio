// Builds "scrcpy-server-studio": the official scrcpy server (same version as the
// client) plus the Studio camera extension (live manual camera controls).
//
// Requirements: git, JDK 17+, Android SDK (platform + build-tools).
// Usage: node scripts/build-server.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRCPY_VERSION = process.env.SCRCPY_VERSION || '4.1';
const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const SRC = path.join(NATIVE, 'scrcpy-src');
const OVERLAY = path.join(NATIVE, 'server-overlay', 'src', 'main');
const BUILD = path.join(NATIVE, 'build');
const OUT = path.join(ROOT, 'resources', 'scrcpy-server-studio');
const IS_WIN = process.platform === 'win32';

function sh(cmd, args, opts = {}) {
  console.log('>', cmd, args.map(a => (a.length > 80 ? a.slice(0, 77) + '…' : a)).join(' '));
  return execFileSync(cmd, args, { stdio: 'inherit', shell: IS_WIN && /\.(bat|cmd)$/i.test(cmd), ...opts });
}

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

function sdk() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const latest = (dir) => fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  const platform = path.join(home, 'platforms', process.env.ANDROID_PLATFORM ? `android-${process.env.ANDROID_PLATFORM}` : latest(path.join(home, 'platforms')));
  const buildTools = path.join(home, 'build-tools', process.env.ANDROID_BUILD_TOOLS || latest(path.join(home, 'build-tools')));
  return { home, platform, buildTools };
}

function patch(file, from, to) {
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (!s.includes(from)) throw new Error(`Patch anchor not found in ${path.basename(file)}:\n${from.slice(0, 160)}`);
  fs.writeFileSync(file, s.replace(from, to));
}

// ------------------------------------------------------------------ source
if (!fs.existsSync(SRC)) {
  fs.mkdirSync(NATIVE, { recursive: true });
  sh('git', ['clone', '--depth', '1', '--branch', `v${SCRCPY_VERSION}`, 'https://github.com/Genymobile/scrcpy.git', SRC]);
}

fs.rmSync(BUILD, { recursive: true, force: true });
const main = path.join(BUILD, 'main');
fs.cpSync(path.join(SRC, 'server', 'src', 'main'), main, { recursive: true });
fs.cpSync(OVERLAY, main, { recursive: true });

const J = path.join(main, 'java', 'com', 'genymobile', 'scrcpy');

// ------------------------------------------------------------------ patches
const cam = path.join(J, 'video', 'CameraCapture.java');
patch(cam, '    private CameraCaptureSession currentSession;\n',
  `    private CameraCaptureSession currentSession;

    // Scrcpy Studio: live manual controls + small preview stream
    private StudioCamera studio;
    private android.media.ImageReader studioPreview;
    private android.media.ImageReader studioOldPreview;
`);

// Split session creation into a method so it can retry without the preview stream.
patch(cam, `        Surface captureSurface = surface;
        OutputConfiguration outputConfig = new OutputConfiguration(captureSurface);
        List<OutputConfiguration> outputs = Collections.singletonList(outputConfig);`,
`        studioCreateSession(surface, !highSpeed);
    }

    @TargetApi(AndroidVersions.API_30_ANDROID_11)
    private void studioCreateSession(Surface captureSurface, boolean withPreview) throws IOException {
        studioOldPreview = studioPreview;
        studioPreview = withPreview ? StudioCamera.createPreviewReader(cameraId, captureSize) : null;
        OutputConfiguration outputConfig = new OutputConfiguration(captureSurface);
        List<OutputConfiguration> outputs = studioPreview == null ? Collections.singletonList(outputConfig)
                : Arrays.asList(outputConfig, new OutputConfiguration(studioPreview.getSurface()));`);

patch(cam, `                    CaptureRequest request = requestBuilder.build();
                    setRepeatingRequest(session, request);
                    currentSession = session;`,
`                    if (!highSpeed) {
                        if (studioPreview != null) {
                            requestBuilder.addTarget(studioPreview.getSurface());
                        }
                        studio = new StudioCamera(cameraId, cameraManager.getCameraCharacteristics(cameraId), cameraHandler, studioPreview,
                                CameraCapture.this::studioReapply);
                        studio.applyTo(requestBuilder);
                    }

                    CaptureRequest request = requestBuilder.build();
                    setRepeatingRequest(session, request);
                    currentSession = session;
                    if (studio != null) {
                        studio.start();
                    }
                    if (studioOldPreview != null) {
                        studioOldPreview.close();
                        studioOldPreview = null;
                    }`);

patch(cam, `                Ln.e("Camera configuration error");
                disconnected.set(true);`,
`                if (studioPreview != null) {
                    Ln.w("Camera configuration failed with the Studio preview stream, retrying without it");
                    android.media.ImageReader r = studioPreview;
                    studioPreview = null;
                    r.close();
                    try {
                        studioCreateSession(captureSurface, false);
                        return;
                    } catch (IOException e) {
                        Ln.e("Camera error", e);
                    }
                }
                Ln.e("Camera configuration error");
                disconnected.set(true);`);

patch(cam, `            currentSession = null;
            requestBuilder = null;
            started = false;`,
`            currentSession = null;
            requestBuilder = null;
            started = false;
            if (studio != null) {
                studio.stop();
                studio = null;
            }`);

patch(cam, `            public void onCaptureFailed(CameraCaptureSession session, CaptureRequest request, CaptureFailure failure) {`,
`            public void onCaptureCompleted(CameraCaptureSession session, CaptureRequest request, android.hardware.camera2.TotalCaptureResult result) {
                StudioCamera s = studio;
                if (s != null) {
                    s.onResult(result);
                }
            }

            @Override
            public void onCaptureFailed(CameraCaptureSession session, CaptureRequest request, CaptureFailure failure) {`);

patch(cam, `    public void setTorchEnabled(boolean enabled) {`,
`    private void studioReapply(boolean afTrigger) {
        assertCameraThread();
        if (currentSession == null || requestBuilder == null || studio == null) {
            return;
        }
        try {
            studio.applyTo(requestBuilder);
            if (afTrigger) {
                requestBuilder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_START);
                currentSession.capture(requestBuilder.build(), null, cameraHandler);
                requestBuilder.set(CaptureRequest.CONTROL_AF_TRIGGER, CaptureRequest.CONTROL_AF_TRIGGER_IDLE);
            }
            setRepeatingRequest(currentSession, requestBuilder.build());
        } catch (Exception e) {
            Ln.w("Studio camera: could not apply settings: " + e);
        }
    }

    public void setTorchEnabled(boolean enabled) {`);

patch(cam, `        if (cameraDevice != null) {
            cameraDevice.close();
        }`,
`        if (cameraDevice != null) {
            cameraDevice.close();
        }
        if (studioPreview != null) {
            studioPreview.close();
        }`);

const opts = path.join(J, 'Options.java');
patch(opts, '    private boolean listCameras;\n', '    private boolean listCameras;\n    private boolean studioCameraCaps;\n');
patch(opts, '    public boolean getListCameras() {', '    public boolean getStudioCameraCaps() {\n        return studioCameraCaps;\n    }\n\n    public boolean getListCameras() {');
patch(opts, `                case "list_cameras":`, `                case "studio_camera_caps":
                    options.studioCameraCaps = Boolean.parseBoolean(value);
                    break;
                case "list_cameras":`);

// Scrcpy Studio: "optfile=<path>" expands key=value lines from a file on the device.
// Some devices abort app_process when its command line exceeds ~255 characters.
patch(opts, `        Options options = new Options();

        for (int i = 1; i < args.length; ++i) {`,
`        Options options = new Options();

        java.util.List<String> expanded = new java.util.ArrayList<>();
        for (int i = 0; i < args.length; ++i) {
            if (i > 0 && args[i].startsWith("optfile=")) {
                try {
                    java.io.File f = new java.io.File(args[i].substring(8));
                    for (String line : new String(java.nio.file.Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8).split(String.valueOf((char) 10))) {
                        line = line.trim();
                        if (!line.isEmpty()) {
                            expanded.add(line);
                        }
                    }
                    f.delete();
                } catch (java.io.IOException e) {
                    throw new IllegalArgumentException("Cannot read " + args[i]);
                }
            } else {
                expanded.add(args[i]);
            }
        }
        args = expanded.toArray(new String[0]);

        for (int i = 1; i < args.length; ++i) {`);

const server = path.join(J, 'Server.java');
patch(server, '        Options options = Options.parse(args);\n',
`        Options options = Options.parse(args);

        if (options.getStudioCameraCaps()) {
            // Scrcpy Studio: dump camera capabilities as JSON on stdout
            Workarounds.apply();
            System.out.println(com.genymobile.scrcpy.video.StudioCamera.capsJson());
            return;
        }
`);

// ------------------------------------------------------------------ compile
const { platform, buildTools } = sdk();
const androidJar = path.join(platform, 'android.jar');
const frameworkAidl = path.join(platform, 'framework.aidl');
const exe = (n) => path.join(buildTools, n + (IS_WIN ? (n === 'd8' ? '.bat' : '.exe') : ''));
console.log('Platform:', platform, '\nBuild-tools:', buildTools);

const gen = path.join(BUILD, 'gen');
const classes = path.join(BUILD, 'classes');
fs.mkdirSync(path.join(gen, 'com', 'genymobile', 'scrcpy'), { recursive: true });
fs.mkdirSync(classes, { recursive: true });
fs.writeFileSync(path.join(gen, 'com', 'genymobile', 'scrcpy', 'BuildConfig.java'),
  `package com.genymobile.scrcpy;\n\npublic final class BuildConfig {\n  public static final boolean DEBUG = false;\n  public static final String VERSION_NAME = "${SCRCPY_VERSION}";\n}\n`);

const aidlDir = path.join(main, 'aidl');
sh(exe('aidl'), [`-o${gen}`, `-I${aidlDir}`, path.join(aidlDir, 'android', 'content', 'IOnPrimaryClipChangedListener.aidl')]);
sh(exe('aidl'), [`-o${gen}`, `-I${aidlDir}`, '-p', frameworkAidl, path.join(aidlDir, 'android', 'view', 'IDisplayWindowListener.aidl')]);

const sources = [...walk(path.join(main, 'java'), '.java'), ...walk(gen, '.java')];
const argFile = path.join(BUILD, 'sources.txt');
fs.writeFileSync(argFile, sources.map(s => `"${s.replace(/\\/g, '/')}"`).join('\n'));
sh('javac', ['-encoding', 'UTF-8', '-bootclasspath', androidJar, '-cp', [path.join(buildTools, 'core-lambda-stubs.jar'), gen].join(path.delimiter),
  '-d', classes, '-source', '1.8', '-target', '1.8', '-nowarn', '-Xlint:-options', `@${argFile}`]);

const classFiles = walk(classes, '.class');
const d8Args = path.join(BUILD, 'd8-args.txt');
fs.writeFileSync(d8Args, classFiles.join('\n'));
sh('java', ['-cp', path.join(buildTools, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--release', '--min-api', '21', '--classpath', androidJar, '--output', path.join(BUILD, 'classes.zip'), `@${d8Args}`]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(path.join(BUILD, 'classes.zip'), OUT);
fs.writeFileSync(OUT + '.version', SCRCPY_VERSION);
console.log(`\nServer built: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
