// Scrcpy Studio virtual camera / microphone bridge.
//
// Connects to a scrcpy server (tunnel_forward mode) through an adb-forwarded
// TCP port, decodes the H.264 video with the Media Foundation decoder and
// publishes it to:
//   * the "Scrcpy Studio Camera" DirectShow virtual webcam (softcam sender API)
//   * an NDI source (video + audio), if the NDI runtime is installed
// Raw PCM audio (48 kHz, s16le, stereo) is played to a chosen WASAPI render
// endpoint (e.g. a virtual audio cable -> becomes a microphone) and/or NDI.
//
// Speaker mode (--speaker) does the opposite: captures a Windows audio endpoint
// (loopback of an output, e.g. a virtual cable, or a capture device) and streams
// it as raw PCM to the Studio "Speaker" player on the phone.
//
// Status is printed as JSON lines on stdout. Closing stdin stops the bridge.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <initguid.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mferror.h>
#include <wmcodecdsp.h>
#include <codecapi.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <devpkey.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <execution>
#include <mutex>
#include <numeric>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "wmcodecdspuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "advapi32.lib")

// ------------------------------------------------------------------ utils
static std::mutex g_out;
static void emit(const std::string& json) {
    std::lock_guard<std::mutex> lock(g_out);
    fputs(json.c_str(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}
static std::string esc(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += c; }
        else if ((unsigned char)c < 0x20) o += ' ';
        else o += c;
    }
    return o;
}
static void logmsg(const char* level, const std::string& msg) {
    emit(std::string("{\"event\":\"log\",\"level\":\"") + level + "\",\"message\":\"" + esc(msg) + "\"}");
}
static std::string narrow(const wchar_t* w) {
    if (!w) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string s(n > 0 ? n - 1 : 0, '\0');
    if (n > 1) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
    return s;
}
static std::wstring widen(const std::string& s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring w(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
    return w;
}
static std::wstring lower(std::wstring s) { for (auto& c : s) c = (wchar_t)towlower(c); return s; }

template <class T> static void release(T*& p) { if (p) { p->Release(); p = nullptr; } }

static uint32_t be32(const uint8_t* p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }
static uint64_t be64(const uint8_t* p) { return (uint64_t)be32(p) << 32 | be32(p + 4); }

// ------------------------------------------------------------------ options
struct Options {
    int port = 0;
    bool video = true;
    bool audio = true;
    int width = 1920, height = 1080;
    int fps = 30;
    bool cover = false;     // crop to fill instead of letterbox
    bool mirror = false;
    std::wstring softcamDll;
    std::string ndiName;
    std::wstring audioDevice;  // substring of a render endpoint name, "id:<endpoint id>", "default" or empty
    bool monitor = false;
    // speaker mode
    bool speaker = false;
    std::wstring capture;      // "id:<endpoint id>" / name substring / "default" (loopback of the default output)
};

static uint64_t nowMs() { return GetTickCount64(); }

// Peak meter, reported at most 10 times per second.
struct LevelMeter {
    const char* key;
    float peak = 0;
    uint64_t last = 0;
    void feed(const int16_t* pcm, size_t samples) {
        int m = 0;
        for (size_t i = 0; i < samples; i++) m = std::max(m, std::abs((int)pcm[i]));
        peak = std::max(peak, m / 32768.0f);
        uint64_t t = nowMs();
        if (t - last >= 100) {
            char buf[96];
            snprintf(buf, sizeof(buf), "{\"event\":\"level\",\"%s\":%.3f}", key, peak);
            emit(buf);
            peak = 0;
            last = t;
        }
    }
};

// ------------------------------------------------------------------ sockets
static bool recvAll(SOCKET s, uint8_t* buf, size_t len) {
    while (len) {
        int r = recv(s, (char*)buf, (int)std::min<size_t>(len, 1 << 20), 0);
        if (r <= 0) return false;
        buf += r;
        len -= (size_t)r;
    }
    return true;
}

static SOCKET connectPort(int port) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return s;
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
    if (connect(s, (sockaddr*)&a, sizeof(a)) != 0) { closesocket(s); return INVALID_SOCKET; }
    int one = 1;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char*)&one, sizeof(one));
    return s;
}

// In forward mode adb accepts immediately even if the server is not listening yet;
// the server sends one dummy byte on the first socket once it really accepted it.
static SOCKET connectFirst(int port, int attempts) {
    for (int i = 0; i < attempts; i++) {
        SOCKET s = connectPort(port);
        if (s != INVALID_SOCKET) {
            DWORD tmo = 1500;
            setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof(tmo));
            uint8_t b;
            if (recv(s, (char*)&b, 1, 0) == 1) {
                tmo = 0;
                setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof(tmo));
                return s;
            }
            closesocket(s);
        }
        Sleep(150);
    }
    return INVALID_SOCKET;
}

// ------------------------------------------------------------------ frames
struct Nv12Frame {
    const uint8_t* y;
    const uint8_t* uv;
    int pitch;
    int width, height;
};

// ------------------------------------------------------------------ NDI (dynamically loaded)
struct NdiSendCreate { const char* p_ndi_name; const char* p_groups; bool clock_video; bool clock_audio; };
struct NdiVideoFrameV2 {
    int xres, yres;
    uint32_t FourCC;
    int frame_rate_N, frame_rate_D;
    float picture_aspect_ratio;
    int frame_format_type;
    int64_t timecode;
    uint8_t* p_data;
    int line_stride_in_bytes;
    const char* p_metadata;
    int64_t timestamp;
};
struct NdiAudioInterleaved16s {
    int sample_rate, no_channels, no_samples;
    int64_t timecode;
    int reference_level;
    int16_t* p_data;
};
static const int64_t NDI_TIMECODE_SYNTH = INT64_MAX;
static constexpr uint32_t fourcc(char a, char b, char c, char d) { return (uint32_t)a | (uint32_t)b << 8 | (uint32_t)c << 16 | (uint32_t)d << 24; }

