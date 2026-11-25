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

// POST /api/sistem/vpn/restart  { protocol? } — bila protocol kosong, pakai protokol yang sedang aktif.
router.post('/restart', async (req, res) => {
  const rawProtocol = req.body?.protocol;
  const protocolGiven = rawProtocol !== undefined && rawProtocol !== null && String(rawProtocol).trim() !== '';
  let protocol = protocolOf(rawProtocol);
  try {
    if (protocolGiven && !protocol) {
      return res.status(400).json({ success: false, message: 'Protokol tidak dikenal.' });
    }
    const { profiles, selected } = await vpn.loadProfiles(pool);
    const current = await vpn.service.getStatus();
    if (!protocol) {
      protocol = current.protocol || selected || '';
    }
    if (!protocol) {
      return res.status(400).json({ success: false, message: 'Tidak ada protokol VPN aktif untuk di-restart.' });
    }
    const unitLife = current.units?.[protocol];
    const mayRestart = protocol === current.protocol
      || (protocol === selected && ['active', 'activating', 'reloading', 'failed'].includes(unitLife));
    if (!mayRestart) {
      return res.status(400).json({
        success: false,
        message: `${LABELS[protocol]} tidak sedang aktif${current.protocol ? ` (${LABELS[current.protocol]} sedang berjalan)` : ''}.`,
      });
    }
    const { status, log, connected } = await vpn.service.restart(protocol, profiles[protocol] || null, { selectedProtocol: selected });
    const diagnosis = connected ? null : vpn.diagnoseLog(log, protocol);
    let message;
    if (connected) {
      message = `VPN ${LABELS[protocol]} di-restart${status.ip ? ` (IP ${status.ip})` : ''}.`;
    } else if (diagnosis) {
      message = `Restart ${LABELS[protocol]} selesai, tetapi belum tersambung. Dugaan penyebab: ${diagnosis.text}`;
    } else if (status?.units?.[protocol] === 'failed') {
      message = `Layanan ${LABELS[protocol]} gagal setelah restart. Periksa log unit.`;
    } else {
      message = `Restart ${LABELS[protocol]} dijalankan, tetapi belum mendapat IP dari CHR.`;
    }
    return res.json({
      success: true,
      protocol,
      connected,
      state: status?.state || 'disconnected',
      status,
      message,
      diagnosis: diagnosis ? diagnosis.code : null,
      log: connected ? [] : (Array.isArray(log) ? log : []),
    });
  } catch (error) {
    return sendError(res, error, 'Gagal me-restart VPN.');
  }
});

function peerId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

async function serverPayload(live) {
  const bundle = await vpn.loadServer(pool);
  const view = vpn.presentServer(bundle, live || { peers: [] });
  return { bundle, view };
}

// GET /api/sistem/vpn/server
router.get('/server', async (req, res) => {
  try {
    const live = await vpn.service.getServerStatus();
    const { view } = await serverPayload(live);
    res.json({ success: true, ...view, status: live });
  } catch (error) {
    console.error('[vpn] server:', error);
    res.status(500).json({ success: false, message: 'Gagal membaca VPN Server.' });
  }
});

// POST /api/sistem/vpn/server/save
router.post('/server/save', async (req, res) => {
  try {
    const bundle = await vpn.saveServerSettings(pool, req.body || {}, req.user?.username);
    const status = await vpn.service.syncServer(bundle.server, bundle.peers);
    const view = vpn.presentServer(bundle, status);
    res.json({
      success: true,
      message: status.state === 'active' ? 'Pengaturan server disimpan dan diterapkan ulang.' : 'Pengaturan server disimpan.',
      ...view,
      status,
    });
  } catch (error) {
    sendError(res, error, 'Gagal menyimpan VPN Server.');
  }
});

