// Merangkum dokumen perangkat GenieACS (NBI) menjadi objek ONU yang bersih dan standar.
// Seluruh ekstraksi path TR-069 dan konversi satuan dilakukan di sini, bukan di frontend.

// ---- Projection NBI ---------------------------------------------------------
// Hanya path yang dipakai ringkasan di bawah (balasan tetap kecil). Projection NBI tidak
// mendukung wildcard, jadi instance 1-4 ditulis eksplisit.
const INSTANCES = [1, 2, 3, 4];
const IGD = 'InternetGatewayDevice';
// Urutan = prioritas: path pertama yang berisi nilai dipakai. Satu daftar ini dipakai untuk
// projection NBI sekaligus untuk pembacaan nilai, jadi keduanya tidak bisa tidak sinkron.
// Nama berhubung tanda minus (X_CT-COM_...) aman: path hanya dipecah pada titik.
const RX_PATHS = [
  // Standar TR-098 / TR-181
  `${IGD}.WANDevice.1.WANPONInterfaceConfig.RXPower`,
  'Device.Optical.Interface.1.OpticalSignalLevel',
  // FiberHome
  `${IGD}.WANDevice.1.X_FH_GponInterfaceConfig.RXPower`,
  `${IGD}.WANDevice.1.WANDSLInterfaceConfig.X_FH_RxPower`,
  // CT-COM
  `${IGD}.WANDevice.1.X_CTCOM_WANDrop.RxPower`,
  `${IGD}.WANDevice.1.WANPONInterfaceConfig.X_CTCOM_RxPower`,
  // CMCC (GPON dan EPON)
  `${IGD}.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower`,
  `${IGD}.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower`,
  // CT-COM (GPON dan EPON)
  `${IGD}.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower`,
  `${IGD}.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower`,
  // Cadangan: CT-COM DeviceInfo, Huawei, ZTE
  `${IGD}.DeviceInfo.X_CTCOM_Optical.RxPower`,
  `${IGD}.WANDevice.1.X_GponInterafceConfig.RXPower`,
  `${IGD}.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower`,
];

const TEMP_PATHS = [
  // Standar TR-098 / TR-181
  `${IGD}.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value`,
  'Device.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value',
  // FiberHome / CT-COM (DeviceInfo)
  `${IGD}.DeviceInfo.X_FH_Temperature`,
  `${IGD}.DeviceInfo.X_CTCOM_Temperature`,
  // FiberHome
  `${IGD}.WANDevice.1.X_FH_GponInterfaceConfig.TransceiverTemperature`,
  // CMCC (GPON dan EPON)
  `${IGD}.WANDevice.1.X_CMCC_GponInterfaceConfig.TransceiverTemperature`,
  `${IGD}.WANDevice.1.X_CMCC_EponInterfaceConfig.TransceiverTemperature`,
  // CT-COM (GPON dan EPON)
  `${IGD}.WANDevice.1.X_CT-COM_GponInterfaceConfig.TransceiverTemperature`,
  `${IGD}.WANDevice.1.X_CT-COM_EponInterfaceConfig.TransceiverTemperature`,
  // Cadangan: Huawei, ZTE, TR-181 Optical
  `${IGD}.WANDevice.1.X_GponInterafceConfig.TransceiverTemperature`,
  `${IGD}.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.TransceiverTemperature`,
  'Device.Optical.Interface.1.TransceiverTemperature',
];