class NdiSink {
public:
    bool open(const std::string& name, int fps) {
        const wchar_t* vars[] = { L"NDI_RUNTIME_DIR_V6", L"NDI_RUNTIME_DIR_V5", L"NDI_RUNTIME_DIR_V4" };
        for (auto v : vars) {
            wchar_t dir[MAX_PATH];
            if (GetEnvironmentVariableW(v, dir, MAX_PATH)) {
                std::wstring p = std::wstring(dir) + L"\\Processing.NDI.Lib.x64.dll";
                lib = LoadLibraryW(p.c_str());
                if (lib) break;
            }
        }
        if (!lib) lib = LoadLibraryW(L"Processing.NDI.Lib.x64.dll");
        if (!lib) { logmsg("warn", "NDI runtime not found"); return false; }
        initialize = (bool (*)())GetProcAddress(lib, "NDIlib_initialize");
        create = (void* (*)(const NdiSendCreate*))GetProcAddress(lib, "NDIlib_send_create");
        destroySend = (void (*)(void*))GetProcAddress(lib, "NDIlib_send_destroy");
        sendVideo = (void (*)(void*, const NdiVideoFrameV2*))GetProcAddress(lib, "NDIlib_send_send_video_v2");
        sendAudio16 = (void (*)(void*, const NdiAudioInterleaved16s*))GetProcAddress(lib, "NDIlib_util_send_send_audio_interleaved_16s");
        connections = (int (*)(void*, uint32_t))GetProcAddress(lib, "NDIlib_send_get_no_connections");
        if (!initialize || !create || !sendVideo || !initialize()) { logmsg("error", "NDI runtime could not be initialized"); return false; }
        NdiSendCreate c{ name.c_str(), nullptr, false, false };
        inst = create(&c);
        this->fps = fps;
        if (!inst) { logmsg("error", "NDI sender could not be created"); return false; }
        return true;
    }
    void video(const Nv12Frame& f, bool mirror) {
        if (!inst) return;
        // NDI wants the UV plane right after yres lines of Y: repack.
        const int w = f.width, h = f.height;
        buf.resize((size_t)w * h * 3 / 2);
        for (int y = 0; y < h; y++) {
            const uint8_t* src = f.y + (size_t)y * f.pitch;
            uint8_t* dst = buf.data() + (size_t)y * w;
            if (!mirror) memcpy(dst, src, w);
            else for (int x = 0; x < w; x++) dst[x] = src[w - 1 - x];
        }
        uint8_t* uvDst = buf.data() + (size_t)w * h;
        for (int y = 0; y < h / 2; y++) {
            const uint8_t* src = f.uv + (size_t)y * f.pitch;
            uint8_t* dst = uvDst + (size_t)y * w;
            if (!mirror) memcpy(dst, src, w);
            else for (int x = 0; x < w / 2; x++) { dst[x * 2] = src[w - 2 - x * 2]; dst[x * 2 + 1] = src[w - 1 - x * 2]; }
        }
        NdiVideoFrameV2 v{};
        v.xres = w; v.yres = h;
        v.FourCC = fourcc('N', 'V', '1', '2');
        v.frame_rate_N = fps * 1000; v.frame_rate_D = 1000;
        v.picture_aspect_ratio = (float)w / (float)h;
        v.frame_format_type = 1; // progressive
        v.timecode = NDI_TIMECODE_SYNTH;
        v.p_data = buf.data();
        v.line_stride_in_bytes = w;
        std::lock_guard<std::mutex> lock(m);
        sendVideo(inst, &v);
    }
    void audio(const int16_t* pcm, int frames) {
        if (!inst || !sendAudio16) return;
        NdiAudioInterleaved16s a{};
        a.sample_rate = 48000; a.no_channels = 2; a.no_samples = frames;
        a.timecode = NDI_TIMECODE_SYNTH;
        a.reference_level = 0;
        a.p_data = const_cast<int16_t*>(pcm);
        std::lock_guard<std::mutex> lock(m);
        sendAudio16(inst, &a);
    }
    int clients() { return inst && connections ? connections(inst, 0) : 0; }
    void close() { if (inst && destroySend) destroySend(inst); inst = nullptr; }
    bool active() const { return inst != nullptr; }
private:
    HMODULE lib = nullptr;
    void* inst = nullptr;
    int fps = 30;
    std::vector<uint8_t> buf;
    std::mutex m;
    bool (*initialize)() = nullptr;
    void* (*create)(const NdiSendCreate*) = nullptr;
    void (*destroySend)(void*) = nullptr;
    void (*sendVideo)(void*, const NdiVideoFrameV2*) = nullptr;
    void (*sendAudio16)(void*, const NdiAudioInterleaved16s*) = nullptr;
    int (*connections)(void*, uint32_t) = nullptr;
};

