const TOKEN_KEY = 'token'
const USER_KEY = 'admin_user'
const ROLE_KEY = 'admin_role'
const NAMA_KEY = 'admin_nama'
const ROLE_LABEL_KEY = 'admin_role_label'
const SUPER_KEY = 'admin_is_super'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

// Membaca waktu kedaluwarsa (exp) dari payload JWT, tanpa verifikasi (verifikasi dilakukan backend).
function readExpiry(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(payload)).exp
  } catch {
    return null
  }
}

export function hasValidToken() {
  const token = getToken()
  if (!token) {
    return false
  }
  const exp = readExpiry(token)
  return !exp || exp * 1000 > Date.now()
}

// `identity.nama_lengkap` dipakai di sapaan header; `role` menentukan label akses.
export function saveSession({ token, username, nama_lengkap: namaLengkap, role, role_label: roleLabel, is_super: isSuper }) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, username)
  localStorage.setItem(ROLE_KEY, role || 'admin')
  localStorage.setItem(NAMA_KEY, namaLengkap || username || '')
  localStorage.setItem(ROLE_LABEL_KEY, roleLabel || role || 'Administrator')
  localStorage.setItem(SUPER_KEY, isSuper ? '1' : '0')
}

// Perbarui identitas tanpa mengubah token (dipakai setelah simpan profil).
export function updateIdentity(identity, token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  }
  if (identity) {
    if (identity.nama_lengkap || identity.username) {
      localStorage.setItem(NAMA_KEY, identity.nama_lengkap || identity.username)
    }
    if (identity.role) {
      localStorage.setItem(ROLE_KEY, identity.role)
    }
    if (identity.role_label) {
      localStorage.setItem(ROLE_LABEL_KEY, identity.role_label)
    }
    if (identity.is_super != null) {
      localStorage.setItem(SUPER_KEY, identity.is_super ? '1' : '0')
    }
  }
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(ROLE_KEY)
  localStorage.removeItem(NAMA_KEY)
  localStorage.removeItem(ROLE_LABEL_KEY)
  localStorage.removeItem(SUPER_KEY)
}

export function getUsername() {
  return localStorage.getItem(USER_KEY) || ''
}

export function getNamaLengkap() {
  return localStorage.getItem(NAMA_KEY) || localStorage.getItem(USER_KEY) || ''
}

export function getRole() {
  return localStorage.getItem(ROLE_KEY) || 'admin'
}

export function getRoleLabel() {
  return localStorage.getItem(ROLE_LABEL_KEY) || getRole()
}
