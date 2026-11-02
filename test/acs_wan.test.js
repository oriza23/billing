const test = require('node:test');
const assert = require('node:assert/strict');
const {
  supportsPppoeRouted,
  connectionTypeError,
  CONNECTION_TYPE_TR069,
  parseWanPpp,
  parseWanIp,
  planWanPpp,
  planWanIp,
  batchWanParameters,
  normalizeDeviceType,
  skipConnectionName,
} = require('../backend/acs_wan');

test('FiberHome dan merek sejenis boleh pppoe_routed', () => {
  assert.equal(supportsPppoeRouted('FiberHome'), true);
  assert.equal(supportsPppoeRouted('ZTE'), false);
  assert.equal(supportsPppoeRouted('ZTE', 'Fiberhome'), true);
  assert.equal(connectionTypeError('ZTE', 'pppoe_routed'), 'Connection Type pppoe_routed tidak didukung merek modem ini');
  assert.equal(connectionTypeError('ZTE', 'pppoe_routed', 'Fiberhome'), null);
  assert.equal(connectionTypeError('FiberHome', 'pppoe_routed'), null);
});

test('nilai dropdown dipetakan ke ConnectionType TR-069', () => {
  assert.equal(CONNECTION_TYPE_TR069['ip-routed'], 'IP_Routed');
  assert.equal(CONNECTION_TYPE_TR069.pppoe_bridged, 'PPPoE_Bridged');
  assert.equal(CONNECTION_TYPE_TR069.pppoe_routed, 'PPPoE_Routed');
});

test('parseWanPpp menolak isian tanpa device', () => {
  const parsed = parseWanPpp({});
  assert.ok(parsed.error);
});

const PPP_PATH = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.';
const IP_PATH = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.';

function pppBody(extra = {}) {
  return {
    deviceId: 'ONT-1',
    connectionName: 'pppoe_internet',
    enableConnection: true,
    natStatus: true,
    vlanStatus: false,
    serviceList: 'INTERNET',
    connectionType: 'ip-routed',
    priority: 0,
    username: 'budi@net',
    password: 'rahasia',
    ports: [],
    ...extra,
  };
}

function ipBody(extra = {}) {
  return {
    deviceId: 'ONT-1',
    connectionName: 'ip_internet',
    enableConnection: true,
    vlanStatus: false,
    serviceList: 'INTERNET',
    connectionType: 'IP_Routed',
    addressing: 'DHCP',
    priority: 0,
    ports: [],
    ...extra,
  };
}

function planPpp(extra, manufacturer) {
  const parsed = parseWanPpp(pppBody(extra));
  assert.equal(parsed.error, undefined);
  const plan = planWanPpp({
    values: parsed.value,
    manufacturer,
    pppPath: PPP_PATH,
    connectionPath: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.',
    knownLeaves: ['Enable', 'Name', 'ConnectionType', 'Username', 'Password', 'NATEnabled'],
    dataModel: 'InternetGatewayDevice',
  });
  return plan;
}

function planIp(extra, manufacturer) {
  const parsed = parseWanIp(ipBody(extra));
  assert.equal(parsed.error, undefined);
  return planWanIp({
    values: parsed.value,
    manufacturer,
    ipPath: IP_PATH,
    connectionPath: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.',
    knownLeaves: ['Enable', 'Name', 'ConnectionType', 'NATEnabled', 'AddressingType'],
    dataModel: 'InternetGatewayDevice',
  });
}

const hasName = (rows) => rows.some(([path]) => path.endsWith('.Name'));

test('normalizeDeviceType mengenali empat merek dan menolak yang lain', () => {
  assert.equal(normalizeDeviceType('ZTE'), 'zte');
  assert.equal(normalizeDeviceType('Huawei'), 'huawei');
  assert.equal(normalizeDeviceType('ChinaMobile'), 'chinamobile');
  assert.equal(normalizeDeviceType('China Mobile'), 'chinamobile');
  assert.equal(normalizeDeviceType('FiberHome'), 'fiberhome');
  assert.equal(normalizeDeviceType('Mikrotik'), '');
});

