const express = require('express');
const pool = require('../../database');
const requireRole = require('../middleware/requireRole');
const vpnConfig = require('../vpn_config');
const vpn = require('../vpn');

const router = express.Router();

// Seluruh menu Koneksi VPN hanya untuk Administrator.
router.use(requireRole('admin'));
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const LABELS = vpn.LABELS;

function protocolOf(value) {
  const protocol = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return vpnConfig.PROTOCOLS.includes(protocol) ? protocol : '';
}

function sendError(res, error, fallback) {
  const status = Number(error.status) || 500;
  return res.status(status).json({
    success: false,
    message: status === 500 ? `${fallback} ${String(error.message || '').slice(0, 240)}`.trim() : error.message,
    field: error.field || undefined,
  });
}

const EMPTY_PROFILES = {
  wireguard: null, openvpn: null, sstp: null, l2tp: null,
};

// GET /api/sistem/vpn/status
// Selalu 200. Paket belum terpasang atau interface belum ada bukan error halaman.
router.get('/status', async (req, res) => {
  try {
    const status = await vpn.service.getStatus();
    try {
      const { profiles } = await vpn.loadProfiles(pool);
      status.ping = await vpn.service.measurePing(
        status.protocol,
        status.protocol ? profiles[status.protocol] || null : null,
        status.ip,
      );
    } catch (error) {
      console.error('[vpn] ping:', error.message);
      status.ping = vpn.emptyPing();
    }
    res.json(status);
  } catch (error) {
    console.error('[vpn] status:', error);
    res.json({
      success: true,
      state: 'disconnected',
      connected: false,
      protocol: null,
      interface: null,
      ip: null,
      prefix: null,
      uptime_seconds: null,
      traffic: null,
      wireguard: null,
      ping: vpn.emptyPing(),
    });
  }
});

// GET /api/sistem/vpn/config — isi form (rahasia tidak ikut, hanya penanda *_set).
// Tabel dibuat bila belum ada. Belum pernah disimpan = 200 dengan nilai kosong, bukan 404/500.
router.get('/config', async (req, res) => {
  try {
    await vpn.ensureTable(pool);
    const { profiles, selected } = await vpn.loadProfiles(pool);
    res.json({
      success: true,
      selected: selected || null,
      profiles: { ...EMPTY_PROFILES, ...vpn.publicProfiles(profiles) },
    });
  } catch (error) {
    console.error('[vpn] config:', error);
    res.json({ success: true, selected: null, profiles: { ...EMPTY_PROFILES } });
  }
});

// POST /api/sistem/vpn/wg/keygen
router.post('/wg/keygen', (req, res) => {
  try {
    const { private_key: privateKey, public_key: publicKey } = vpnConfig.generateKeypair();
    res.json({
      success: true, private_key: privateKey, public_key: publicKey, message: 'Keypair WireGuard dibuat.',
    });
  } catch (error) {
    sendError(res, error, 'Gagal membuat keypair WireGuard.');
  }
});

// POST /api/sistem/vpn/save  { protocol, config: {...} }
router.post('/save', async (req, res) => {
  const protocol = protocolOf(req.body?.protocol);
  if (!protocol) {
    return res.status(400).json({ success: false, message: 'Protokol tidak dikenal. Pilih wireguard, openvpn, sstp, atau l2tp.' });
  }
  try {
    const { profiles } = await vpn.loadProfiles(pool);
    const cfg = vpnConfig.validateProfile(protocol, req.body?.config, profiles[protocol] || null);
    // Berkas OS ditulis dulu; bila gagal, database tidak berubah.
    await vpn.service.applyConfig(protocol, cfg);
    await vpn.saveProfile(pool, protocol, cfg, req.user?.username);

    const status = await vpn.service.getStatus();
    const running = status.protocol === protocol;
    const reloaded = await vpn.loadProfiles(pool);
    return res.json({
      success: true,
      protocol,
      message: `Konfigurasi ${LABELS[protocol]} disimpan.${running ? ' Tekan Hubungkan untuk menerapkan ulang ke koneksi yang sedang berjalan.' : ''}`,
      needs_reconnect: running,
      profiles: vpn.publicProfiles(reloaded.profiles),
    });
  } catch (error) {
    return sendError(res, error, 'Gagal menyimpan konfigurasi VPN.');
  }
});

// POST /api/sistem/vpn/action  { protocol, action: 'connect' | 'disconnect' }
router.post('/action', async (req, res) => {
  const protocol = protocolOf(req.body?.protocol);
  const action = typeof req.body?.action === 'string' ? req.body.action.trim().toLowerCase() : '';
  if (!protocol) {
    return res.status(400).json({ success: false, message: 'Protokol tidak dikenal. Pilih wireguard, openvpn, sstp, atau l2tp.' });
  }
  if (action !== 'connect' && action !== 'disconnect') {
    return res.status(400).json({ success: false, message: 'Aksi harus connect atau disconnect.' });
  }
  const label = LABELS[protocol];
  try {
    if (action === 'disconnect') {
      const { status } = await vpn.service.disconnect(protocol);
      return res.json({
        success: true, protocol, action, state: status.state, status, message: `VPN ${label} diputuskan.`,
      });
    }

    const { profiles } = await vpn.loadProfiles(pool);
    const { status, log } = await vpn.service.connect(protocol, profiles[protocol] || null);
    await vpn.markSelected(pool, protocol);
    const connected = Boolean(status?.connected && status.protocol === protocol);
    const diagnosis = connected ? null : vpn.diagnoseLog(log, protocol);
    let message;
    if (connected) {
      message = `VPN ${label} terhubung${status.ip ? ` (IP ${status.ip})` : ''}.`;
    } else if (diagnosis) {
      message = `VPN ${label} belum tersambung. Dugaan penyebab: ${diagnosis.text}`;
    } else if (status?.units?.[protocol] === 'failed') {
      message = `Layanan VPN ${label} gagal berjalan. Periksa konfigurasi dan log: journalctl -u ${vpnConfig.UNITS[protocol]}${protocol === 'l2tp' ? ' -u xl2tpd' : ''} -n 30.`;
    } else {
      message = protocol === 'wireguard'
        ? 'WireGuard dijalankan, tetapi belum ada handshake dari CHR. Periksa endpoint, public key (kedua sisi), allowed address di peer CHR, dan firewall UDP.'
        : `VPN ${label} dijalankan, tetapi belum mendapat IP dari CHR. Periksa kredensial, port, dan firewall.`;
    }
    return res.json({
      success: true,
      protocol,
      action,
      connected,
      state: status?.state || 'disconnected',
      status,
      message,
      diagnosis: diagnosis ? diagnosis.code : null,
      // Baris terakhir journal unit (SSTP/L2TP: 20); kosong bila sudah tersambung.
      log: connected ? [] : (Array.isArray(log) ? log : []),
    });
  } catch (error) {
    return sendError(res, error, `Gagal ${action === 'connect' ? 'menghubungkan' : 'memutuskan'} VPN.`);
  }
});

module.exports = router;
