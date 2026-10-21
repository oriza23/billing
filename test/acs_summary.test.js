const test = require('node:test');
const assert = require('node:assert/strict');
const { LIVE_PROJECTION, readPath, summarizeDevice } = require('../backend/acs_summary');

const v = (value) => ({ _value: value });
const base = { _id: 'DEV-1', _deviceId: { _SerialNumber: 'SN1', _Manufacturer: 'ZTE', _ProductClass: 'F670L' } };
const withIgd = (igd) => ({ ...base, InternetGatewayDevice: igd });
const rx = (igd) => summarizeDevice(withIgd(igd)).rx_onu;
const temp = (igd) => summarizeDevice(withIgd(igd)).temp;

test('readPath aman terhadap node yang tidak ada', () => {
  assert.equal(readPath({}, 'A.B.C'), undefined);
  assert.equal(readPath({ A: { B: v('x') } }, 'A.B'), 'x');
  assert.equal(readPath({ A: null }, 'A.B'), undefined);
  assert.equal(readPath({ A: { B: { C: v(1) } } }, 'A.B'), undefined);
});

test('summarizeDevice merangkum perangkat TR-098 lengkap', () => {
  const item = {
    ...base,
    _lastInform: '2026-10-21T04:00:00.000Z',
    _registered: '2026-01-02T00:00:00.000Z',
    _tags: ['vip'],
    InternetGatewayDevice: {
      DeviceInfo: { UpTime: v('190230'), Description: v('GPON ONT') },
      ManagementServer: { ConnectionRequestURL: v('http://10.20.30.40:7547/x') },
      LANDevice: { 1: { WLANConfiguration: { 1: { SSID: v('Rumah') } }, Hosts: { HostNumberOfEntries: v('0') } } },
      WANDevice: {
        1: {
          WANConnectionDevice: {
            1: { WANPPPConnection: { 1: { Username: v(' '), ExternalIPAddress: v('0.0.0.0') } } },
            2: { WANPPPConnection: { 1: { Username: v('budi@isp'), ExternalIPAddress: v('100.64.1.9') } } },
          },
        },
      },
    },
  };
  assert.deepEqual(summarizeDevice(item), {
    id: 'DEV-1',
    sn: 'SN1',
    manufaktur: 'ZTE',
    tipe: 'F670L',
    pon: 'GPON',
    username: 'budi@isp',
    last_inform: '2026-10-21T04:00:00.000Z',
    registered: '2026-01-02T00:00:00.000Z',
    tags: ['vip'],
    ip_tr069: '10.20.30.40',
    ip_pppoe: '100.64.1.9',
    ssid: 'Rumah',
    user: 0,
    uptime: 190230,
    rx_onu: null,
    temp: null,
  });
});

test('perangkat kosong menghasilkan null, bukan error', () => {
  const result = summarizeDevice({ _id: 'X' });
  assert.equal(result.id, 'X');
  for (const key of ['sn', 'manufaktur', 'tipe', 'pon', 'username', 'last_inform', 'ip_tr069', 'ip_pppoe', 'ssid', 'user', 'uptime', 'rx_onu', 'temp']) {
    assert.equal(result[key], null, key);
  }
  assert.deepEqual(result.tags, []);
});

test('rx_onu: positif = daya linear ZTE, 10*log10(val/10000)', () => {
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { RXPower: v('172') } } } }), -17.64);
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { RXPower: v(1000) } } } }), -10);
});

test('rx_onu: lebih kecil dari -100 dibagi 100, selain itu apa adanya', () => {
  assert.equal(rx({ WANDevice: { 1: { X_GponInterafceConfig: { RXPower: v('-1750') } } } }), -17.5);
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { RXPower: v('-24.3') } } } }), -24.3);
});

test('rx_onu: path FiberHome CT-COM dan TR-181 Optical', () => {
  assert.equal(rx({ DeviceInfo: { X_CTCOM_Optical: { RxPower: v('-1850') } } }), -18.5);
  assert.equal(rx({ WANDevice: { 1: { X_CTCOM_WANDrop: { RxPower: v('-19.2') } } } }), -19.2);
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { X_CTCOM_RxPower: v('-20.5') } } } }), -20.5);
  assert.equal(summarizeDevice({ ...base, Device: { Optical: { Interface: { 1: { OpticalSignalLevel: v('-19250') } } } } }).rx_onu, -192.5);
  assert.equal(rx({}), null);
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { RXPower: v('abc') } } } }), null);
});

test('rx_onu: nilai 0 tetap dianggap ada', () => {
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { RXPower: v('0') } } } }), 0);
});

