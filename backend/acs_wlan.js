// Validasi permintaan "Update WLAN" dan penyusunan parameterValues TR-069 (setParameterValues).
// Murni (tanpa jaringan/DB) supaya mudah dites.

const IGD = 'InternetGatewayDevice';
const MAX_WLAN_ID = 16;
const SSID_MAX_BYTES = 32; // standar 802.11: SSID maksimal 32 oktet
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 63; // batas passphrase WPA/WPA2 (UI membatasi lebih ketat: 8-20)

function isNode(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asBoolean(value) {
  if (value === true || value === 1) {
    return true;
  }
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'true' || text === '1';
}

// Membaca & memvalidasi body. Hasil: { error } atau { value }.
// wlanId dan nilai-nilai ini masuk ke path/nilai TR-069, jadi dibatasi ketat.
function parseWlanUpdate(body) {
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!deviceId || deviceId.length > 255) {
    return { error: 'ID perangkat tidak valid' };
  }

  const wlanText = String(body?.wlanId ?? '').trim();
  const wlanNumber = Number(wlanText);
  if (!/^\d{1,2}$/.test(wlanText) || wlanNumber < 1 || wlanNumber > MAX_WLAN_ID) {
    return { error: `ID WLAN tidak valid (1-${MAX_WLAN_ID})` };
  }

  const ssid = body?.ssid;
  // eslint-disable-next-line no-control-regex
  if (typeof ssid !== 'string' || ssid.length === 0 || /[\u0000-\u001f\u007f]/.test(ssid)) {
    return { error: 'SSID wajib diisi dan tidak boleh berisi karakter kontrol' };
  }
  if (Buffer.byteLength(ssid, 'utf8') > SSID_MAX_BYTES) {
    return { error: `SSID maksimal ${SSID_MAX_BYTES} karakter` };
  }

  // Password opsional: kosong = tidak diubah.
  const rawPassword = body?.password;
  let password = '';
  if (rawPassword !== undefined && rawPassword !== null && rawPassword !== '') {
    if (typeof rawPassword !== 'string' || !/^[\x20-\x7e]+$/.test(rawPassword)) {
      return { error: 'Password hanya boleh berisi karakter ASCII yang dapat dicetak' };
    }
    if (rawPassword.length < PASSWORD_MIN || rawPassword.length > PASSWORD_MAX) {
      return { error: `Password harus ${PASSWORD_MIN}-${PASSWORD_MAX} karakter` };
    }
    password = rawPassword;
  }

  if (typeof body?.status !== 'boolean') {
    return { error: 'Status harus berupa true (Enabled) atau false (Disabled)' };
  }

  return {
    value: {
      deviceId, wlanId: String(wlanNumber), ssid, password, status: body.status,
    },
  };
}

// Path parameter sandi yang benar-benar ada di ONU. Urutan: PreSharedKey.1.PreSharedKey (default),
// PreSharedKey.1.KeyPassphrase, KeyPassphrase. Tidak ada satu pun -> default.
function passwordPathFor(wlanId, wlanNode) {
  const base = `${IGD}.LANDevice.1.WLANConfiguration.${wlanId}`;
  const psk = wlanNode?.PreSharedKey?.[1];
  if (isNode(psk?.PreSharedKey) || !(isNode(psk?.KeyPassphrase) || isNode(wlanNode?.KeyPassphrase))) {
    return `${base}.PreSharedKey.1.PreSharedKey`;
  }
  return isNode(psk?.KeyPassphrase) ? `${base}.PreSharedKey.1.KeyPassphrase` : `${base}.KeyPassphrase`;
}

// Menyusun parameterValues ([path, nilai, tipe]) hanya untuk yang berubah dari konfigurasi saat ini
// (wlanNode = node WLANConfiguration.{id} dari GenieACS). changed berisi nama field, bukan nilainya.
function planWlanUpdate({ wlanId, wlanNode, ssid, password, status }) {
  const base = `${IGD}.LANDevice.1.WLANConfiguration.${wlanId}`;
  const parameterValues = [];
  const changed = [];

  if (wlanNode?.SSID?._value !== ssid) {
    parameterValues.push([`${base}.SSID`, ssid, 'xsd:string']);
    changed.push('ssid');
  }
  if (asBoolean(wlanNode?.Enable?._value) !== status || wlanNode?.Enable === undefined) {
    parameterValues.push([`${base}.Enable`, status, 'xsd:boolean']);
    changed.push('status');
  }
  if (password) {
    const path = passwordPathFor(wlanId, wlanNode);
    const currentPassword = path.endsWith('.PreSharedKey.1.PreSharedKey')
      ? wlanNode?.PreSharedKey?.[1]?.PreSharedKey?._value
      : (wlanNode?.PreSharedKey?.[1]?.KeyPassphrase?._value ?? wlanNode?.KeyPassphrase?._value);
    if (currentPassword !== password) {
      parameterValues.push([path, password, 'xsd:string']);
      changed.push('password');
    }
  }
  return { parameterValues, changed };
}

module.exports = {
  parseWlanUpdate,
  planWlanUpdate,
  passwordPathFor,
};
