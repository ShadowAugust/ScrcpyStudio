package com.genymobile.scrcpy.video;

import com.genymobile.scrcpy.util.Ln;
import com.genymobile.scrcpy.wrappers.ServiceManager;

import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.ColorSpaceTransform;
import android.hardware.camera2.params.MeteringRectangle;
import android.hardware.camera2.params.RggbChannelVector;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.hardware.camera2.params.TonemapCurve;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.util.SizeF;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Scrcpy Studio extension: live manual camera controls ("pro mode").
 *
 * The desktop app writes key=value settings to CONF; they are polled and applied to the repeating capture request.
 * Live 3A readings (+ histogram) are written to STATUS and a small JPEG preview to PREVIEW while the app is watching.
 */
public final class StudioCamera {

    public static final String DIR = "/data/local/tmp/";
    public static final String CONF = DIR + "scrcpy-studio-camera.conf";
    public static final String STATUS = DIR + "scrcpy-studio-camera.json";
    public static final String PREVIEW = DIR + "scrcpy-studio-camera.jpg";

    public interface Reapplier {
        void reapply(boolean afTrigger);
    }

    private final String cameraId;
    private final CameraCharacteristics chars;
    private final Handler cameraHandler;
    private final Reapplier reapplier;
    private final ImageReader previewReader;
    private HandlerThread previewThread;

    private volatile Map<String, String> conf = new HashMap<>();
    private String lastRaw = "";
    private String lastTrigger = "";
    private Thread poller;
    private volatile boolean running;

    // Latest capture results (written by the camera thread, read by the status writer)
    private volatile TotalCaptureResult lastResult;
    private volatile ColorSpaceTransform lastAutoCcm;
    private long lastStatusWrite;
    private long lastPreviewWrite;
    private int frameCount;
    private long fpsWindowStart;
    private float measuredFps;
    private volatile int[] histogram = new int[64];
    private boolean regionsSet;

    public StudioCamera(String cameraId, CameraCharacteristics chars, Handler cameraHandler, ImageReader previewReader, Reapplier reapplier) {
        this.cameraId = cameraId;
        this.chars = chars;
        this.cameraHandler = cameraHandler;
        this.reapplier = reapplier;
        this.previewReader = previewReader;
        readConf();
        lastTrigger = get("aftrigger", "");
    }

    // ------------------------------------------------------------------ lifecycle

    public void start() {
        running = true;
        poller = new Thread(() -> {
            while (running) {
                try {
                    Thread.sleep(100);
                    String before = lastRaw;
                    if (readConf() && !before.equals(lastRaw)) {
                        String trigger = get("aftrigger", "");
                        boolean af = !trigger.equals(lastTrigger);
                        lastTrigger = trigger;
                        cameraHandler.post(() -> reapplier.reapply(af));
                    }
                    long now = System.currentTimeMillis();
                    if (isLive() && now - lastStatusWrite > 250) {
                        lastStatusWrite = now;
                        writeStatus();
                    }
                } catch (InterruptedException e) {
                    return;
                } catch (Throwable t) {
                    Ln.w("Studio camera poller: " + t);
                }
            }
        }, "studio-camera");
        poller.setDaemon(true);
        poller.start();

        if (previewReader != null) {
            previewThread = new HandlerThread("studio-preview");
            previewThread.start();
            previewReader.setOnImageAvailableListener(this::onPreviewFrame, new Handler(previewThread.getLooper()));
        }
    }

    public void stop() {
        running = false;
        if (poller != null) {
            poller.interrupt();
        }
        if (previewThread != null) {
            previewThread.quitSafely();
        }
        new File(STATUS).delete();
    }

    private boolean isLive() {
        return "1".equals(get("live", "0"));
    }

    // ------------------------------------------------------------------ conf