test('temp: > 1000 dibagi 256, milli-celcius dibagi 1000, wajar apa adanya', () => {
  assert.equal(temp({ DeviceInfo: { X_FH_Temperature: v('13030') } }), 50.9);
  assert.equal(temp({ DeviceInfo: { X_CTCOM_Temperature: v('11492') } }), 44.89);
  assert.equal(temp({ DeviceInfo: { TemperatureStatus: { TemperatureSensor: { 1: { Value: v('45000') } } } } }), 45);
  assert.equal(temp({ WANDevice: { 1: { X_GponInterafceConfig: { TransceiverTemperature: v('38.5') } } } }), 38.5);
  assert.equal(temp({}), null);
});

test('pon: EPON diperiksa lebih dulu, lalu GPON, cadangan dari parameter lain', () => {
  const pon = (productClass, igd = {}) => summarizeDevice({
    _id: 'P', _deviceId: { _ProductClass: productClass }, InternetGatewayDevice: igd,
  }).pon;
  assert.equal(pon('ZXHN F601 EPON'), 'EPON');
  assert.equal(pon('xg-gpon'), 'GPON');
  assert.equal(pon('HG8245H'), null);
  assert.equal(pon('HG8245H', { DeviceInfo: { Description: v('GPON ONT') } }), 'GPON');
});

test('ip: hanya IPv4 valid; teks aneh ditolak', () => {
  const ips = (igd) => {
    const result = summarizeDevice(withIgd(igd));
    return [result.ip_pppoe, result.ip_tr069];
  };
  const ppp = (value) => ({ WANDevice: { 1: { WANConnectionDevice: { 1: { WANPPPConnection: { 1: { ExternalIPAddress: v(value) } } } } } } });
  assert.deepEqual(ips(ppp('evil.com/x')), [null, null]);
  assert.deepEqual(ips(ppp('127.0.0.1')), [null, null]);
  assert.equal(summarizeDevice({ ...base, _ip: '172.16.0.5' }).ip_tr069, '172.16.0.5');
  assert.equal(summarizeDevice({ ...base, _connectionRequestURL: 'http://1.2.3.4:58000/x' }).ip_tr069, '1.2.3.4');
  assert.equal(summarizeDevice({ ...base, Device: { IP: { Interface: { 1: { IPv4Address: { 1: { IPAddress: v('10.1.2.3') } } } } } } }).ip_pppoe, '10.1.2.3');
});

test('projection memuat path-path yang dibaca ringkasan', () => {
  for (const path of [
    'InternetGatewayDevice.DeviceInfo.X_CTCOM_Optical.RxPower',
    'InternetGatewayDevice.DeviceInfo.X_FH_Temperature',
    'Device.Optical.Interface.1.OpticalSignalLevel',
    'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
    'InternetGatewayDevice.DeviceInfo.UpTime',
  ]) {
    assert.ok(LIVE_PROJECTION.split(',').includes(path), path);
  }
});

test('FiberHome: X_FH_RxPower (WANDSLInterfaceConfig) dan suhu TR-181 / X_FH', () => {
  assert.equal(rx({ WANDevice: { 1: { WANDSLInterfaceConfig: { X_FH_RxPower: v('-1920') } } } }), -19.2);
  assert.equal(rx({ WANDevice: { 1: { WANDSLInterfaceConfig: { X_FH_RxPower: v('150') } } } }), -18.24);
  assert.equal(summarizeDevice({ ...base, Device: { DeviceInfo: { TemperatureStatus: { TemperatureSensor: { 1: { Value: v('41') } } } } } }).temp, 41);
  assert.equal(temp({ DeviceInfo: { X_FH_Temperature: v('11492') } }), 44.89);
  // Urutan: path standar menang atas path FiberHome.
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { RXPower: v('-20.1') }, WANDSLInterfaceConfig: { X_FH_RxPower: v('-1') } } } }), -20.1);
});

test('projection memuat path FiberHome baru', () => {
  const list = LIVE_PROJECTION.split(',');
  assert.ok(list.includes('InternetGatewayDevice.WANDevice.1.WANDSLInterfaceConfig.X_FH_RxPower'));
  assert.ok(list.includes('Device.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value'));
});