const LIVE_PROJECTION = [
  '_id', '_lastInform', '_registered', '_tags', '_deviceId', '_ip', '_connectionRequestURL',
  `${IGD}.ManagementServer.ConnectionRequestURL`,
  'Device.ManagementServer.ConnectionRequestURL',
  // IP PPPoE
  ...INSTANCES.flatMap((wan) => INSTANCES.map(
    (ppp) => `${IGD}.WANDevice.1.WANConnectionDevice.${wan}.WANPPPConnection.${ppp}.ExternalIPAddress`,
  )),
  ...INSTANCES.map((iface) => `Device.IP.Interface.${iface}.IPv4Address.1.IPAddress`),
  // Username PPPoE
  ...INSTANCES.flatMap((wan) => INSTANCES.map(
    (ppp) => `${IGD}.WANDevice.1.WANConnectionDevice.${wan}.WANPPPConnection.${ppp}.Username`,
  )),
  ...INSTANCES.map((ppp) => `Device.PPP.Interface.${ppp}.Username`),
  // SSID, jumlah host, uptime
  `${IGD}.LANDevice.1.WLANConfiguration.1.SSID`,
  'Device.WiFi.SSID.1.SSID',
  `${IGD}.LANDevice.1.Hosts.HostNumberOfEntries`,
  'Device.Hosts.HostNumberOfEntries',
  `${IGD}.LANDevice.1.WLANConfiguration.1.TotalAssociations`,
  `${IGD}.DeviceInfo.UpTime`,
  'Device.DeviceInfo.UpTime',
  // RX dan suhu optik
  ...RX_PATHS,
  ...TEMP_PATHS,
  // Deteksi PON (GPON/EPON)
  `${IGD}.DeviceInfo.ModelName`,
  `${IGD}.DeviceInfo.Description`,
  `${IGD}.WANDevice.1.WANCommonInterfaceConfig.WANAccessType`,
  'Device.DeviceInfo.ModelName',
  'Device.DeviceInfo.Description',
].filter((path, index, all) => all.indexOf(path) === index).join(',');