// ------------------------------------------------------------------ softcam sink
class SoftcamSink {
public:
    bool open(const std::wstring& dll, int w, int h, int fps) {
        lib = LoadLibraryW(dll.c_str());
        if (!lib) { logmsg("error", "Virtual camera DLL could not be loaded"); return false; }
        create = (void* (__cdecl*)(int, int, float))GetProcAddress(lib, "scCreateCamera");
        del = (void(__cdecl*)(void*))GetProcAddress(lib, "scDeleteCamera");
        send = (void(__cdecl*)(void*, const void*))GetProcAddress(lib, "scSendFrame");
        connected = (bool(__cdecl*)(void*))GetProcAddress(lib, "scIsConnected");
        if (!create || !send) return false;
        W = w & ~3; H = h & ~3;
        cam = create(W, H, (float)fps);
        if (!cam) { logmsg("error", "Virtual camera is busy (another sender is running)"); return false; }
        bgr.assign((size_t)W * H * 3, 0);
        return true;
    }
    // NV12 -> BGR24 (top-down) with letterbox/crop scaling, parallelized over rows.
    void video(const Nv12Frame& f, bool cover, bool mirror, bool bt709) {
        if (!cam) return;
        const double sx = (double)W / f.width, sy = (double)H / f.height;
        const double s = cover ? std::max(sx, sy) : std::min(sx, sy);
        const int dw = std::max(1, (int)(f.width * s + 0.5)), dh = std::max(1, (int)(f.height * s + 0.5));
        const int ox = (W - dw) / 2, oy = (H - dh) / 2;
        if (xmap.size() != (size_t)W || lastW != f.width || lastH != f.height || lastCover != cover || lastMirror != mirror) {
            xmap.assign(W, -1);
            for (int x = 0; x < W; x++) {
                int dx = x - ox;
                if (dx < 0 || dx >= dw) continue;
                int src = std::min(f.width - 1, (int)((dx + 0.5) / s));
                xmap[x] = mirror ? f.width - 1 - src : src;
            }
            lastW = f.width; lastH = f.height; lastCover = cover; lastMirror = mirror;
            std::fill(bgr.begin(), bgr.end(), 0);
        }
        // BT.709 / BT.601 limited range, 10-bit fixed point
        const int cy = 1192, crv = bt709 ? 1836 : 1634, cgu = bt709 ? 218 : 401, cgv = bt709 ? 546 : 833, cbu = bt709 ? 2163 : 2066;
        const int bands = 16;
        std::vector<int> idx(bands);
        std::iota(idx.begin(), idx.end(), 0);
        std::for_each(std::execution::par, idx.begin(), idx.end(), [&](int band) {
            int y0 = H * band / bands, y1 = H * (band + 1) / bands;
            for (int y = y0; y < y1; y++) {
                uint8_t* out = bgr.data() + (size_t)y * W * 3;
                int dy = y - oy;
                if (dy < 0 || dy >= dh) continue;
                int syy = std::min(f.height - 1, (int)((dy + 0.5) / s));
                const uint8_t* Y = f.y + (size_t)syy * f.pitch;
                const uint8_t* UV = f.uv + (size_t)(syy / 2) * f.pitch;
                for (int x = 0; x < W; x++) {
                    int sxx = xmap[x];
                    if (sxx < 0) { out += 3; continue; }
                    int yy = (Y[sxx] - 16) * cy;
                    int u = UV[sxx & ~1] - 128, v = UV[(sxx & ~1) + 1] - 128;
                    int r = (yy + crv * v) >> 10, g = (yy - cgu * u - cgv * v) >> 10, b = (yy + cbu * u) >> 10;
                    out[0] = (uint8_t)std::clamp(b, 0, 255);
                    out[1] = (uint8_t)std::clamp(g, 0, 255);
                    out[2] = (uint8_t)std::clamp(r, 0, 255);
                    out += 3;
                }
            }
        });
        send(cam, bgr.data());
    }
    bool isConnected() { return cam && connected && connected(cam); }
    void close() { if (cam && del) del(cam); cam = nullptr; }
    bool active() const { return cam != nullptr; }
private:
    HMODULE lib = nullptr;
    void* cam = nullptr;
    int W = 0, H = 0;
    std::vector<uint8_t> bgr;
    std::vector<int> xmap;
    int lastW = 0, lastH = 0;
    bool lastCover = false, lastMirror = false;
    void* (__cdecl* create)(int, int, float) = nullptr;
    void(__cdecl* del)(void*) = nullptr;
    void(__cdecl* send)(void*, const void*) = nullptr;
    bool(__cdecl* connected)(void*) = nullptr;
};

// ------------------------------------------------------------------ endpoints
static std::string endpointProp(IMMDevice* d, const PROPERTYKEY& key) {
    std::string out;
    IPropertyStore* ps = nullptr;
    if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, &ps))) {
        PROPVARIANT pv; PropVariantInit(&pv);
        if (SUCCEEDED(ps->GetValue(key, &pv)) && pv.vt == VT_LPWSTR) out = narrow(pv.pwszVal);
        PropVariantClear(&pv);
        ps->Release();
    }
    return out;
}

// match: "id:<endpoint id>", "default", or a case-insensitive substring of the friendly name.
static IMMDevice* findEndpoint(EDataFlow flow, const std::wstring& match, std::string* nameOut, EDataFlow* flowOut = nullptr) {
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) return nullptr;
    IMMDevice* dev = nullptr;
    if (match.empty() || lower(match) == L"default") {
        en->GetDefaultAudioEndpoint(flow == eAll ? eRender : flow, eConsole, &dev);
    } else if (match.rfind(L"id:", 0) == 0) {
        en->GetDevice(match.substr(3).c_str(), &dev);
    } else {
        IMMDeviceCollection* col = nullptr;
        en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col);
        UINT n = 0;
        if (col) col->GetCount(&n);
        std::string want = narrow(lower(match).c_str());
        for (UINT i = 0; i < n && !dev; i++) {
            IMMDevice* d = nullptr;
            col->Item(i, &d);
            std::string name = endpointProp(d, PKEY_Device_FriendlyName);
            std::wstring wl = lower(widen(name));
            if (wl.find(widen(want)) != std::wstring::npos) { dev = d; d = nullptr; }
            release(d);
        }
        release(col);
    }
    release(en);
    if (dev) {
        if (nameOut) *nameOut = endpointProp(dev, PKEY_Device_FriendlyName);
        if (flowOut) {
            IMMEndpoint* ep = nullptr;
            *flowOut = eRender;
            if (SUCCEEDED(dev->QueryInterface(IID_PPV_ARGS(&ep)))) { ep->GetDataFlow(flowOut); ep->Release(); }
        }
    }
    return dev;
}