test('skipConnectionName: Fiberhome dari pilihan user atau merek ONU', () => {
  assert.equal(skipConnectionName({ deviceType: 'Fiberhome', manufacturer: 'ZTE' }), true);
  assert.equal(skipConnectionName({ deviceType: 'ZTE', manufacturer: 'FiberHome' }), true);
  assert.equal(skipConnectionName({ deviceType: 'ZTE', manufacturer: 'ZTE' }), false);
  assert.equal(skipConnectionName({ deviceType: 'Huawei', manufacturer: '' }), false);
});

test('parseWanPpp/parseWanIp: Fiberhome tidak butuh Connection Name, merek lain wajib', () => {
  for (const [parse, body] of [[parseWanPpp, pppBody], [parseWanIp, ipBody]]) {
    const fh = parse(body({ deviceType: 'Fiberhome', connectionName: '' }));
    assert.equal(fh.error, undefined);
    assert.equal(fh.value.connectionName, '');
    assert.equal(fh.value.deviceType, 'fiberhome');
    const ignored = parse(body({ deviceType: 'Fiberhome', connectionName: 'Otomatis' }));
    assert.equal(ignored.value.connectionName, '');
    for (const type of ['ZTE', 'Huawei', 'ChinaMobile']) {
      assert.match(parse(body({ deviceType: type, connectionName: '' })).error, /Connection Name wajib/);
      assert.equal(parse(body({ deviceType: type })).value.deviceType, type.toLowerCase());
    }
    assert.match(parse(body({ deviceType: 'Mikrotik' })).error, /Tipe Perangkat/);
    assert.match(parse(body({ connectionName: '' })).error, /Connection Name wajib/);
  }
});

test('WAN PPP: Fiberhome tidak mengirim ...WANPPPConnection.{i}.Name sama sekali', () => {
  const plan = planPpp({ deviceType: 'Fiberhome', connectionName: '' }, 'FiberHome');
  assert.deepEqual(plan.connectionName, []);
  assert.equal(hasName(batchWanParameters(plan)), false);
  assert.equal(plan.fields.includes('connectionName'), false);
  const userPicked = planPpp({ deviceType: 'Fiberhome', connectionName: '' }, 'ZTE');
  assert.deepEqual(userPicked.connectionName, []);
  const detected = planPpp({ deviceType: 'ZTE', connectionName: 'x' }, 'FiberHome');
  assert.deepEqual(detected.connectionName, []);
});

test('WAN PPP: ZTE/Huawei/ChinaMobile membawa Name terpisah dari batch utama', () => {
  for (const [type, manufacturer] of [['ZTE', 'ZTE'], ['Huawei', 'Huawei'], ['ChinaMobile', 'CMCC']]) {
    const plan = planPpp({ deviceType: type }, manufacturer);
    assert.deepEqual(plan.connectionName, [[`${PPP_PATH}Name`, 'pppoe_internet', 'xsd:string']]);
    assert.equal(hasName(batchWanParameters(plan)), false);
    assert.equal(plan.fields[0], 'connectionName');
    const rows = batchWanParameters(plan).map(([path]) => path);
    assert.ok(rows.includes(`${PPP_PATH}Username`));
    assert.ok(rows.includes(`${PPP_PATH}Password`));
  }
});

test('WAN IP: Fiberhome tanpa Name, merek lain membawa Name terpisah', () => {
  const fh = planIp({ deviceType: 'Fiberhome', connectionName: '' }, 'FiberHome');
  assert.deepEqual(fh.connectionName, []);
  assert.equal(hasName(batchWanParameters(fh)), false);
  for (const type of ['ZTE', 'Huawei', 'ChinaMobile']) {
    const plan = planIp({ deviceType: type }, type === 'Huawei' ? 'Huawei' : 'ZTE');
    assert.deepEqual(plan.connectionName, [[`${IP_PATH}Name`, 'ip_internet', 'xsd:string']]);
    assert.equal(hasName(batchWanParameters(plan)), false);
  }
});

test('9003: koneksi bridged selalu NATEnabled=false walau form mencentang NAT', () => {
  const natOf = (extra) => batchWanParameters(planPpp({ natStatus: true, ...extra }, 'ZTE'))
    .find(([path]) => path.endsWith('.NATEnabled'))[1];
  assert.equal(natOf({ connectionType: 'PPPoE_Bridged' }), false);
  assert.equal(natOf({ connectionType: 'ip-routed' }), true);
});
