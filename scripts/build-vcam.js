// Builds the Windows virtual webcam:
//   resources/vcam/scrcpy-studio-camera-x64.dll  (DirectShow camera, 64-bit apps)
//   resources/vcam/scrcpy-studio-camera-x86.dll  (DirectShow camera, 32-bit apps)
//   resources/vcam/studio-vcam.exe               (stream bridge: decoder -> camera / NDI / audio)
//
// The camera is softcam (MIT, https://github.com/tshino/softcam) with a few patches:
// our own name/CLSID/shared memory, an always-available "camera offline"
// placeholder, and no sender-side frame pacing (the phone stream is live).
//
// Requirements: Visual Studio 2022 with "Desktop development with C++" and git.
// `node scripts/build-vcam.js --bridge` rebuilds only studio-vcam.exe.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const SRC = path.join(NATIVE, 'softcam-src');
const WORK = path.join(NATIVE, 'build-vcam');
const OUT = path.join(ROOT, 'resources', 'vcam');
const CLSID = '3e0c523e-86ea-4ffb-9a9e-c031dee12c8f';
const NAME = 'Scrcpy Studio Camera';

function sh(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' ').slice(0, 160));
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function patch(file, from, to) {
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (!s.includes(from)) throw new Error(`Patch anchor not found in ${path.basename(file)}:\n${from.slice(0, 200)}`);
  fs.writeFileSync(file, s.replace(from, to));
}