// POST /api/sistem/vpn/server/action  { action: enable|disable|restart }
router.post('/server/action', async (req, res) => {
  const action = typeof req.body?.action === 'string' ? req.body.action.trim().toLowerCase() : '';
  if (!['enable', 'disable', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Aksi harus enable, disable, atau restart.' });
  }
  try {
    const bundle = await vpn.loadServer(pool);
    const status = await vpn.service.controlServer(action, bundle.server, bundle.peers);
    const view = vpn.presentServer(await vpn.loadServer(pool), status);
    const message = action === 'disable'
      ? 'VPN Server dimatikan. Port UDP dan subnet-nya ditutup di UFW.'
      : action === 'restart'
        ? 'VPN Server di-restart. VPN Client ikut dimatikan bila masih jalan.'
        : 'VPN Server aktif. Keempat VPN Client dimatikan supaya tidak bentrok.';
    return res.json({ success: true, message, ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal mengubah VPN Server.');
  }
});

// POST /api/sistem/vpn/server/peers
router.post('/server/peers', async (req, res) => {
  try {
    const { bundle } = await vpn.addServerPeer(pool, req.body || {});
    const status = await vpn.service.syncServer(bundle.server, bundle.peers);
    const view = vpn.presentServer(bundle, status);
    res.json({ success: true, message: 'Peer ditambahkan. IP VPN diberikan otomatis.', ...view, status });
  } catch (error) {
    sendError(res, error, 'Gagal menambah peer.');
  }
});

router.patch('/server/peers/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.updateServerPeer(pool, id, req.body || {});
    const status = await vpn.service.syncServer(bundle.server, bundle.peers);
    const view = vpn.presentServer(bundle, status);
    return res.json({ success: true, message: 'Peer diperbarui.', ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal memperbarui peer.');
  }
});

router.delete('/server/peers/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.deleteServerPeer(pool, id);
    const status = await vpn.service.syncServer(bundle.server, bundle.peers);
    const view = vpn.presentServer(bundle, status);
    return res.json({ success: true, message: 'Peer dihapus.', ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal menghapus peer.');
  }
});

async function ovpnPayload(live) {
  const bundle = await vpn.loadOvpnServer(pool);
  const view = vpn.presentOvpnServer(bundle, live || { peers: [] });
  return { bundle, view };
}

router.get('/server/ovpn', async (req, res) => {
  try {
    const live = await vpn.service.getOvpnServerStatus();
    const { view } = await ovpnPayload(live);
    res.json({ success: true, ...view, status: live });
  } catch (error) {
    console.error('[vpn] ovpn server:', error);
    res.status(500).json({ success: false, message: 'Gagal membaca OpenVPN Server.' });
  }
});

router.post('/server/ovpn/save', async (req, res) => {
  try {
    const bundle = await vpn.saveOvpnServerSettings(pool, req.body || {}, req.user?.username);
    const status = await vpn.service.syncOvpnServer(bundle.server, bundle.peers);
    const view = vpn.presentOvpnServer(bundle, status);
    res.json({
      success: true,
      message: status.state === 'active' ? 'Pengaturan OpenVPN disimpan dan diterapkan ulang.' : 'Pengaturan OpenVPN disimpan.',
      ...view,
      status,
    });
  } catch (error) {
    sendError(res, error, 'Gagal menyimpan OpenVPN Server.');
  }
});

router.post('/server/ovpn/action', async (req, res) => {
  const action = typeof req.body?.action === 'string' ? req.body.action.trim().toLowerCase() : '';
  if (!['enable', 'disable', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Aksi harus enable, disable, atau restart.' });
  }
  try {
    const bundle = await vpn.loadOvpnServer(pool);
    const status = await vpn.service.controlOvpnServer(action, bundle.server, bundle.peers);
    const view = vpn.presentOvpnServer(await vpn.loadOvpnServer(pool), status);
    const message = action === 'disable'
      ? 'OpenVPN Server dimatikan. Port TCP dan subnet-nya ditutup di UFW.'
      : action === 'restart'
        ? 'OpenVPN Server di-restart. VPN Client ikut dimatikan bila masih jalan.'
        : 'OpenVPN Server aktif. VPN Client dimatikan. WireGuard Server tetap boleh hidup.';
    return res.json({ success: true, message, ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal mengubah OpenVPN Server.');
  }
});

router.post('/server/ovpn/peers', async (req, res) => {
  try {
    const { bundle } = await vpn.addOvpnPeer(pool, req.body || {});
    const status = await vpn.service.syncOvpnServer(bundle.server, bundle.peers);
    const view = vpn.presentOvpnServer(bundle, status);
    res.json({ success: true, message: 'Peer ROS v6 ditambahkan. IP VPN diberikan otomatis.', ...view, status });
  } catch (error) {
    sendError(res, error, 'Gagal menambah peer OpenVPN.');
  }
});

router.patch('/server/ovpn/peers/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.updateOvpnPeer(pool, id, req.body || {});
    const status = await vpn.service.syncOvpnServer(bundle.server, bundle.peers);
    const view = vpn.presentOvpnServer(bundle, status);
    return res.json({ success: true, message: 'Peer OpenVPN diperbarui.', ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal memperbarui peer OpenVPN.');
  }
});

router.delete('/server/ovpn/peers/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.deleteOvpnPeer(pool, id);
    const status = await vpn.service.syncOvpnServer(bundle.server, bundle.peers);
    const view = vpn.presentOvpnServer(bundle, status);
    return res.json({ success: true, message: 'Peer OpenVPN dihapus.', ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal menghapus peer OpenVPN.');
  }
});

router.get('/server/ovpn/peers/:id/script', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.loadOvpnServer(pool);
    const result = vpn.ovpnServerScript(bundle, id);
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Gagal membuat script MikroTik.');
  }
});

async function l2tpPayload(live) {
  const bundle = await vpn.loadL2tpServer(pool);
  const view = vpn.presentL2tpServer(bundle, live || { peers: [] });
  return { bundle, view };
}

router.get('/server/l2tp', async (req, res) => {
  try {
    const live = await vpn.service.getL2tpServerStatus();
    const { view } = await l2tpPayload(live);
    res.json({ success: true, ...view, status: live });
  } catch (error) {
    console.error('[vpn] l2tp server:', error);
    res.status(500).json({ success: false, message: 'Gagal membaca L2TP Server.' });
  }
});

router.post('/server/l2tp/save', async (req, res) => {
  try {
    const bundle = await vpn.saveL2tpServerSettings(pool, req.body || {}, req.user?.username);
    const status = await vpn.service.syncL2tpServer(bundle.server, bundle.peers);
    const view = vpn.presentL2tpServer(bundle, status);
    res.json({
      success: true,
      message: status.state === 'active' ? 'Pengaturan L2TP disimpan dan diterapkan ulang.' : 'Pengaturan L2TP disimpan.',
      ...view,
      status,
    });
  } catch (error) {
    sendError(res, error, 'Gagal menyimpan L2TP Server.');
  }
});

router.post('/server/l2tp/action', async (req, res) => {
  const action = typeof req.body?.action === 'string' ? req.body.action.trim().toLowerCase() : '';
  if (!['enable', 'disable', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Aksi harus enable, disable, atau restart.' });
  }
  try {
    const bundle = await vpn.loadL2tpServer(pool);
    const status = await vpn.service.controlL2tpServer(action, bundle.server, bundle.peers);
    const view = vpn.presentL2tpServer(await vpn.loadL2tpServer(pool), status);
    if (action === 'disable' && status.state === 'active') {
      return res.status(500).json({
        success: false,
        message: 'L2TP Server masih aktif setelah perintah matikan.',
        ...view,
        status,
      });
    }
    const message = action === 'disable'
      ? 'L2TP Server dimatikan. Port UDP dan subnet-nya ditutup di UFW.'
      : action === 'restart'
        ? 'L2TP Server di-restart. VPN Client ikut dimatikan bila masih jalan.'
        : 'L2TP Server aktif. VPN Client dimatikan. WireGuard Server dan OpenVPN Server tetap boleh hidup.';
    return res.json({ success: true, message, ...view, status });
  } catch (error) {
    const status = Number(error.status) || 500;
    const detail = String(error.message || '').trim();
    return res.status(status).json({
      success: false,
      message: detail || 'Gagal mengubah L2TP Server.',
      field: error.field || undefined,
    });
  }
});

router.post('/server/l2tp/peers', async (req, res) => {
  try {
    const { bundle } = await vpn.addL2tpPeer(pool, req.body || {});
    const status = await vpn.service.syncL2tpServer(bundle.server, bundle.peers);
    const view = vpn.presentL2tpServer(bundle, status);
    res.json({ success: true, message: 'Peer L2TP ditambahkan. IP VPN dan RADIUS secret dibuat otomatis.', ...view, status });
  } catch (error) {
    sendError(res, error, 'Gagal menambah peer L2TP.');
  }
});

router.patch('/server/l2tp/peers/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.updateL2tpPeer(pool, id, req.body || {});
    const status = await vpn.service.syncL2tpServer(bundle.server, bundle.peers);
    const view = vpn.presentL2tpServer(bundle, status);
    return res.json({ success: true, message: 'Peer L2TP diperbarui.', ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal memperbarui peer L2TP.');
  }
});

router.delete('/server/l2tp/peers/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.deleteL2tpPeer(pool, id);
    const status = await vpn.service.syncL2tpServer(bundle.server, bundle.peers);
    const view = vpn.presentL2tpServer(bundle, status);
    return res.json({ success: true, message: 'Peer L2TP dihapus.', ...view, status });
  } catch (error) {
    return sendError(res, error, 'Gagal menghapus peer L2TP.');
  }
});

router.get('/server/l2tp/peers/:id/script', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.loadL2tpServer(pool);
    const result = vpn.l2tpServerScript(bundle, id);
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Gagal membuat script MikroTik.');
  }
});

router.get('/server/ovpn/ca', async (req, res) => {
  try {
    const pem = await vpn.service.readOvpnCa();
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, filename: 'raniah-ovpn-ca.crt', pem });
  } catch (error) {
    return sendError(res, error, 'Gagal membaca CA OpenVPN.');
  }
});