test('FiberHome: X_FH_GponInterfaceConfig.RXPower', () => {
  assert.equal(rx({ WANDevice: { 1: { X_FH_GponInterfaceConfig: { RXPower: v('-1875') } } } }), -18.75);
  assert.equal(rx({ WANDevice: { 1: { X_FH_GponInterfaceConfig: { RXPower: v('-21.4') } } } }), -21.4);
  assert.equal(rx({ WANDevice: { 1: { X_FH_GponInterfaceConfig: { RXPower: v('172') } } } }), -17.64);
  // Standar menang; X_FH_GponInterfaceConfig menang atas X_FH_RxPower (DSL).
  assert.equal(rx({ WANDevice: { 1: { WANPONInterfaceConfig: { RXPower: v('-20.1') }, X_FH_GponInterfaceConfig: { RXPower: v('-1') } } } }), -20.1);
  assert.equal(rx({ WANDevice: { 1: { X_FH_GponInterfaceConfig: { RXPower: v('-22.2') }, WANDSLInterfaceConfig: { X_FH_RxPower: v('-1') } } } }), -22.2);
  assert.ok(LIVE_PROJECTION.split(',').includes('InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower'));
});

test('FiberHome: X_FH_GponInterfaceConfig.TransceiverTemperature', () => {
  const fh = (value) => ({ WANDevice: { 1: { X_FH_GponInterfaceConfig: { TransceiverTemperature: v(value) } } } });
  assert.equal(temp(fh('42.5')), 42.5);
  assert.equal(temp(fh('13030')), 50.9);
  assert.equal(temp(fh('45000')), 45);
  // Path DeviceInfo FiberHome menang atas path transceiver ini.
  assert.equal(temp({ ...fh('40'), DeviceInfo: { X_FH_Temperature: v('36') } }), 36);
  assert.ok(LIVE_PROJECTION.split(',').includes('InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.TransceiverTemperature'));
});

test('user: HostNumberOfEntries diutamakan, TotalAssociations sebagai cadangan', () => {
  const user = (igd) => summarizeDevice(withIgd(igd)).user;
  const lan = (extra) => ({ LANDevice: { 1: extra } });
  assert.equal(user(lan({ Hosts: { HostNumberOfEntries: v('3') }, WLANConfiguration: { 1: { TotalAssociations: v('9') } } })), 3);
  assert.equal(user(lan({ WLANConfiguration: { 1: { TotalAssociations: v('2') } } })), 2);
  assert.equal(user(lan({ Hosts: { HostNumberOfEntries: v('0') }, WLANConfiguration: { 1: { TotalAssociations: v('5') } } })), 0);
  assert.equal(user({}), null);
  assert.equal(summarizeDevice({ ...base, Device: { Hosts: { HostNumberOfEntries: v('4') } } }).user, 4);
  assert.ok(LIVE_PROJECTION.split(',').includes('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations'));
});

test('CMCC: X_CMCC_GponInterfaceConfig.RXPower', () => {
  const cmcc = (value) => ({ WANDevice: { 1: { X_CMCC_GponInterfaceConfig: { RXPower: v(value) } } } });
  assert.equal(rx(cmcc('-1830')), -18.3);
  assert.equal(rx(cmcc('-22.5')), -22.5);
  assert.equal(rx(cmcc('172')), -17.64);
  // Path FiberHome/CT-COM yang lebih dulu dalam daftar menang atas CMCC.
  assert.equal(rx({ WANDevice: { 1: { ...cmcc('-1').WANDevice[1], X_CTCOM_WANDrop: { RxPower: v('-19.9') } } } }), -19.9);
  assert.ok(LIVE_PROJECTION.split(',').includes('InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower'));
});

test('CT-COM: X_CT-COM_GponInterfaceConfig.RXPower (nama berhubung tanda minus)', () => {
  const ct = (value) => ({ WANDevice: { 1: { 'X_CT-COM_GponInterfaceConfig': { RXPower: v(value) } } } });
  assert.equal(rx(ct('-1990')), -19.9);
  assert.equal(rx(ct('-23.1')), -23.1);
  assert.equal(rx(ct('172')), -17.64);
  // CMCC lebih dulu dalam daftar, jadi menang atas CT-COM.
  assert.equal(rx({ WANDevice: { 1: { ...ct('-1').WANDevice[1], X_CMCC_GponInterfaceConfig: { RXPower: v('-21.5') } } } }), -21.5);
  assert.ok(LIVE_PROJECTION.split(',').includes('InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower'));
});