    private boolean readConf() {
        File f = new File(CONF);
        if (!f.exists()) {
            return false;
        }
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[8192];
            int n = in.read(buf);
            String raw = n > 0 ? new String(buf, 0, n, StandardCharsets.UTF_8) : "";
            if (raw.equals(lastRaw)) {
                return true;
            }
            Map<String, String> map = new HashMap<>();
            for (String line : raw.split("\n")) {
                int i = line.indexOf('=');
                if (i > 0) {
                    map.put(line.substring(0, i).trim(), line.substring(i + 1).trim());
                }
            }
            conf = map;
            lastRaw = raw;
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private String get(String key, String def) {
        String v = conf.get(key);
        return v == null || v.isEmpty() ? def : v;
    }

    private boolean has(String key) {
        String v = conf.get(key);
        return v != null && !v.isEmpty();
    }

    private float getFloat(String key, float def) {
        try {
            return Float.parseFloat(get(key, String.valueOf(def)));
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private long getLong(String key, long def) {
        try {
            return Long.parseLong(get(key, String.valueOf(def)));
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private int getInt(String key, int def) {
        return (int) getLong(key, def);
    }

    // ------------------------------------------------------------------ apply

    private <T> T c(CameraCharacteristics.Key<T> key) {
        try {
            return chars.get(key);
        } catch (Exception e) {
            return null;
        }
    }

    private boolean hasCapability(int cap) {
        int[] caps = c(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        if (caps != null) {
            for (int x : caps) {
                if (x == cap) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean contains(int[] arr, int v) {
        if (arr != null) {
            for (int x : arr) {
                if (x == v) {
                    return true;
                }
            }
        }
        return false;
    }

    private <T> void safeSet(CaptureRequest.Builder b, CaptureRequest.Key<T> key, T value) {
        try {
            b.set(key, value);
        } catch (Exception e) {
            Ln.w("Studio camera: cannot set " + key.getName() + ": " + e.getMessage());
        }
    }

    /** Apply all settings from the conf file to the request builder. Must be called on the camera thread. */
    public void applyTo(CaptureRequest.Builder b) {
        boolean manualSensor = hasCapability(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR);
        boolean manualPost = hasCapability(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING);

        // ---- scene mode (overrides 3A when enabled)
        int scene = sceneMode(get("scene", "off"));
        if (scene != CameraMetadata.CONTROL_SCENE_MODE_DISABLED && contains(c(CameraCharacteristics.CONTROL_AVAILABLE_SCENE_MODES), scene)) {
            safeSet(b, CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_USE_SCENE_MODE);
            safeSet(b, CaptureRequest.CONTROL_SCENE_MODE, scene);
        } else {
            safeSet(b, CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
            safeSet(b, CaptureRequest.CONTROL_SCENE_MODE, CameraMetadata.CONTROL_SCENE_MODE_DISABLED);
        }

        // ---- exposure
        int fpsMax = getInt("fpsmax", 30);
        if ("manual".equals(get("ae", "auto")) && manualSensor) {
            Range<Long> expRange = c(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
            Range<Integer> isoRange = c(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
            long exp = getLong("exposure", 1_000_000_000L / Math.max(1, fpsMax));
            int iso = getInt("iso", 100);
            if (expRange != null) {
                exp = expRange.clamp(exp);
            }
            if (isoRange != null) {
                iso = isoRange.clamp(iso);
            }
            safeSet(b, CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
            safeSet(b, CaptureRequest.SENSOR_EXPOSURE_TIME, exp);
            safeSet(b, CaptureRequest.SENSOR_SENSITIVITY, iso);
            long frame = Math.max(exp, 1_000_000_000L / Math.max(1, fpsMax));
            Long maxFrame = c(CameraCharacteristics.SENSOR_INFO_MAX_FRAME_DURATION);
            if (maxFrame != null) {
                frame = Math.min(frame, maxFrame);
            }
            safeSet(b, CaptureRequest.SENSOR_FRAME_DURATION, frame);
        } else {
            safeSet(b, CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
            Range<Integer> evRange = c(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
            int ev = getInt("ev", 0);
            if (evRange != null) {
                ev = evRange.clamp(ev);
            }
            safeSet(b, CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, ev);
            safeSet(b, CaptureRequest.CONTROL_AE_LOCK, "1".equals(get("aelock", "0")));
            if (has("fpsmin") || has("fpsmax")) {
                int min = getInt("fpsmin", fpsMax);
                safeSet(b, CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, new Range<>(Math.min(min, fpsMax), fpsMax));
            }
        }

        // ---- anti-banding
        String ab = get("antibanding", "auto");
        int abMode = "off".equals(ab) ? 0 : "50".equals(ab) ? 1 : "60".equals(ab) ? 2 : 3;
        if (contains(c(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES), abMode)) {
            safeSet(b, CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, abMode);
        }

        // ---- metering & focus regions
        Rect active = c(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        float zoom = getFloat("zoom", 1f);
        Integer maxAe = c(CameraCharacteristics.CONTROL_MAX_REGIONS_AE);
        Integer maxAf = c(CameraCharacteristics.CONTROL_MAX_REGIONS_AF);
        String meter = get("meter", "matrix");
        float px = getFloat("px", 0.5f);
        float py = getFloat("py", 0.5f);
        if (active != null && maxAe != null && maxAe > 0) {
            if ("matrix".equals(meter)) {
                if (regionsSet) {
                    safeSet(b, CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[] {new MeteringRectangle(active, MeteringRectangle.METERING_WEIGHT_MIN)});
                }
            } else {
                float size = "spot".equals(meter) ? 0.06f : 0.35f;
                float cx = "spot".equals(meter) ? px : 0.5f;
                float cy = "spot".equals(meter) ? py : 0.5f;
                safeSet(b, CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[] {region(active, zoom, cx, cy, size)});
                regionsSet = true;
            }
        }

        // ---- focus
        String af = get("af", "continuous");
        Float minFocus = c(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        int[] afModes = c(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
        if ("manual".equals(af) && minFocus != null && minFocus > 0 && manualSensor) {
            safeSet(b, CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF);
            float d = Math.max(0, Math.min(minFocus, getFloat("focus", 0)));
            safeSet(b, CaptureRequest.LENS_FOCUS_DISTANCE, d);
        } else {
            int mode = "auto".equals(af) ? CameraMetadata.CONTROL_AF_MODE_AUTO
                    : "macro".equals(af) ? CameraMetadata.CONTROL_AF_MODE_MACRO
                    : "picture".equals(af) ? CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
                    : CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO;
            if (contains(afModes, mode)) {
                safeSet(b, CaptureRequest.CONTROL_AF_MODE, mode);
            }
            if (active != null && maxAf != null && maxAf > 0 && has("fx")) {
                MeteringRectangle r = region(active, zoom, getFloat("fx", 0.5f), getFloat("fy", 0.5f), 0.12f);
                safeSet(b, CaptureRequest.CONTROL_AF_REGIONS, new MeteringRectangle[] {r});
                if (maxAe != null && maxAe > 0 && "matrix".equals(meter)) {
                    safeSet(b, CaptureRequest.CONTROL_AE_REGIONS, new MeteringRectangle[] {region(active, zoom, getFloat("fx", 0.5f), getFloat("fy", 0.5f), 0.2f)});
                    regionsSet = true;
                }
            }
        }

        // ---- white balance
        String awb = get("awb", "auto");
        if ("manual".equals(awb) && manualPost) {
            int kelvin = getInt("kelvin", 5500);
            float tint = getFloat("tint", 0);
            float[] gains = WhiteBalance.gainsForKelvin(chars, kelvin);
            if (gains != null) {
                float g = 1f + tint / 200f;
                safeSet(b, CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_OFF);
                safeSet(b, CaptureRequest.COLOR_CORRECTION_MODE, CameraMetadata.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX);
                safeSet(b, CaptureRequest.COLOR_CORRECTION_GAINS, new RggbChannelVector(gains[0], g, g, gains[2]));
                float[] ccm = WhiteBalance.ccmForKelvin(chars, kelvin);
                ColorSpaceTransform cst = ccm != null ? WhiteBalance.toTransform(WhiteBalance.saturate(ccm, getFloat("saturation", 0)))
                        : lastAutoCcm;
                if (cst != null) {
                    safeSet(b, CaptureRequest.COLOR_CORRECTION_TRANSFORM, cst);
                }
            } else {
                safeSet(b, CaptureRequest.CONTROL_AWB_MODE, WhiteBalance.presetForKelvin(kelvin));
            }
        } else {
            int mode = awbMode(awb);
            if (contains(c(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES), mode)) {
                safeSet(b, CaptureRequest.CONTROL_AWB_MODE, mode);
            }
            safeSet(b, CaptureRequest.COLOR_CORRECTION_MODE, CameraMetadata.COLOR_CORRECTION_MODE_FAST);
            safeSet(b, CaptureRequest.CONTROL_AWB_LOCK, "1".equals(get("awblock", "0")));
        }

        // ---- zoom & torch
        if (has("zoom") && Build.VERSION.SDK_INT >= 30) {
            Range<Float> zr = c(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
            safeSet(b, CaptureRequest.CONTROL_ZOOM_RATIO, zr != null ? zr.clamp(zoom) : zoom);
        }
        if (has("torch")) {
            safeSet(b, CaptureRequest.FLASH_MODE, "1".equals(get("torch", "0")) ? CameraMetadata.FLASH_MODE_TORCH : CameraMetadata.FLASH_MODE_OFF);
        }

        // ---- stabilization
        if (has("ois") && contains(c(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION), 1)) {
            safeSet(b, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, "1".equals(get("ois", "1")) ? 1 : 0);
        }
        if (has("eis")) {
            int eis = "on".equals(get("eis", "off")) ? 1 : "preview".equals(get("eis", "off")) ? 2 : 0;
            if (contains(c(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES), eis)) {
                safeSet(b, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, eis);
            }
        }

        // ---- processing
        if (has("nr")) {
            int nr = modeIndex(get("nr", "fast"), "off", "fast", "hq", "minimal", "zsl");
            if (contains(c(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES), nr)) {
                safeSet(b, CaptureRequest.NOISE_REDUCTION_MODE, nr);
            }
        }
        if (has("edge")) {
            int edge = modeIndex(get("edge", "fast"), "off", "fast", "hq", "zsl");
            if (contains(c(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES), edge)) {
                safeSet(b, CaptureRequest.EDGE_MODE, edge);
            }
        }
        int effect = modeIndex(get("effect", "off"), "off", "mono", "negative", "solarize", "sepia", "posterize", "whiteboard", "blackboard", "aqua");
        if (contains(c(CameraCharacteristics.CONTROL_AVAILABLE_EFFECTS), effect)) {
            safeSet(b, CaptureRequest.CONTROL_EFFECT_MODE, effect);
        }

        // ---- tone curve (contrast / gamma)
        float contrast = getFloat("contrast", 0);
        float gamma = getFloat("gamma", 0);
        int[] toneModes = c(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES);
        if (contrast != 0 && contains(toneModes, CameraMetadata.TONEMAP_MODE_CONTRAST_CURVE)) {
            safeSet(b, CaptureRequest.TONEMAP_MODE, CameraMetadata.TONEMAP_MODE_CONTRAST_CURVE);
            safeSet(b, CaptureRequest.TONEMAP_CURVE, contrastCurve(contrast / 100f));
        } else if (gamma > 0 && contains(toneModes, CameraMetadata.TONEMAP_MODE_GAMMA_VALUE)) {
            safeSet(b, CaptureRequest.TONEMAP_MODE, CameraMetadata.TONEMAP_MODE_GAMMA_VALUE);
            safeSet(b, CaptureRequest.TONEMAP_GAMMA, gamma);
        } else {
            safeSet(b, CaptureRequest.TONEMAP_MODE, contains(toneModes, CameraMetadata.TONEMAP_MODE_HIGH_QUALITY)
                    && "hq".equals(get("tonemap", "fast")) ? CameraMetadata.TONEMAP_MODE_HIGH_QUALITY : CameraMetadata.TONEMAP_MODE_FAST);
        }
    }

    private static MeteringRectangle region(Rect active, float zoom, float x, float y, float size) {
        // Map normalized coordinates of the (zoomed) visible frame to the active array.
        float z = Math.max(1f, zoom);
        float w = active.width(), h = active.height();
        float cx = w / 2f + (x - 0.5f) * w / z;
        float cy = h / 2f + (y - 0.5f) * h / z;
        float half = Math.max(w, h) * size / z / 2f;
        int left = (int) Math.max(0, cx - half);
        int top = (int) Math.max(0, cy - half);
        int right = (int) Math.min(w - 1, cx + half);
        int bottom = (int) Math.min(h - 1, cy + half);
        return new MeteringRectangle(left, top, Math.max(1, right - left), Math.max(1, bottom - top), MeteringRectangle.METERING_WEIGHT_MAX - 1);
    }

    private static TonemapCurve contrastCurve(float k) {
        int n = 64;
        float[] curve = new float[n * 2];
        for (int i = 0; i < n; i++) {
            float x = i / (float) (n - 1);
            // sRGB encode, then an S-curve (k > 0) or its flattening (k < 0)
            float s = x <= 0.0031308f ? 12.92f * x : (float) (1.055 * Math.pow(x, 1 / 2.4) - 0.055);
            float sig = (float) (1 / (1 + Math.exp(-8 * (s - 0.5))));
            float sig0 = (float) (1 / (1 + Math.exp(4))), sig1 = (float) (1 / (1 + Math.exp(-4)));
            float scurve = (sig - sig0) / (sig1 - sig0);
            float y = k >= 0 ? s + (scurve - s) * k : s + (s - scurve) * -k * 0.6f;
            curve[i * 2] = x;
            curve[i * 2 + 1] = Math.max(0, Math.min(1, y));
        }
        return new TonemapCurve(curve, curve, curve);
    }

    private static int modeIndex(String v, String... names) {
        for (int i = 0; i < names.length; i++) {
            if (names[i].equals(v)) {
                return i;
            }
        }
        return 0;
    }

    private static int awbMode(String v) {
        switch (v) {
            case "incandescent": return CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT;
            case "fluorescent": return CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT;
            case "warm-fluorescent": return CameraMetadata.CONTROL_AWB_MODE_WARM_FLUORESCENT;
            case "daylight": return CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT;
            case "cloudy": return CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT;
            case "twilight": return CameraMetadata.CONTROL_AWB_MODE_TWILIGHT;
            case "shade": return CameraMetadata.CONTROL_AWB_MODE_SHADE;
            default: return CameraMetadata.CONTROL_AWB_MODE_AUTO;
        }
    }

    private static final String[] SCENES = {"off", "face-priority", "action", "portrait", "landscape", "night", "night-portrait", "theatre",
            "beach", "snow", "sunset", "steadyphoto", "fireworks", "sports", "party", "candlelight", "barcode", "high-speed-video", "hdr"};

    private static int sceneMode(String v) {
        for (int i = 1; i < SCENES.length; i++) {
            if (SCENES[i].equals(v)) {
                return i;
            }
        }
        return CameraMetadata.CONTROL_SCENE_MODE_DISABLED;
    }

    // ------------------------------------------------------------------ results & status

    public void onResult(TotalCaptureResult result) {
        lastResult = result;
        Integer awb = result.get(CaptureResult.CONTROL_AWB_MODE);
        if (awb != null && awb != CameraMetadata.CONTROL_AWB_MODE_OFF) {
            ColorSpaceTransform t = result.get(CaptureResult.COLOR_CORRECTION_TRANSFORM);
            if (t != null) {
                lastAutoCcm = t;
            }
        }
        long now = System.currentTimeMillis();
        if (fpsWindowStart == 0) {
            fpsWindowStart = now;
        }
        frameCount++;
        if (now - fpsWindowStart >= 1000) {
            measuredFps = frameCount * 1000f / (now - fpsWindowStart);
            frameCount = 0;
            fpsWindowStart = now;
        }
    }

    private void writeStatus() {
        TotalCaptureResult r = lastResult;
        try {
            JSONObject o = new JSONObject();
            o.put("camera", cameraId);
            o.put("t", System.currentTimeMillis());
            o.put("fps", Math.round(measuredFps * 10) / 10.0);
            if (r != null) {
                putIf(o, "iso", r.get(CaptureResult.SENSOR_SENSITIVITY));
                putIf(o, "exposure", r.get(CaptureResult.SENSOR_EXPOSURE_TIME));
                putIf(o, "frame", r.get(CaptureResult.SENSOR_FRAME_DURATION));
                putIf(o, "focus", r.get(CaptureResult.LENS_FOCUS_DISTANCE));
                putIf(o, "afState", r.get(CaptureResult.CONTROL_AF_STATE));
                putIf(o, "aeState", r.get(CaptureResult.CONTROL_AE_STATE));
                putIf(o, "awbState", r.get(CaptureResult.CONTROL_AWB_STATE));
                putIf(o, "aperture", r.get(CaptureResult.LENS_APERTURE));
                putIf(o, "focal", r.get(CaptureResult.LENS_FOCAL_LENGTH));
                putIf(o, "ev", r.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION));
                if (Build.VERSION.SDK_INT >= 30) {
                    putIf(o, "zoom", r.get(CaptureResult.CONTROL_ZOOM_RATIO));
                }
                RggbChannelVector g = r.get(CaptureResult.COLOR_CORRECTION_GAINS);
                if (g != null) {
                    o.put("gains", new JSONArray(new double[] {g.getRed(), g.getGreenEven(), g.getBlue()}));
                    int k = WhiteBalance.kelvinForGains(chars, g.getRed() / g.getGreenEven(), g.getBlue() / g.getGreenEven());
                    if (k > 0) {
                        o.put("kelvin", k);
                    }
                }
            }
            JSONArray hist = new JSONArray();
            for (int v : histogram) {
                hist.put(v);
            }
            o.put("hist", hist);
            writeAtomic(STATUS, o.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Ln.w("Studio camera: status write failed: " + e);
        }
    }

    private static void putIf(JSONObject o, String k, Object v) throws Exception {
        if (v != null) {
            o.put(k, v instanceof Float ? ((Float) v).doubleValue() : v);
        }
    }

    private static void writeAtomic(String path, byte[] data) throws Exception {
        File tmp = new File(path + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
        }
        if (!tmp.renameTo(new File(path))) {
            throw new Exception("rename failed");
        }
    }

    // ------------------------------------------------------------------ preview

    public static ImageReader createPreviewReader(String cameraId, com.genymobile.scrcpy.model.Size captureSize) {
        try {
            CameraManager cm = ServiceManager.getCameraManager();
            StreamConfigurationMap map = cm.getCameraCharacteristics(cameraId).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            Size[] sizes = map.getOutputSizes(ImageFormat.YUV_420_888);
            if (sizes == null || sizes.length == 0) {
                return null;
            }
            float ar = (float) captureSize.getWidth() / captureSize.getHeight();
            Size best = null;
            for (Size s : sizes) {
                float sar = (float) s.getWidth() / s.getHeight();
                if (s.getWidth() < 320 || Math.abs(sar / ar - 1) > 0.05f) {
                    continue;
                }
                if (best == null || s.getWidth() < best.getWidth()) {
                    best = s;
                }
            }
            if (best == null || best.getWidth() > 1280) {
                return null;
            }
            return ImageReader.newInstance(best.getWidth(), best.getHeight(), ImageFormat.YUV_420_888, 2);
        } catch (Exception e) {
            Ln.w("Studio camera: no preview stream: " + e);
            return null;
        }
    }

    private void onPreviewFrame(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) {
                return;
            }
            long now = System.currentTimeMillis();
            boolean preview = "1".equals(get("preview", "0"));
            if (!isLive() || now - lastPreviewWrite < 180) {
                return;
            }
            lastPreviewWrite = now;
            int w = image.getWidth(), h = image.getHeight();
            byte[] nv21 = toNv21(image);
            int[] hist = new int[64];
            for (int i = 0; i < w * h; i += 3) {
                hist[(nv21[i] & 0xff) >> 2]++;
            }
            int max = 1;
            for (int v : hist) {
                max = Math.max(max, v);
            }
            for (int i = 0; i < 64; i++) {
                hist[i] = hist[i] * 255 / max;
            }
            histogram = hist;
            if (preview) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                new YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(new Rect(0, 0, w, h), 62, out);
                writeAtomic(PREVIEW, out.toByteArray());
            }
        } catch (Throwable t) {
            Ln.w("Studio camera: preview failed: " + t);
        } finally {
            if (image != null) {
                image.close();
            }
        }
    }

    private static byte[] toNv21(Image image) {
        int w = image.getWidth(), h = image.getHeight();
        byte[] out = new byte[w * h * 3 / 2];
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer y = planes[0].getBuffer();
        int yRow = planes[0].getRowStride(), yPix = planes[0].getPixelStride();
        int pos = 0;
        for (int row = 0; row < h; row++) {
            for (int col = 0; col < w; col++) {
                out[pos++] = y.get(row * yRow + col * yPix);
            }
        }
        ByteBuffer u = planes[1].getBuffer(), v = planes[2].getBuffer();
        int uvRow = planes[1].getRowStride(), uvPix = planes[1].getPixelStride();
        for (int row = 0; row < h / 2; row++) {
            for (int col = 0; col < w / 2; col++) {
                int i = row * uvRow + col * uvPix;
                out[pos++] = v.get(i);
                out[pos++] = u.get(i);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ capabilities

    /** JSON description of every usable camera, printed by `studio_camera_caps=true`. */
    public static String capsJson() {
        JSONArray list = new JSONArray();
        try {
            CameraManager cm = ServiceManager.getCameraManager();
            for (String id : cm.getCameraIdList()) {
                try {
                    list.put(caps(id, cm.getCameraCharacteristics(id)));
                } catch (Exception e) {
                    Ln.w("Studio camera: caps of " + id + " failed: " + e);
                }
            }
        } catch (Exception e) {
            Ln.e("Studio camera: cannot list cameras", e);
        }
        return list.toString();
    }

    private static JSONObject caps(String id, CameraCharacteristics ch) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", id);
        Integer facing = ch.get(CameraCharacteristics.LENS_FACING);
        o.put("facing", facing == null ? "?" : facing == 0 ? "front" : facing == 1 ? "back" : "external");
        o.put("level", ch.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL));
        o.put("capabilities", arr(ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)));
        Range<Integer> iso = ch.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        if (iso != null) {
            o.put("iso", new JSONArray(new int[] {iso.getLower(), iso.getUpper()}));
        }
        Range<Long> exp = ch.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        if (exp != null) {
            o.put("exposure", new JSONArray(new long[] {exp.getLower(), exp.getUpper()}));
        }
        o.put("maxFrameDuration", ch.get(CameraCharacteristics.SENSOR_INFO_MAX_FRAME_DURATION));
        o.put("minFocus", ch.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE));
        o.put("hyperfocal", ch.get(CameraCharacteristics.LENS_INFO_HYPERFOCAL_DISTANCE));
        o.put("focusCalibration", ch.get(CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION));
        Range<Integer> ev = ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        if (ev != null) {
            o.put("evRange", new JSONArray(new int[] {ev.getLower(), ev.getUpper()}));
        }
        Rational step = ch.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        if (step != null) {
            o.put("evStep", step.doubleValue());
        }
        o.put("afModes", arr(ch.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)));
        o.put("aeModes", arr(ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES)));
        o.put("awbModes", arr(ch.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES)));
        o.put("antibanding", arr(ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES)));
        o.put("effects", arr(ch.get(CameraCharacteristics.CONTROL_AVAILABLE_EFFECTS)));
        o.put("scenes", arr(ch.get(CameraCharacteristics.CONTROL_AVAILABLE_SCENE_MODES)));
        o.put("eis", arr(ch.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)));
        o.put("ois", arr(ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)));
        o.put("nr", arr(ch.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES)));
        o.put("edge", arr(ch.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES)));
        o.put("tonemap", arr(ch.get(CameraCharacteristics.TONEMAP_AVAILABLE_TONE_MAP_MODES)));
        o.put("maxRegionsAe", ch.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE));
        o.put("maxRegionsAf", ch.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF));
        o.put("flash", ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE));
        o.put("sensorOrientation", ch.get(CameraCharacteristics.SENSOR_ORIENTATION));
        o.put("manualWb", WhiteBalance.gainsForKelvin(ch, 5500) != null);
        if (Build.VERSION.SDK_INT >= 30) {
            Range<Float> zr = ch.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
            if (zr != null) {
                o.put("zoom", new JSONArray(new double[] {zr.getLower(), zr.getUpper()}));
            }
        }
        float[] apertures = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES);
        if (apertures != null && apertures.length > 0) {
            o.put("aperture", apertures[0]);
        }
        float[] focals = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        if (focals != null && focals.length > 0) {
            o.put("focal", focals[0]);
        }
        SizeF phys = ch.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        if (phys != null) {
            o.put("sensorSize", new JSONArray(new double[] {phys.getWidth(), phys.getHeight()}));
            if (focals != null && focals.length > 0) {
                // 35mm-equivalent focal length from the sensor diagonal
                double diag = Math.hypot(phys.getWidth(), phys.getHeight());
                o.put("focal35", Math.round(focals[0] * 43.27 / diag));
            }
        }
        Rect active = ch.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
        if (active != null) {
            o.put("active", new JSONArray(new int[] {active.width(), active.height()}));
        }
        Range<Integer>[] fps = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        if (fps != null) {
            JSONArray a = new JSONArray();
            for (Range<Integer> r : fps) {
                a.put(new JSONArray(new int[] {r.getLower(), r.getUpper()}));
            }
            o.put("fpsRanges", a);
        }
        StreamConfigurationMap map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        if (map != null) {
            JSONArray sizes = new JSONArray();
            android.util.Size[] s = map.getOutputSizes(android.media.MediaCodec.class);
            if (s != null) {
                for (android.util.Size x : s) {
                    sizes.put(x.getWidth() + "x" + x.getHeight());
                }
            }
            o.put("sizes", sizes);
            JSONArray hs = new JSONArray();
            android.util.Size[] h = map.getHighSpeedVideoSizes();
            if (h != null) {
                for (android.util.Size x : h) {
                    for (Range<Integer> r : map.getHighSpeedVideoFpsRangesFor(x)) {
                        hs.put(x.getWidth() + "x" + x.getHeight() + "@" + r.getUpper());
                    }
                }
            }
            o.put("highSpeed", hs);
        }
        return o;
    }

    private static JSONArray arr(int[] a) {
        JSONArray j = new JSONArray();
        if (a != null) {
            for (int x : a) {
                j.put(x);
            }
        }
        return j;
    }
}
