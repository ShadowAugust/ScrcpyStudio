// Android 11+ QR-code wireless pairing: we advertise credentials in a QR code,
// the phone scans it and publishes an mDNS pairing service we then pair with.
const crypto = require('crypto');
const QRCode = require('qrcode');

class QrPairing {
  constructor(adb, emit) {
    this.adb = adb;
    this.emit = emit;
    this.active = null;
  }

  async start() {
    this.cancel();
    const name = `studio-${crypto.randomBytes(3).toString('hex')}`;
    const password = crypto.randomInt(100000, 999999).toString() + crypto.randomBytes(2).toString('hex');
    const text = `WIFI:T:ADB;S:${name};P:${password};;`;
    const qr = await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#0b0b12', light: '#ffffff' } });
    const session = { name, password, startedAt: Date.now(), timer: null, paired: false, stopped: false };
    this.active = session;
    const mdns = await this.adb.exec(['mdns', 'check'], { timeout: 8000 });
    const mdnsOk = mdns.ok && !/unavailable|error/i.test(mdns.stdout + mdns.stderr);
    this.poll(session);
    return { ok: true, qr, name, mdnsOk, mdnsMessage: (mdns.stdout + mdns.stderr).trim() };
  }

  poll(session) {
    const step = async () => {
      if (session.stopped || this.active !== session) return;
      if (Date.now() - session.startedAt > 3 * 60 * 1000) {
        this.emit({ state: 'timeout', message: 'Pairing timed out. Generate a new code and try again.' });
        this.cancel();
        return;
      }
      const { services } = await this.adb.mdnsServices();
      if (!session.paired) {
        const svc = services.find(s => s.pairing && s.name === session.name);
        if (svc) {
          this.emit({ state: 'pairing', message: `Found device at ${svc.address}, pairing…` });
          const r = await this.adb.pair(svc.address, session.password);
          if (!r.ok) {
            this.emit({ state: 'error', message: r.message || 'Pairing failed' });
            this.cancel();
            return;
          }
          session.paired = true;
          session.host = svc.address.split(':')[0];
          session.pairedAt = Date.now();
          this.emit({ state: 'paired', message: 'Paired! Connecting…' });
        }
      } else {
        const conn = services.find(s => !s.pairing && s.address.startsWith(session.host + ':'));
        if (conn) {
          const r = await this.adb.connect(conn.address);
          this.emit({ state: r.ok ? 'connected' : 'paired', message: r.ok ? `Connected to ${conn.address}` : r.message, address: conn.address });
          if (r.ok) { this.cancel(); return; }
        } else if (Date.now() - session.pairedAt > 20000) {
          this.emit({ state: 'connected', message: 'Paired. If the device does not appear, connect using its IP and port shown under Wireless debugging.' });
          this.cancel();
          return;
        }
      }
      session.timer = setTimeout(step, 1500);
    };
    session.timer = setTimeout(step, 1500);
  }

  cancel() {
    if (this.active) {
      this.active.stopped = true;
      clearTimeout(this.active.timer);
      this.active = null;
    }
  }
}

module.exports = { QrPairing };
