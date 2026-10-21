import api from './axios.js'

// Semua request memakai instance axios bersama (token JWT ditempel otomatis).
const BASE = '/api/acs'

// ---- Server ACS ----
export const getAcsServers = () => api.get(`${BASE}/server`).then((res) => res.data)

// payload: { nama_server, ip_domain, port }
export const createAcsServer = (payload) => api.post(`${BASE}/server`, payload).then((res) => res.data)

export const deleteAcsServer = (id) => api.delete(`${BASE}/server/${id}`).then((res) => res.data)

// ---- Data ONU ----
// Daftar perangkat langsung dari NBI GenieACS (lewat backend) -> array JSON GenieACS.
export const getAcsDevices = (serverId, config = {}) =>
  api.get(`${BASE}/devices`, { ...config, params: { server_id: serverId } }).then((res) => res.data)

// SINKRON: selaraskan DB web dengan GenieACS.
export const syncAcs = (serverId) => api.post(`${BASE}/sync`, { server_id: serverId }).then((res) => res.data)

// ---- Aksi multi-select: ids = array _id perangkat GenieACS (kolom DEVICE ID) ----
const postAction = (path, serverId, ids) =>
  api.post(`${BASE}/${path}`, { server_id: serverId, ids }).then((res) => res.data)

export const resetAcsDevices = (serverId, ids) => postAction('reset', serverId, ids)
export const rebootAcsDevices = (serverId, ids) => postAction('reboot', serverId, ids)
export const summonAcsDevices = (serverId, ids) => postAction('summon', serverId, ids)
export const deleteAcsDevices = (serverId, ids) => postAction('delete', serverId, ids)