// ---- Helper pembaca path ----------------------------------------------------
function isNode(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmpty(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// Nilai (_value) pada path berpemisah titik, mis. "InternetGatewayDevice.DeviceInfo.UpTime".
// Aman terhadap node yang tidak ada (setara optional chaining ?.) dan mengembalikan undefined.
function readPath(doc, path) {
  let node = doc;
  for (const key of path.split('.')) {
    node = isNode(node) ? node[key] : undefined;
    if (node === undefined) {
      return undefined;
    }
  }
  return isNode(node) ? node._value : undefined;
}

// Nilai pertama yang tidak kosong dari beberapa path (setara "||" tetapi nilai 0 tetap dianggap ada).
function firstOf(doc, paths) {
  for (const path of paths) {
    const value = readPath(doc, path);
    if (!isEmpty(value)) {
      return value;
    }
  }
  return undefined;
}

// Semua nilai pada path yang memakai "*" sebagai pengganti satu level instance.
function readAll(doc, path) {
  let nodes = [doc];
  for (const key of path.split('.')) {
    nodes = nodes.flatMap((node) => {
      if (!isNode(node)) {
        return [];
      }
      if (key === '*') {
        return Object.keys(node).filter((name) => !name.startsWith('_')).map((name) => node[name]);
      }
      return node[key] === undefined ? [] : [node[key]];
    });
  }
  return nodes.map((node) => (isNode(node) ? node._value : undefined)).filter((value) => !isEmpty(value));
}

function toNumber(value) {
  if (isEmpty(value)) {
    return null;
  }
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  return value === null ? null : Number(value.toFixed(digits));
}

function toText(value) {
  return isEmpty(value) ? null : String(value).trim();
}

const IPV4_PATTERN = /(\d{1,3}(?:\.\d{1,3}){3})/;
const IPV4_EXACT = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

// Dipakai frontend sebagai href: hanya IPv4 valid, bukan 0.0.0.0 / loopback.
function cleanIp(value) {
  const ip = typeof value === 'string' ? value.trim() : '';
  return IPV4_EXACT.test(ip) && ip !== '0.0.0.0' && !ip.startsWith('127.') ? ip : null;
}

// ---- Ekstraksi per kolom ----------------------------------------------------
function extractIpTr069(doc) {
  const url = doc._connectionRequestURL ?? firstOf(doc, [
    `${IGD}.ManagementServer.ConnectionRequestURL`,
    'Device.ManagementServer.ConnectionRequestURL',
  ]);
  const fromUrl = typeof url === 'string' ? url.match(IPV4_PATTERN)?.[1] : null;
  return cleanIp(typeof doc._ip === 'string' ? doc._ip : doc._ip?._value) ?? cleanIp(fromUrl);
}

function extractIpPppoe(doc) {
  const candidates = [
    ...readAll(doc, `${IGD}.WANDevice.1.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress`),
    ...readAll(doc, 'Device.IP.Interface.*.IPv4Address.*.IPAddress'),
  ];
  return candidates.map(cleanIp).find(Boolean) ?? null;
}

function extractUsername(doc) {
  const candidates = [
    ...readAll(doc, `${IGD}.WANDevice.1.WANConnectionDevice.*.WANPPPConnection.*.Username`),
    ...readAll(doc, 'Device.PPP.Interface.*.Username'),
  ];
  return candidates.map(toText).find(Boolean) ?? null;
}

// EPON dicek lebih dulu, lalu GPON. ProductClass sering hanya kode model, jadi
// ModelName, Description, dan WANAccessType dipakai sebagai cadangan.
function detectPon(doc) {
  const sources = [
    doc._deviceId?._ProductClass,
    readPath(doc, `${IGD}.DeviceInfo.ModelName`),
    readPath(doc, 'Device.DeviceInfo.ModelName'),
    readPath(doc, `${IGD}.DeviceInfo.Description`),
    readPath(doc, 'Device.DeviceInfo.Description'),
    readPath(doc, `${IGD}.WANDevice.1.WANCommonInterfaceConfig.WANAccessType`),
  ];
  for (const source of sources) {
    const text = typeof source === 'string' ? source.toUpperCase() : '';
    if (text.includes('EPON')) {
      return 'EPON';
    }
    if (text.includes('GPON')) {
      return 'GPON';
    }
  }
  return null;
}

// RX ONU (dBm). Positif = daya linear ZTE dalam 0.1 uW: 10 * log10(val / 10000).
// Lebih kecil dari -100 = Huawei tanpa koma (-1750): dibagi 100. Selain itu apa adanya.
function extractRxOnu(doc) {
  let value = toNumber(firstOf(doc, RX_PATHS));
  if (value === null) {
    return null;
  }
  if (value > 0) {
    value = 10 * Math.log10(value / 10000);
  } else if (value < -100) {
    value /= 100;
  }
  return round(value, 2);
}

// Suhu (°C). Nilai > 1000 bukan °C: umumnya 1/256 °C (13030 -> 50.9). Bila hasil bagi 256
// tidak masuk akal (> 150 °C) dianggap milli-°C dan dibagi 1000 (45000 -> 45).
function extractTemp(doc) {
  let value = toNumber(firstOf(doc, TEMP_PATHS));
  if (value === null) {
    return null;
  }
  if (value > 1000) {
    value /= 256;
    if (value > 150) {
      value = (value * 256) / 1000;
    }
  }
  return round(value, 2);
}

// ---- Ringkasan satu perangkat -----------------------------------------------
function summarizeDevice(item) {
  const tags = Array.isArray(item._tags) ? item._tags.map(String) : [];
  return {
    id: String(item._id),
    sn: toText(item._deviceId?._SerialNumber),
    manufaktur: toText(item._deviceId?._Manufacturer),
    tipe: toText(item._deviceId?._ProductClass),
    pon: detectPon(item),
    username: extractUsername(item),
    last_inform: item._lastInform ?? null,
    registered: item._registered ?? null,
    tags,
    ip_tr069: extractIpTr069(item),
    ip_pppoe: extractIpPppoe(item),
    ssid: toText(firstOf(item, [
      `${IGD}.LANDevice.1.WLANConfiguration.1.SSID`,
      'Device.WiFi.SSID.1.SSID',
    ])),
    user: toNumber(firstOf(item, [
      `${IGD}.LANDevice.1.Hosts.HostNumberOfEntries`,
      'Device.Hosts.HostNumberOfEntries',
      // Cadangan: jumlah klien WiFi yang terhubung (hanya WiFi, bukan seluruh host LAN).
      `${IGD}.LANDevice.1.WLANConfiguration.1.TotalAssociations`,
    ])),
    uptime: toNumber(firstOf(item, [`${IGD}.DeviceInfo.UpTime`, 'Device.DeviceInfo.UpTime'])),
    rx_onu: extractRxOnu(item),
    temp: extractTemp(item),
  };
}

module.exports = {
  LIVE_PROJECTION,
  RX_PATHS,
  TEMP_PATHS,
  readPath,
  summarizeDevice,
};
