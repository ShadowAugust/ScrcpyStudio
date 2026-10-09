package com.genymobile.scrcpy.video;

import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.params.ColorSpaceTransform;

/**
 * Kelvin white balance using the sensor calibration published by the camera HAL (DNG color model):
 * ColorMatrix1/2 (XYZ -> camera), CalibrationTransform1/2 and ForwardMatrix1/2, interpolated in inverse CCT.
 */
final class WhiteBalance {

    private WhiteBalance() {
    }

    private static final float[] XYZ_D50_TO_SRGB = {
            3.1338561f, -1.6168667f, -0.4906146f,
            -0.9787684f, 1.9161415f, 0.0334540f,
            0.0719453f, -0.2289914f, 1.4052427f,
    };

    static int illuminantKelvin(Integer illuminant) {
        if (illuminant == null) {
            return 0;
        }
        switch (illuminant) {
            case 1: case 4: case 9: return 5500;   // daylight, flash, fine weather
            case 2: return 4200;                   // fluorescent
            case 3: case 17: return 2856;          // tungsten, standard A
            case 10: return 6500;                  // cloudy
            case 11: return 7500;                  // shade
            case 12: return 6400;
            case 13: return 5000;
            case 14: return 4150;
            case 15: return 3450;
            case 18: return 4874;
            case 19: return 6774;
            case 20: return 5503;
            case 21: return 6504;                  // D65
            case 22: return 7504;
            case 23: return 5003;                  // D50
            case 24: return 3200;                  // studio tungsten
            default: return 0;
        }
    }

    private static float[] m(ColorSpaceTransform t) {
        if (t == null) {
            return null;
        }
        float[] out = new float[9];
        for (int r = 0; r < 3; r++) {
            for (int c = 0; c < 3; c++) {
                out[r * 3 + c] = t.getElement(c, r).floatValue();
            }
        }
        return out;
    }

    private static float[] mul(float[] a, float[] b) {
        float[] o = new float[9];
        for (int r = 0; r < 3; r++) {
            for (int c = 0; c < 3; c++) {
                o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
            }
        }
        return o;
    }

    private static float[] mulv(float[] a, float[] v) {
        return new float[] {
                a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
                a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
                a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
        };
    }

    private static float[] lerp(float[] a, float[] b, float g) {
        if (a == null) {
            return b;
        }
        if (b == null) {
            return a;
        }
        float[] o = new float[9];
        for (int i = 0; i < 9; i++) {
            o[i] = a[i] * g + b[i] * (1 - g);
        }
        return o;
    }

    private static final float[] IDENTITY = {1, 0, 0, 0, 1, 0, 0, 0, 1};

    /** Weight of calibration 1 for the given temperature (interpolation in mired space). */
    private static float weight(CameraCharacteristics ch, int kelvin) {
        int t1 = illuminantKelvin(ch.get(CameraCharacteristics.SENSOR_REFERENCE_ILLUMINANT1));
        Byte i2 = null;
        try {
            i2 = ch.get(CameraCharacteristics.SENSOR_REFERENCE_ILLUMINANT2);
        } catch (Exception ignored) {
            // optional
        }
        int t2 = illuminantKelvin(i2 == null ? null : (int) i2);
        if (t1 == 0 || t2 == 0 || t1 == t2) {
            return 1;
        }
        float g = (1f / kelvin - 1f / t2) / (1f / t1 - 1f / t2);
        return Math.max(0, Math.min(1, g));
    }

    /** CIE 1931 xy of the Planckian locus (Kim et al. approximation), returned as XYZ with Y = 1. */
    static float[] xyzForKelvin(int kelvin) {
        double t = Math.max(1667, Math.min(25000, kelvin));
        double x = t <= 4000
                ? -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.179910
                : -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.240390;
        double y = t <= 2222 ? -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683
                : t <= 4000 ? -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
                : 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
        return new float[] {(float) (x / y), 1f, (float) ((1 - x - y) / y)};
    }