// ------------------------------------------------------------------ WASAPI audio sink
class WasapiSink {
public:
    bool open(const std::wstring& match) {
        IMMDevice* dev = findEndpoint(eRender, match, &name);
        if (!dev) { logmsg("error", "Audio output device not found: " + narrow(match.c_str())); return false; }
        if (name.empty()) name = "default";
        HRESULT hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
        release(dev);
        if (FAILED(hr)) return false;
        WAVEFORMATEX fmt{};
        fmt.wFormatTag = WAVE_FORMAT_PCM;
        fmt.nChannels = 2;
        fmt.nSamplesPerSec = 48000;
        fmt.wBitsPerSample = 16;
        fmt.nBlockAlign = 4;
        fmt.nAvgBytesPerSec = 48000 * 4;
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                2000000 /* 200 ms */, 0, &fmt, nullptr);
        if (FAILED(hr)) { logmsg("error", "Audio device rejected the stream format"); release(client); return false; }
        client->GetBufferSize(&bufferFrames);
        if (FAILED(client->GetService(IID_PPV_ARGS(&render)))) { release(client); return false; }
        client->Start();
        return true;
    }
    void write(const int16_t* pcm, UINT32 frames) {
        if (!render) return;
        UINT32 padding = 0;
        client->GetCurrentPadding(&padding);
        // Keep latency low: if more than ~120 ms is queued (clock drift), drop this chunk.
        if (padding > 48000 * 12 / 100) { dropped += frames; return; }
        UINT32 n = std::min(frames, bufferFrames - padding);
        BYTE* dst = nullptr;
        if (n && SUCCEEDED(render->GetBuffer(n, &dst))) {
            memcpy(dst, pcm, (size_t)n * 4);
            render->ReleaseBuffer(n, 0);
        }
    }
    void close() { if (client) client->Stop(); release(render); release(client); }
    bool active() const { return render != nullptr; }
    std::string name;
    uint64_t dropped = 0;
private:
    IAudioClient* client = nullptr;
    IAudioRenderClient* render = nullptr;
    UINT32 bufferFrames = 0;
};

// ------------------------------------------------------------------ H.264 decoder (Media Foundation)
class Decoder {
public:
    bool init(int w, int h) {
        release(mft);
        HRESULT hr = CoCreateInstance(CLSID_CMSH264DecoderMFT, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&mft));
        if (FAILED(hr)) { logmsg("error", "H.264 decoder unavailable"); return false; }
        ICodecAPI* api = nullptr;
        if (SUCCEEDED(mft->QueryInterface(IID_PPV_ARGS(&api)))) {
            VARIANT v; VariantInit(&v); v.vt = VT_UI4; v.ulVal = 1;
            api->SetValue(&CODECAPI_AVLowLatencyMode, &v);
            api->Release();
        }
        IMFMediaType* in = nullptr;
        MFCreateMediaType(&in);
        in->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        in->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        MFSetAttributeSize(in, MF_MT_FRAME_SIZE, w, h);
        MFSetAttributeRatio(in, MF_MT_FRAME_RATE, 30, 1);
        in->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        hr = mft->SetInputType(0, in, 0);
        in->Release();
        if (FAILED(hr)) { logmsg("error", "Decoder rejected the input type"); return false; }
        if (!selectOutput()) return false;
        mft->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
        mft->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        dispW = w; dispH = h;
        return true;
    }

    template <class F> bool decode(const uint8_t* data, size_t len, int64_t ptsUs, F&& onFrame) {
        if (!mft) return false;
        IMFSample* sample = nullptr;
        IMFMediaBuffer* buf = nullptr;
        MFCreateMemoryBuffer((DWORD)len, &buf);
        BYTE* p = nullptr;
        buf->Lock(&p, nullptr, nullptr);
        memcpy(p, data, len);
        buf->Unlock();
        buf->SetCurrentLength((DWORD)len);
        MFCreateSample(&sample);
        sample->AddBuffer(buf);
        sample->SetSampleTime(ptsUs * 10);
        HRESULT hr = mft->ProcessInput(0, sample, 0);
        if (hr == MF_E_NOTACCEPTING) {
            drain(onFrame);
            hr = mft->ProcessInput(0, sample, 0);
        }
        release(buf);
        release(sample);
        drain(onFrame);
        return SUCCEEDED(hr);
    }

    int dispW = 0, dispH = 0;