test('EPON CT-COM: X_CT-COM_EponInterfaceConfig.RXPower', () => {
  const epon = (value) => ({ WANDevice: { 1: { 'X_CT-COM_EponInterfaceConfig': { RXPower: v(value) } } } });
  assert.equal(rx(epon('-2010')), -20.1);
  assert.equal(rx(epon('-26.4')), -26.4);
  assert.equal(rx(epon('172')), -17.64);
  // X_CT-COM_GponInterfaceConfig lebih dulu dalam daftar, jadi menang atas EPON.
  assert.equal(rx({ WANDevice: { 1: { ...epon('-1').WANDevice[1], 'X_CT-COM_GponInterfaceConfig': { RXPower: v('-19.5') } } } }), -19.5);
  assert.ok(LIVE_PROJECTION.split(',').includes('InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower'));
});

test('CT-COM GPON/EPON: TransceiverTemperature', () => {
  const ct = (iface, value) => ({ WANDevice: { 1: { [iface]: { TransceiverTemperature: v(value) } } } });
  assert.equal(temp(ct('X_CT-COM_GponInterfaceConfig', '41.5')), 41.5);
  assert.equal(temp(ct('X_CT-COM_EponInterfaceConfig', '13030')), 50.9);
  assert.equal(temp(ct('X_CT-COM_EponInterfaceConfig', '45000')), 45);
  // Urutan: FiberHome Gpon > CT-COM Gpon > CT-COM Epon.
  const both = { WANDevice: { 1: {
    X_FH_GponInterfaceConfig: { TransceiverTemperature: v('30') },
    'X_CT-COM_GponInterfaceConfig': { TransceiverTemperature: v('40') },
    'X_CT-COM_EponInterfaceConfig': { TransceiverTemperature: v('50') },
  } } };
  assert.equal(temp(both), 30);
  delete both.WANDevice[1].X_FH_GponInterfaceConfig;
  assert.equal(temp(both), 40);
  delete both.WANDevice[1]['X_CT-COM_GponInterfaceConfig'];
  assert.equal(temp(both), 50);
  const list = LIVE_PROJECTION.split(',');
  assert.ok(list.includes('InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.TransceiverTemperature'));
  assert.ok(list.includes('InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.TransceiverTemperature'));
});

const { RX_PATHS, TEMP_PATHS } = require('../backend/acs_summary');

// Membangun dokumen dari path berpemisah titik: dokumenDari('A.B.C', '5') -> { A: { B: { C: { _value: '5' } } } }
function docFrom(path, value) {
  const keys = path.split('.');
  const doc = {};
  let node = doc;
  keys.forEach((key, index) => {
    node[key] = index === keys.length - 1 ? { _value: value } : {};
    node = node[key];
  });
  return { _id: 'D', ...doc };
}

test('Ultimate: CMCC EPON untuk RX dan suhu', () => {
  assert.equal(summarizeDevice(docFrom('InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower', '-1960')).rx_onu, -19.6);
  assert.equal(summarizeDevice(docFrom('InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.TransceiverTemperature', '13030')).temp, 50.9);
  assert.equal(summarizeDevice(docFrom('InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.TransceiverTemperature', '38.5')).temp, 38.5);
});

test('Ultimate: setiap path RX dan suhu terbaca, dan semuanya ada di projection', () => {
  const projection = LIVE_PROJECTION.split(',');
  for (const path of RX_PATHS) {
    assert.ok(projection.includes(path), `projection: ${path}`);
    assert.equal(summarizeDevice(docFrom(path, '-21.5')).rx_onu, -21.5, path);
  }
  for (const path of TEMP_PATHS) {
    assert.ok(projection.includes(path), `projection: ${path}`);
    assert.equal(summarizeDevice(docFrom(path, '37.5')).temp, 37.5, path);
  }
  assert.equal(new Set(projection).size, projection.length, 'tanpa duplikat');
});

// Gabung dalam (deep merge) dua dokumen hasil docFrom supaya kedua path ada di satu dokumen.
function mergeDocs(target, source) {
  for (const key of Object.keys(source)) {
    const isBranch = source[key] && typeof source[key] === 'object' && !('_value' in source[key]);
    target[key] = isBranch && target[key] && typeof target[key] === 'object' ? mergeDocs(target[key], source[key]) : source[key];
  }
  return target;
}

test('Ultimate: urutan prioritas RX dan suhu mengikuti daftar (path awal menang)', () => {
  const check = (paths, early, late, read) => {
    for (let i = 0; i < paths.length - 1; i += 1) {
      const both = mergeDocs(docFrom(paths[i + 1], late), docFrom(paths[i], early));
      assert.equal(read(summarizeDevice(both)), Number(early), `${paths[i]} harus menang atas ${paths[i + 1]}`);
    }
  };
  check(RX_PATHS, '-10.5', '-30.5', (result) => result.rx_onu);
  check(TEMP_PATHS, '33.5', '44.5', (result) => result.temp);
});
