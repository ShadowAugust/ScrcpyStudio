// Dev test: loads the virtual camera filter straight from its DLL (no
// registration needed), runs it in a DirectShow graph through Windows' Sample
// Grabber and saves the last frame as a BMP.
// Usage: vcam-test.exe <dll> <clsid> <out.bmp> [seconds]
#include <windows.h>
#include <dshow.h>
#include <cstdio>
#include <vector>

#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

// qedit.h is no longer in the SDK; declare the Sample Grabber interface ourselves.
MIDL_INTERFACE("0579154A-2B53-4994-B0D0-E773148EFF85") ISampleGrabberCB : public IUnknown {
    virtual HRESULT STDMETHODCALLTYPE SampleCB(double, IMediaSample*) = 0;
    virtual HRESULT STDMETHODCALLTYPE BufferCB(double, BYTE*, long) = 0;
};
MIDL_INTERFACE("6B652FFF-11FE-4fce-92AD-0266B5D7C78F") ISampleGrabber : public IUnknown {
    virtual HRESULT STDMETHODCALLTYPE SetOneShot(BOOL) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetMediaType(const AM_MEDIA_TYPE*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetConnectedMediaType(AM_MEDIA_TYPE*) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetBufferSamples(BOOL) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentBuffer(long*, long*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetCurrentSample(IMediaSample**) = 0;
    virtual HRESULT STDMETHODCALLTYPE SetCallback(ISampleGrabberCB*, long) = 0;
};
static const CLSID CLSID_SampleGrabber_ = { 0xC1F400A0, 0x3F08, 0x11d3, { 0x9F, 0x0B, 0x00, 0x60, 0x08, 0x03, 0x9E, 0x37 } };
static const CLSID CLSID_NullRenderer_ = { 0xC1F400A4, 0x3F08, 0x11d3, { 0x9F, 0x0B, 0x00, 0x60, 0x08, 0x03, 0x9E, 0x37 } };

struct Counter : ISampleGrabberCB {
    LONG frames = 0;
    ULONG STDMETHODCALLTYPE AddRef() override { return 2; }
    ULONG STDMETHODCALLTYPE Release() override { return 1; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** p) override {
        if (riid == IID_IUnknown || riid == __uuidof(ISampleGrabberCB)) { *p = this; return S_OK; }
        return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE SampleCB(double, IMediaSample*) override { InterlockedIncrement(&frames); return S_OK; }
    HRESULT STDMETHODCALLTYPE BufferCB(double, BYTE*, long) override { return S_OK; }
};

typedef HRESULT(STDAPICALLTYPE* GetClassObjectFn)(REFCLSID, REFIID, LPVOID*);

static IPin* firstPin(IBaseFilter* f, PIN_DIRECTION dir) {
    IEnumPins* en = nullptr;
    IPin* p = nullptr;
    f->EnumPins(&en);
    while (en->Next(1, &p, nullptr) == S_OK) {
        PIN_DIRECTION d;
        p->QueryDirection(&d);
        if (d == dir) { en->Release(); return p; }
        p->Release();
    }
    en->Release();
    return nullptr;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 4) { printf("usage: vcam-test <dll> <clsid> <out.bmp> [seconds]\n"); return 2; }
    int seconds = argc > 4 ? _wtoi(argv[4]) : 3;
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    CLSID clsid;
    CLSIDFromString(argv[2], &clsid);
    HMODULE lib = LoadLibraryW(argv[1]);
    if (!lib) { printf("load failed\n"); return 3; }
    auto get = (GetClassObjectFn)GetProcAddress(lib, "DllGetClassObject");
    IClassFactory* cf = nullptr;
    if (FAILED(get(clsid, IID_IClassFactory, (void**)&cf))) { printf("no class factory\n"); return 4; }
    IBaseFilter* src = nullptr;
    if (FAILED(cf->CreateInstance(nullptr, IID_IBaseFilter, (void**)&src))) { printf("create failed\n"); return 5; }

    IGraphBuilder* graph = nullptr;
    IBaseFilter *grabF = nullptr, *nullF = nullptr;
    ISampleGrabber* grab = nullptr;
    CoCreateInstance(CLSID_FilterGraph, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&graph));
    CoCreateInstance(CLSID_SampleGrabber_, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&grabF));
    CoCreateInstance(CLSID_NullRenderer_, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&nullF));
    if (!graph || !grabF || !nullF) { printf("dshow components missing\n"); return 6; }
    grabF->QueryInterface(__uuidof(ISampleGrabber), (void**)&grab);
    AM_MEDIA_TYPE mt{};
    mt.majortype = MEDIATYPE_Video;
    mt.subtype = MEDIASUBTYPE_RGB24;
    grab->SetMediaType(&mt);
    grab->SetBufferSamples(TRUE);
    Counter counter;
    grab->SetCallback(&counter, 0);
    graph->AddFilter(src, L"camera");
    graph->AddFilter(grabF, L"grab");
    graph->AddFilter(nullF, L"null");
    HRESULT hr = graph->Connect(firstPin(src, PINDIR_OUTPUT), firstPin(grabF, PINDIR_INPUT));
    if (FAILED(hr)) { printf("connect failed 0x%08lx\n", hr); return 7; }
    graph->Connect(firstPin(grabF, PINDIR_OUTPUT), firstPin(nullF, PINDIR_INPUT));
    IMediaFilter* mf = nullptr;
    graph->QueryInterface(IID_PPV_ARGS(&mf));
    mf->SetSyncSource(nullptr);
    IMediaControl* mc = nullptr;
    graph->QueryInterface(IID_PPV_ARGS(&mc));
    mc->Run();
    Sleep(seconds * 1000);
    AM_MEDIA_TYPE cmt{};
    grab->GetConnectedMediaType(&cmt);
    VIDEOINFOHEADER vih = *(VIDEOINFOHEADER*)cmt.pbFormat;
    long size = 0;
    grab->GetCurrentBuffer(&size, nullptr);
    std::vector<BYTE> buf(size > 0 ? size : 0);
    if (size > 0) grab->GetCurrentBuffer(&size, (long*)buf.data());
    mc->Stop();
    printf("{\"width\":%ld,\"height\":%ld,\"frames\":%ld,\"fpsDeclared\":%.2f}\n", vih.bmiHeader.biWidth, vih.bmiHeader.biHeight,
           counter.frames, vih.AvgTimePerFrame ? 1e7 / vih.AvgTimePerFrame : 0.0);
    if (!buf.empty()) {
        BITMAPFILEHEADER fh{};
        fh.bfType = 0x4d42;
        fh.bfOffBits = sizeof(fh) + sizeof(BITMAPINFOHEADER);
        fh.bfSize = fh.bfOffBits + (DWORD)buf.size();
        FILE* f = _wfopen(argv[3], L"wb");
        fwrite(&fh, sizeof(fh), 1, f);
        fwrite(&vih.bmiHeader, sizeof(BITMAPINFOHEADER), 1, f);
        fwrite(buf.data(), 1, buf.size(), f);
        fclose(f);
    }
    return counter.frames > 0 ? 0 : 8;
}