private:
    bool selectOutput() {
        for (DWORD i = 0;; i++) {
            IMFMediaType* t = nullptr;
            if (FAILED(mft->GetOutputAvailableType(0, i, &t))) break;
            GUID sub{};
            t->GetGUID(MF_MT_SUBTYPE, &sub);
            if (sub == MFVideoFormat_NV12) {
                HRESULT hr = mft->SetOutputType(0, t, 0);
                UINT32 w = 0, h = 0;
                MFGetAttributeSize(t, MF_MT_FRAME_SIZE, &w, &h);
                bufW = (int)w; bufH = (int)h;
                UINT32 stride = 0;
                stride = MFGetAttributeUINT32(t, MF_MT_DEFAULT_STRIDE, w);
                defStride = (int)stride;
                MFVideoArea area{};
                if (SUCCEEDED(t->GetBlob(MF_MT_MINIMUM_DISPLAY_APERTURE, (UINT8*)&area, sizeof(area), nullptr))) {
                    apertureW = area.Area.cx; apertureH = area.Area.cy;
                } else { apertureW = 0; apertureH = 0; }
                t->Release();
                return SUCCEEDED(hr);
            }
            t->Release();
        }
        logmsg("error", "Decoder has no NV12 output");
        return false;
    }

    template <class F> void drain(F&& onFrame) {
        for (;;) {
            MFT_OUTPUT_STREAM_INFO info{};
            mft->GetOutputStreamInfo(0, &info);
            IMFSample* out = nullptr;
            IMFMediaBuffer* ob = nullptr;
            bool provides = (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
            if (!provides) {
                MFCreateSample(&out);
                MFCreateMemoryBuffer(info.cbSize ? info.cbSize : (DWORD)(bufW * bufH * 3 / 2 + 4096), &ob);
                out->AddBuffer(ob);
            }
            MFT_OUTPUT_DATA_BUFFER db{};
            db.pSample = out;
            DWORD status = 0;
            HRESULT hr = mft->ProcessOutput(0, 1, &db, &status);
            if (db.pEvents) db.pEvents->Release();
            if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) { release(ob); release(out); break; }
            if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
                release(ob); release(out);
                if (!selectOutput()) break;
                continue;
            }
            if (FAILED(hr)) { release(ob); release(out); break; }
            IMFSample* s = db.pSample;
            IMFMediaBuffer* mb = nullptr;
            if (s && SUCCEEDED(s->ConvertToContiguousBuffer(&mb))) {
                BYTE* base = nullptr;
                LONG pitch = 0;
                IMF2DBuffer* b2 = nullptr;
                bool locked2d = false;
                if (SUCCEEDED(mb->QueryInterface(IID_PPV_ARGS(&b2))) && SUCCEEDED(b2->Lock2D(&base, &pitch))) locked2d = true;
                DWORD maxLen = 0, curLen = 0;
                if (!locked2d) { mb->Lock(&base, &maxLen, &curLen); pitch = defStride > 0 ? defStride : bufW; }
                if (base && pitch > 0) {
                    Nv12Frame f;
                    f.y = base;
                    f.uv = base + (size_t)pitch * bufH;
                    f.pitch = (int)pitch;
                    f.width = std::min(bufW, apertureW > 0 ? apertureW : (dispW ? dispW : bufW)) & ~1;
                    f.height = std::min(bufH, apertureH > 0 ? apertureH : (dispH ? dispH : bufH)) & ~1;
                    onFrame(f);
                }
                if (locked2d) b2->Unlock2D(); else mb->Unlock();
                release(b2);
                release(mb);
            }
            if (s != out) release(s);
            release(ob);
            release(out);
        }
    }

    IMFTransform* mft = nullptr;
    int bufW = 0, bufH = 0, defStride = 0, apertureW = 0, apertureH = 0;
};

// ------------------------------------------------------------------ device listing
static void listAudio() {
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) { puts("[]"); return; }
    std::wstring defId;
    IMMDevice* def = nullptr;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &def))) {
        LPWSTR id = nullptr;
        def->GetId(&id);
        if (id) { defId = id; CoTaskMemFree(id); }
        def->Release();
    }
    std::wstring defCapId;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(eCapture, eConsole, &def))) {
        LPWSTR id = nullptr;
        def->GetId(&id);
        if (id) { defCapId = id; CoTaskMemFree(id); }
        def->Release();
    }
    std::string out = "[";
    for (EDataFlow flow : { eRender, eCapture }) {
        IMMDeviceCollection* col = nullptr;
        en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col);
        UINT n = 0;
        if (col) col->GetCount(&n);
        for (UINT i = 0; i < n; i++) {
            IMMDevice* d = nullptr;
            col->Item(i, &d);
            IPropertyStore* ps = nullptr;
            LPWSTR id = nullptr;
            d->GetId(&id);
            if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, &ps))) {
                PROPVARIANT pv; PropVariantInit(&pv);
                if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &pv)) && pv.vt == VT_LPWSTR) {
                    if (out.size() > 1) out += ",";
                    out += "{\"name\":\"" + esc(narrow(pv.pwszVal)) + "\",\"flow\":\"" + (flow == eRender ? "render" : "capture") +
                           "\",\"default\":" + (id && (flow == eRender ? defId : defCapId) == id ? "true" : "false") +
                           ",\"id\":\"" + esc(narrow(id)) + "\",\"desc\":\"" + esc(endpointProp(d, PKEY_Device_DeviceDesc)) +
                           "\",\"iface\":\"" + esc(endpointProp(d, PKEY_DeviceInterface_FriendlyName)) + "\"}";
                }
                PropVariantClear(&pv);
                ps->Release();
            }
            if (id) CoTaskMemFree(id);
            d->Release();
        }
        release(col);
    }
    out += "]";
    puts(out.c_str());
    en->Release();
}

static bool ndiAvailable(std::string& path) {
    const wchar_t* vars[] = { L"NDI_RUNTIME_DIR_V6", L"NDI_RUNTIME_DIR_V5", L"NDI_RUNTIME_DIR_V4" };
    for (auto v : vars) {
        wchar_t dir[MAX_PATH];
        if (GetEnvironmentVariableW(v, dir, MAX_PATH)) {
            std::wstring p = std::wstring(dir) + L"\\Processing.NDI.Lib.x64.dll";
            if (GetFileAttributesW(p.c_str()) != INVALID_FILE_ATTRIBUTES) { path = narrow(p.c_str()); return true; }
        }
    }
    return false;
}