    /** RGB gains (G = 1) that neutralize a light source of the given temperature, or null if uncalibrated. */
    static float[] gainsForKelvin(CameraCharacteristics ch, int kelvin) {
        try {
            float[] cm1 = m(ch.get(CameraCharacteristics.SENSOR_COLOR_TRANSFORM1));
            float[] cm2 = m(ch.get(CameraCharacteristics.SENSOR_COLOR_TRANSFORM2));
            if (cm1 == null && cm2 == null) {
                return null;
            }
            float g = weight(ch, kelvin);
            float[] cm = lerp(cm1, cm2, g);
            float[] cc1 = m(ch.get(CameraCharacteristics.SENSOR_CALIBRATION_TRANSFORM1));
            float[] cc2 = m(ch.get(CameraCharacteristics.SENSOR_CALIBRATION_TRANSFORM2));
            float[] cc = lerp(cc1 == null ? IDENTITY : cc1, cc2 == null ? IDENTITY : cc2, g);
            float[] neutral = mulv(mul(cc, cm), xyzForKelvin(kelvin));
            if (neutral[0] <= 0 || neutral[1] <= 0 || neutral[2] <= 0) {
                return null;
            }
            return new float[] {neutral[1] / neutral[0], 1f, neutral[1] / neutral[2]};
        } catch (Exception e) {
            return null;
        }
    }

    /** Color correction matrix (white-balanced camera RGB -> linear sRGB) for the temperature. */
    static float[] ccmForKelvin(CameraCharacteristics ch, int kelvin) {
        try {
            float[] fm1 = m(ch.get(CameraCharacteristics.SENSOR_FORWARD_MATRIX1));
            float[] fm2 = m(ch.get(CameraCharacteristics.SENSOR_FORWARD_MATRIX2));
            if (fm1 == null && fm2 == null) {
                return null;
            }
            float[] fm = lerp(fm1, fm2, weight(ch, kelvin));
            float[] ccm = mul(XYZ_D50_TO_SRGB, fm);
            // Normalize so that white maps to white (rows sum to 1)
            for (int r = 0; r < 3; r++) {
                float s = ccm[r * 3] + ccm[r * 3 + 1] + ccm[r * 3 + 2];
                if (s > 0.01f) {
                    for (int c = 0; c < 3; c++) {
                        ccm[r * 3 + c] /= s;
                    }
                }
            }
            return ccm;
        } catch (Exception e) {
            return null;
        }
    }

    /** Apply a saturation adjustment (-100..100) on top of a CCM. */
    static float[] saturate(float[] ccm, float amount) {
        if (amount == 0) {
            return ccm;
        }
        float s = 1 + amount / 100f;
        float lr = 0.2126f, lg = 0.7152f, lb = 0.0722f;
        float[] sat = {
                lr + (1 - lr) * s, lg - lg * s, lb - lb * s,
                lr - lr * s, lg + (1 - lg) * s, lb - lb * s,
                lr - lr * s, lg - lg * s, lb + (1 - lb) * s,
        };
        return mul(sat, ccm);
    }

    static ColorSpaceTransform toTransform(float[] ccm) {
        int[] el = new int[18];
        for (int i = 0; i < 9; i++) {
            el[i * 2] = Math.round(ccm[i] * 10000);
            el[i * 2 + 1] = 10000;
        }
        return new ColorSpaceTransform(el);
    }

    /** Estimate the scene color temperature from AWB gains (r/g, b/g). */
    static int kelvinForGains(CameraCharacteristics ch, float rg, float bg) {
        int best = 0;
        double bestErr = Double.MAX_VALUE;
        for (int k = 2000; k <= 10000; k += 50) {
            float[] g = gainsForKelvin(ch, k);
            if (g == null) {
                return 0;
            }
            double err = Math.pow(Math.log(g[0] / rg), 2) + Math.pow(Math.log(g[2] / bg), 2);
            if (err < bestErr) {
                bestErr = err;
                best = k;
            }
        }
        return best;
    }

    static int presetForKelvin(int k) {
        if (k < 3300) {
            return CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT;
        }
        if (k < 4000) {
            return CameraMetadata.CONTROL_AWB_MODE_WARM_FLUORESCENT;
        }
        if (k < 4900) {
            return CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT;
        }
        if (k < 6000) {
            return CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT;
        }
        if (k < 7000) {
            return CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT;
        }
        return CameraMetadata.CONTROL_AWB_MODE_SHADE;
    }
}