function vs() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const out = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).toString().trim();
  if (!out) throw new Error('Visual Studio with C++ tools not found');
  return {
    msbuild: path.join(out, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'),
    vcvars: path.join(out, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'),
  };
}

const BRIDGE_ONLY = process.argv.includes('--bridge');

// ------------------------------------------------------------------ source
if (!BRIDGE_ONLY) {
if (!fs.existsSync(SRC)) sh('git', ['clone', '--depth', '1', 'https://github.com/tshino/softcam.git', SRC]);
fs.rmSync(WORK, { recursive: true, force: true });
fs.cpSync(SRC, WORK, { recursive: true, filter: (p) => !p.includes(`${path.sep}.git`) });

const g = CLSID.replace(/-/g, '');
const guidMacro = `0x${g.slice(0, 8)}, 0x${g.slice(8, 12)}, 0x${g.slice(12, 16)}, ${g.slice(16).match(/../g).map(b => '0x' + b).join(', ')}`;

// ------------------------------------------------------------------ patches
const dll = path.join(WORK, 'src', 'softcam', 'softcam.cpp');
patch(dll, 'DEFINE_GUID(CLSID_DShowSoftcam,\n0xaef3b972, 0x5fa5, 0x4647, 0x95, 0x71, 0x35, 0x8e, 0xb4, 0x72, 0xbc, 0x9e);',
  `DEFINE_GUID(CLSID_DShowSoftcam,\n${guidMacro});`);
patch(dll, 'const wchar_t FILTER_NAME[] = L"DirectShow Softcam";', `const wchar_t FILTER_NAME[] = L"${NAME}";`);

const fb = path.join(WORK, 'src', 'softcamcore', 'FrameBuffer.cpp');
patch(fb, 'const char NamedMutexName[] = "DirectShow Softcam/NamedMutex";', 'const char NamedMutexName[] = "ScrcpyStudio VirtualCamera/NamedMutex";');
patch(fb, 'const char SharedMemoryName[] = "DirectShow Softcam/SharedMemory";', 'const char SharedMemoryName[] = "ScrcpyStudio VirtualCamera/SharedMemory";');

// The phone stream is live: deliver frames immediately instead of pacing them.
patch(path.join(WORK, 'src', 'softcamcore', 'SenderAPI.cpp'), '        if (0.0f < framerate)\n        {\n            if (0 == frame_counter)',
  '        if (false && 0.0f < framerate)\n        {\n            if (0 == frame_counter)');

const ds = path.join(WORK, 'src', 'softcamcore', 'DShowSoftcam.cpp');
// Idle size/rate come from the app (HKCU) so the camera can always be opened.
patch(ds, 'Softcam::Softcam(LPUNKNOWN lpunk, const GUID& clsid, HRESULT *phr) :',
`static DWORD studioSetting(const wchar_t* name, DWORD def)
{
    DWORD v = 0, size = sizeof(v);
    if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\\\ScrcpyStudio\\\\VirtualCamera", name, RRF_RT_REG_DWORD, nullptr, &v, &size) == ERROR_SUCCESS && v > 0)
        return v;
    return def;
}

// "Camera offline" card shown while the phone is not streaming (bottom-up BGR24 DIB).
static void studioPlaceholder(uint8_t* dib, int w, int h)
{
    BITMAPINFO bmi = {};
    bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = h;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 24;
    bmi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HDC dc = CreateCompatibleDC(nullptr);
    HBITMAP bmp = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!dc || !bmp || !bits) { if (bmp) DeleteObject(bmp); if (dc) DeleteDC(dc); return; }
    HGDIOBJ old = SelectObject(dc, bmp);
    const int stride = (w * 3 + 3) & ~3;
    for (int y = 0; y < h; y++)
    {
        uint8_t* row = (uint8_t*)bits + (size_t)stride * y;
        const float t = (float)y / (float)h;             // 0 = bottom
        for (int x = 0; x < w; x++)
        {
            const float dx = (float)x / w - 0.5f, dy = t - 0.55f;
            const float glow = (std::max)(0.0f, 1.0f - (dx * dx + dy * dy) * 3.2f);
            row[x * 3 + 0] = (uint8_t)(16 + 60 * glow);  // B
            row[x * 3 + 1] = (uint8_t)(10 + 22 * glow);  // G
            row[x * 3 + 2] = (uint8_t)(14 + 46 * glow);  // R
        }
    }
    SetBkMode(dc, TRANSPARENT);
    HFONT fontBig = CreateFontW(-(h / 12), 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    HFONT fontSmall = CreateFontW(-(h / 32), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    RECT r1 = { 0, h / 2 - h / 9, w, h / 2 + h / 40 };
    RECT r2 = { 0, h / 2 + h / 30, w, h / 2 + h / 8 };
    SelectObject(dc, fontBig);
    SetTextColor(dc, RGB(240, 240, 250));
    DrawTextW(dc, L"Scrcpy Studio", -1, &r1, DT_CENTER | DT_SINGLELINE | DT_BOTTOM);
    SelectObject(dc, fontSmall);
    SetTextColor(dc, RGB(170, 170, 195));
    DrawTextW(dc, L"Camera offline \\x2014 start the webcam in Scrcpy Studio", -1, &r2, DT_CENTER | DT_SINGLELINE | DT_TOP);
    GdiFlush();
    std::memcpy(dib, bits, (size_t)stride * h);
    SelectObject(dc, old);
    DeleteObject(fontBig);
    DeleteObject(fontSmall);
    DeleteObject(bmp);
    DeleteDC(dc);
}

Softcam::Softcam(LPUNKNOWN lpunk, const GUID& clsid, HRESULT *phr) :`);
patch(ds, `    m_valid(m_frame_buffer ? true : false),
    m_width(m_frame_buffer.width()),
    m_height(m_frame_buffer.height()),
    m_framerate(m_frame_buffer.framerate())`,
`    m_valid(true),
    m_width(m_frame_buffer ? m_frame_buffer.width() : (int)(studioSetting(L"Width", 1920) & ~3u)),
    m_height(m_frame_buffer ? m_frame_buffer.height() : (int)(studioSetting(L"Height", 1080) & ~3u)),
    m_framerate(m_frame_buffer ? m_frame_buffer.framerate() : (float)studioSetting(L"Fps", 30))`);
patch(ds, `    m_width(pParent->width()),
    m_height(pParent->height())
{
}`,
`    m_width(pParent->width()),
    m_height(pParent->height())
{
    m_screenshot.reset(new uint8_t[calcDIBSize(m_width, m_height)]);
    studioPlaceholder(m_screenshot.get(), m_width, m_height);
}`);
patch(ds, `                // Save the last image for a placeholder.
                const std::size_t size = calcDIBSize(m_width, m_height);
                if (!m_screenshot)
                {
                    m_screenshot.reset(new uint8_t[size]);
                }
                {
                    // Darken the image to indicate that the source is inactive.
                    for (std::size_t i = 0; i < size; i++)
                    {
                        pData[i] /= 4;
                    }
                }
                std::memcpy(m_screenshot.get(), pData, size);`,
`                // Show the "camera offline" card again.
                const std::size_t size = calcDIBSize(m_width, m_height);
                std::memcpy(pData, m_screenshot.get(), size);`);

}

// ------------------------------------------------------------------ build
const { msbuild, vcvars } = vs();
fs.mkdirSync(OUT, { recursive: true });
if (!BRIDGE_ONLY) {
const proj = path.join(WORK, 'src', 'softcam', 'softcam.vcxproj');
fs.mkdirSync(OUT, { recursive: true });
for (const [platform, suffix] of [['x64', 'x64'], ['Win32', 'x86']]) {
  sh(msbuild, [proj, '/m', '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:PostBuildEventUseInBuild=false', `/p:Platform=${platform}`, `/p:SolutionDir=${WORK}${path.sep}`]);
  const built = path.join(WORK, platform, 'Release', 'softcam.dll');
  fs.copyFileSync(built, path.join(OUT, `scrcpy-studio-camera-${suffix}.dll`));
}
}

// Bridge executable
const obj = path.join(WORK, 'bridge');
fs.mkdirSync(obj, { recursive: true });
const src = path.join(NATIVE, 'vcam', 'studio-vcam.cpp');
const exe = path.join(OUT, 'studio-vcam.exe');
const cmd = `"${vcvars}" >nul && cl /nologo /O2 /EHsc /std:c++17 /MT /DUNICODE /D_UNICODE /Fo"${obj}\\\\" "${src}" /Fe"${exe}" /link /SUBSYSTEM:CONSOLE`;
sh('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { windowsVerbatimArguments: true });

fs.writeFileSync(path.join(OUT, 'vcam.json'), JSON.stringify({ clsid: `{${CLSID.toUpperCase()}}`, name: NAME }, null, 2));
console.log('\nVirtual camera built in', OUT);
for (const f of fs.readdirSync(OUT)) console.log(' ', f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0), 'KB');