router.get('/chr-nas', async (req, res) => {
  try {
    const data = await vpn.listChrNas(pool);
    res.json({ success: true, ...data });
  } catch (error) {
    sendError(res, error, 'Gagal membaca daftar NAS CHR.');
  }
});

router.post('/chr-nas', async (req, res) => {
  try {
    const item = await vpn.addChrNas(pool, req.body || {});
    const data = await vpn.listChrNas(pool);
    res.json({ success: true, message: 'NAS CHR ditambahkan. Secret RADIUS dibuat otomatis.', item, ...data });
  } catch (error) {
    sendError(res, error, 'Gagal menambah NAS CHR.');
  }
});

router.patch('/chr-nas/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID NAS tidak valid.' });
  }
  try {
    await vpn.updateChrNas(pool, id, req.body || {});
    const data = await vpn.listChrNas(pool);
    return res.json({ success: true, message: 'NAS CHR diperbarui.', ...data });
  } catch (error) {
    return sendError(res, error, 'Gagal memperbarui NAS CHR.');
  }
});

router.delete('/chr-nas/:id', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID NAS tidak valid.' });
  }
  try {
    await vpn.deleteChrNas(pool, id);
    const data = await vpn.listChrNas(pool);
    return res.json({ success: true, message: 'NAS CHR dihapus dari FreeRADIUS.', ...data });
  } catch (error) {
    return sendError(res, error, 'Gagal menghapus NAS CHR.');
  }
});

router.get('/chr-nas/:id/script', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID NAS tidak valid.' });
  }
  try {
    const data = await vpn.chrNasScript(pool, id);
    return res.json({ success: true, ...data });
  } catch (error) {
    return sendError(res, error, 'Gagal membuat script MikroTik.');
  }
});

router.get('/server/peers/:id/script', async (req, res) => {
  const id = peerId(req.params.id);
  if (!id) {
    return res.status(400).json({ success: false, message: 'ID peer tidak valid.' });
  }
  try {
    const bundle = await vpn.loadServer(pool);
    const result = vpn.serverScript(bundle, id);
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Gagal membuat script MikroTik.');
  }
});

module.exports = router;