// ------------------------------------------------------------------ default device (undocumented IPolicyConfig, Windows 7+)
interface DECLSPEC_UUID("f8679f50-850a-41cf-9c72-430f290290c8") IPolicyConfig : public IUnknown {
public:
    virtual HRESULT STDMETHODCALLTYPE GetMixFormat(PCWSTR, WAVEFORMATEX**) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetDeviceFormat(PCWSTR, INT, WAVEFORMATEX**) = 0;
    virtual HRESULT STDMETHODCALLTYPE ResetDeviceFormat(PCWSTR) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDeviceFormat(PCWSTR, WAVEFORMATEX*, WAVEFORMATEX*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetProcessingPeriod(PCWSTR, INT, PINT64, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetProcessingPeriod(PCWSTR, PINT64) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetShareMode(PCWSTR, void*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetShareMode(PCWSTR, void*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetDefaultEndpoint(PCWSTR, ERole) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetEndpointVisibility(PCWSTR, INT) = 0;
};
class DECLSPEC_UUID("870af99c-171d-4f9e-af0d-e63df40c2bc9") CPolicyConfigClient;

static int setDefaultEndpoint(const std::wstring& id) {
    IPolicyConfig* pc = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(CPolicyConfigClient), nullptr, CLSCTX_ALL, __uuidof(IPolicyConfig), (void**)&pc);
    if (FAILED(hr)) { printf("{\"ok\":false,\"error\":\"policy config unavailable\"}\n"); return 1; }
    for (ERole r : { eConsole, eMultimedia, eCommunications }) hr = FAILED(hr) ? hr : pc->SetDefaultEndpoint(id.c_str(), r);
    pc->Release();
    printf("{\"ok\":%s}\n", SUCCEEDED(hr) ? "true" : "false");
    return SUCCEEDED(hr) ? 0 : 1;
}

// Needs administrator rights (endpoint properties live in HKLM).
static int renameEndpoint(const std::wstring& id, const std::wstring& name) {
    IMMDevice* dev = findEndpoint(eAll, L"id:" + id, nullptr);
    if (!dev) { printf("{\"ok\":false,\"error\":\"device not found\"}\n"); return 1; }
    IPropertyStore* ps = nullptr;
    HRESULT hr = dev->OpenPropertyStore(STGM_READWRITE, &ps);
    if (SUCCEEDED(hr)) {
        PROPVARIANT pv; PropVariantInit(&pv);
        pv.vt = VT_LPWSTR;
        pv.pwszVal = const_cast<LPWSTR>(name.c_str());
        hr = ps->SetValue(PKEY_Device_DeviceDesc, pv);
        if (SUCCEEDED(hr)) hr = ps->Commit();
        ps->Release();
    }
    dev->Release();
    printf("{\"ok\":%s,\"hr\":\"0x%08lx\"}\n", SUCCEEDED(hr) ? "true" : "false", (unsigned long)hr);
    return SUCCEEDED(hr) ? 0 : 1;
}

// ------------------------------------------------------------------ main
static std::atomic<bool> g_quit{ false };
static SOCKET g_socks[2] = { INVALID_SOCKET, INVALID_SOCKET };

// ------------------------------------------------------------------ speaker mode (PC audio -> phone)
// Converts any shared-mode mix format to 48 kHz s16 stereo (linear resampling).
struct ToStereo48 {
    int rate = 48000, channels = 2;
    bool isFloat = true;
    int bits = 32;
    double pos = 0;               // fractional read position for resampling
    float lastL = 0, lastR = 0;   // previous input frame (for interpolation across packets)
    std::vector<int16_t> out;

    void setup(const WAVEFORMATEX* wf) {
        rate = (int)wf->nSamplesPerSec;
        channels = wf->nChannels;
        bits = wf->wBitsPerSample;
        isFloat = wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            auto ext = (const WAVEFORMATEXTENSIBLE*)wf;
            isFloat = ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
        }
    }
    float sample(const BYTE* p, int frame, int ch) const {
        const BYTE* s = p + ((size_t)frame * channels + ch) * (bits / 8);
        if (isFloat) return *(const float*)s;
        if (bits == 16) return *(const int16_t*)s / 32768.0f;
        if (bits == 24) return (int32_t)((uint32_t)s[0] << 8 | (uint32_t)s[1] << 16 | (uint32_t)s[2] << 24) / 2147483648.0f;
        return *(const int32_t*)s / 2147483648.0f;
    }
    static int16_t q(float v) { return (int16_t)std::clamp((int)std::lround(v * 32767.0f), -32768, 32767); }
    // Produces interleaved stereo s16 frames in `out`.
    void convert(const BYTE* data, UINT32 frames, bool silent) {
        out.clear();
        const double step = rate / 48000.0;
        auto frameAt = [&](int i, float& l, float& r) {
            if (i < 0) { l = lastL; r = lastR; return; }
            if (silent) { l = r = 0; return; }
            l = sample(data, i, 0);
            r = channels > 1 ? sample(data, i, 1) : l;
        };
        while (pos < frames) {
            int i0 = (int)std::floor(pos) - 1; // -1 = last frame of the previous packet
            double frac = pos - std::floor(pos);
            float l0, r0, l1, r1;
            frameAt(i0, l0, r0);
            frameAt(i0 + 1, l1, r1);
            out.push_back(q(l0 + (float)frac * (l1 - l0)));
            out.push_back(q(r0 + (float)frac * (r1 - r0)));
            pos += step;
        }
        pos -= frames;
        if (frames) frameAt((int)frames - 1, lastL, lastR);
    }
};

static int runSpeaker(const Options& o) {
    std::string name;
    EDataFlow flow = eRender;
    IMMDevice* dev = findEndpoint(eAll, o.capture.empty() ? L"default" : o.capture, &name, &flow);
    if (!dev) { logmsg("error", "Audio source not found: " + narrow(o.capture.c_str())); return 4; }
    IAudioClient* client = nullptr;
    HRESULT hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
    dev->Release();
    if (FAILED(hr)) { logmsg("error", "Audio source could not be opened"); return 4; }
    WAVEFORMATEX* mix = nullptr;
    client->GetMixFormat(&mix);
    const DWORD flags = flow == eRender ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1000000 /* 100 ms */, 0, mix, nullptr);
    if (FAILED(hr)) { logmsg("error", "Audio source rejected the capture stream"); CoTaskMemFree(mix); release(client); return 4; }
    ToStereo48 conv;
    conv.setup(mix);
    CoTaskMemFree(mix);
    IAudioCaptureClient* cap = nullptr;
    if (FAILED(client->GetService(IID_PPV_ARGS(&cap)))) { release(client); return 4; }

    SOCKET s = connectFirst(o.port, 120);
    if (s == INVALID_SOCKET) { logmsg("error", "Could not connect to the phone speaker"); release(cap); release(client); return 3; }
    g_socks[0] = s;
    emit("{\"event\":\"connected\"}");
    emit("{\"event\":\"sink\",\"sink\":\"speaker\",\"ok\":true,\"name\":\"" + esc(name) + "\",\"loopback\":" + (flow == eRender ? "true" : "false") +
         ",\"rate\":" + std::to_string(conv.rate) + ",\"channels\":" + std::to_string(conv.channels) + "}");
    client->Start();

    LevelMeter meter{ "speaker" };
    uint64_t sent = 0, lastStats = nowMs(), lastSent = 0, lastSound = nowMs();
    bool ok = true;
    while (!g_quit && ok) {
        UINT32 packet = 0;
        if (FAILED(cap->GetNextPacketSize(&packet))) { logmsg("error", "Audio source was removed"); break; }
        if (!packet) Sleep(4);
        while (packet && ok) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD bflags = 0;
            if (FAILED(cap->GetBuffer(&data, &frames, &bflags, nullptr, nullptr))) { ok = false; break; }
            conv.convert(data, frames, (bflags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
            cap->ReleaseBuffer(frames);
            bool quiet = std::all_of(conv.out.begin(), conv.out.end(), [](int16_t v) { return v > -2 && v < 2; });
            if (!quiet) lastSound = nowMs();
            // After 1.5 s of digital silence stop sending: the phone then idles its audio output.
            if (!conv.out.empty() && (!quiet || nowMs() - lastSound < 1500)) {
                meter.feed(conv.out.data(), conv.out.size());
                const char* p = (const char*)conv.out.data();
                int len = (int)(conv.out.size() * 2);
                while (len > 0) {
                    int r = send(s, p, len, 0);
                    if (r <= 0) { ok = false; break; }
                    p += r; len -= r;
                }
                sent += conv.out.size() / 2;
            }
            if (FAILED(cap->GetNextPacketSize(&packet))) { ok = false; break; }
        }
        if (nowMs() - lastStats >= 1000) {
            emit("{\"event\":\"stats\",\"speaker\":true,\"playing\":" + std::string(sent != lastSent ? "true" : "false") + ",\"frames\":" + std::to_string(sent) + "}");
            lastSent = sent;
            lastStats = nowMs();
        }
    }
    client->Stop();
    emit("{\"event\":\"ended\"}");
    closesocket(s);
    release(cap);
    release(client);
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    Options o;
    bool doList = false, doCheck = false;
    for (int i = 1; i < argc; i++) {
        std::wstring a = argv[i];
        auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
        if (a == L"--port") o.port = _wtoi(next().c_str());
        else if (a == L"--width") o.width = _wtoi(next().c_str());
        else if (a == L"--height") o.height = _wtoi(next().c_str());
        else if (a == L"--fps") o.fps = std::max(1, _wtoi(next().c_str()));
        else if (a == L"--no-audio") o.audio = false;
        else if (a == L"--no-video") o.video = false;
        else if (a == L"--speaker") o.speaker = true;
        else if (a == L"--capture") o.capture = next();
        else if (a == L"--set-default") { std::wstring id = next(); CoInitializeEx(nullptr, COINIT_MULTITHREADED); return setDefaultEndpoint(id); }
        else if (a == L"--rename") { std::wstring id = next(); std::wstring nm = next(); CoInitializeEx(nullptr, COINIT_MULTITHREADED); return renameEndpoint(id, nm); }
        else if (a == L"--cover") o.cover = true;
        else if (a == L"--mirror") o.mirror = true;
        else if (a == L"--softcam") o.softcamDll = next();
        else if (a == L"--ndi") o.ndiName = narrow(next().c_str());
        else if (a == L"--audio-device") o.audioDevice = next();
        else if (a == L"--list-audio") doList = true;
        else if (a == L"--check") doCheck = true;
    }

    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (doList) { listAudio(); return 0; }
    if (doCheck) {
        std::string p;
        bool ndi = ndiAvailable(p);
        printf("{\"ndi\":%s,\"ndiPath\":\"%s\"}\n", ndi ? "true" : "false", esc(p).c_str());
        return 0;
    }
    if (!o.port) { logmsg("error", "missing --port"); return 2; }

    MFStartup(MF_VERSION, MFSTARTUP_LITE);
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);

    // Parent closes stdin (or sends "quit") to stop us.
    std::thread([] {
        char line[256];
        while (fgets(line, sizeof(line), stdin)) {
            if (strncmp(line, "quit", 4) == 0) break;
        }
        g_quit = true;
        // Unblock the socket readers.
        for (SOCKET s : g_socks) if (s != INVALID_SOCKET) shutdown(s, SD_BOTH);
    }).detach();

    if (o.speaker) {
        int rc = runSpeaker(o);
        WSACleanup();
        return rc;
    }

    SoftcamSink cam;
    NdiSink ndi;
    WasapiSink spk;
    if (!o.softcamDll.empty() && cam.open(o.softcamDll, o.width, o.height, o.fps)) emit("{\"event\":\"sink\",\"sink\":\"camera\",\"ok\":true}");
    if (!o.ndiName.empty() && ndi.open(o.ndiName, o.fps)) emit("{\"event\":\"sink\",\"sink\":\"ndi\",\"ok\":true,\"name\":\"" + esc(o.ndiName) + "\"}");

    SOCKET vs = INVALID_SOCKET, as = INVALID_SOCKET;
    if (o.video) {
        vs = connectFirst(o.port, 120);
        if (vs == INVALID_SOCKET) { logmsg("error", "Could not connect to the device stream"); return 3; }
        if (o.audio) {
            as = connectPort(o.port);
            if (as == INVALID_SOCKET) logmsg("warn", "Audio socket failed");
        }
    } else {
        as = connectFirst(o.port, 120); // audio only: the audio socket is the first one
        if (as == INVALID_SOCKET) { logmsg("error", "Could not connect to the device audio"); return 3; }
    }
    g_socks[0] = vs;
    g_socks[1] = as;
    emit("{\"event\":\"connected\"}");

    std::atomic<uint64_t> frames{ 0 }, audioChunks{ 0 };
    std::atomic<int> curW{ 0 }, curH{ 0 };

    // ---- audio thread
    std::thread audioThread;
    if (as != INVALID_SOCKET) {
        audioThread = std::thread([&] {
            CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            uint8_t hdr[12];
            if (!recvAll(as, hdr, 4)) return;
            uint32_t codec = be32(hdr);
            if (codec == 0 || codec == 1) {
                logmsg("warn", codec == 0 ? "Device audio disabled (microphone unavailable)" : "Device audio error");
                return;
            }
            if (!o.audioDevice.empty() && spk.open(o.audioDevice))
                emit("{\"event\":\"sink\",\"sink\":\"audio\",\"ok\":true,\"name\":\"" + esc(spk.name) + "\"}");
            std::vector<uint8_t> pkt;
            LevelMeter meter{ "mic" };
            while (!g_quit) {
                if (!recvAll(as, hdr, 12)) break;
                uint32_t size = be32(hdr + 8);
                if (size > (8u << 20)) break;
                pkt.resize(size);
                if (!recvAll(as, pkt.data(), size)) break;
                if (be64(hdr) & (1ull << 62)) continue; // config packet
                const int16_t* pcm = (const int16_t*)pkt.data();
                UINT32 n = size / 4;
                spk.write(pcm, n);
                ndi.audio(pcm, (int)n);
                meter.feed(pcm, (size_t)n * 2);
                audioChunks++;
            }
            spk.close();
            CoUninitialize();
        });
    }

    // ---- stats thread
    std::thread([&] {
        uint64_t last = 0;
        while (!g_quit) {
            Sleep(1000);
            uint64_t f = frames.load();
            emit("{\"event\":\"stats\",\"fps\":" + std::to_string(f - last) + ",\"width\":" + std::to_string(curW.load()) +
                 ",\"height\":" + std::to_string(curH.load()) + ",\"camera\":" + (cam.active() ? "true" : "false") +
                 ",\"cameraInUse\":" + (cam.isConnected() ? "true" : "false") + ",\"ndi\":" + (ndi.active() ? "true" : "false") +
                 ",\"ndiClients\":" + std::to_string(ndi.clients()) + ",\"audio\":" + (audioChunks.load() ? "true" : "false") +
                 ",\"audioOut\":\"" + esc(spk.name) + "\"}");
            last = f;
        }
    }).detach();

    // ---- video loop (main thread)
    if (!o.video) {
        if (audioThread.joinable()) audioThread.join();
        g_quit = true;
        emit("{\"event\":\"ended\"}");
        closesocket(as);
        ndi.close();
        fflush(stdout);
        ExitProcess(0); // the detached stats thread still references locals
    }

    Decoder dec;
    std::vector<uint8_t> config, pkt, joined;
    uint8_t hdr[12];
    bool ok = recvAll(vs, hdr, 4);
    uint32_t vcodec = ok ? be32(hdr) : 0;
    if (!ok || vcodec == 0 || vcodec == 1) { logmsg("error", "Device video stream unavailable"); g_quit = true; }
    bool decReady = false;
    while (!g_quit) {
        if (!recvAll(vs, hdr, 12)) break;
        uint64_t pf = be64(hdr);
        if (pf & (1ull << 63)) {
            int w = (int)be32(hdr + 4), h = (int)be32(hdr + 8);
            decReady = dec.init(w, h);
            curW = w; curH = h;
            emit("{\"event\":\"video\",\"width\":" + std::to_string(w) + ",\"height\":" + std::to_string(h) + "}");
            continue;
        }
        uint32_t size = be32(hdr + 8);
        if (size > (64u << 20)) break;
        pkt.resize(size);
        if (!recvAll(vs, pkt.data(), size)) break;
        if (pf & (1ull << 62)) { config = pkt; continue; }
        if (!decReady) continue;
        const uint8_t* data = pkt.data();
        size_t len = pkt.size();
        if (!config.empty()) {
            joined.assign(config.begin(), config.end());
            joined.insert(joined.end(), pkt.begin(), pkt.end());
            data = joined.data();
            len = joined.size();
            config.clear();
        }
        int64_t pts = (int64_t)(pf & ((1ull << 61) - 1));
        dec.decode(data, len, pts, [&](const Nv12Frame& f) {
            bool bt709 = f.height >= 720;
            cam.video(f, o.cover, o.mirror, bt709);
            ndi.video(f, o.mirror);
            frames++;
        });
    }

    g_quit = true;
    emit("{\"event\":\"ended\"}");
    closesocket(vs);
    if (as != INVALID_SOCKET) closesocket(as);
    if (audioThread.joinable()) audioThread.join();
    cam.close();
    ndi.close();
    MFShutdown();
    WSACleanup();
    return 0;
}
