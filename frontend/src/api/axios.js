import axios from 'axios'
import { clearSession, getToken } from './auth.js'

// Base URL API (sudah berakhiran "/api"; semua pemanggilan cukup menulis "/pppoe/...", "/isolir/:id", dst).
//  - Production (import.meta.env.PROD) -> relative "/api": satu origin dengan backend, bebas CORS & Mixed Content.
//  - Development                       -> http://<host halaman>:5000/api (backend di port 5000).
//  - VITE_API_URL (opsional) menimpa keduanya; isi origin saja (mis. http://localhost:5000), "/api" ditambahkan otomatis.
// Lihat frontend/.env.example.
const envUrl = import.meta.env.VITE_API_URL?.trim()
const origin = envUrl
  ? envUrl.replace(/\/+$/, '').replace(/\/api$/, '')
  : (import.meta.env.PROD ? '' : `${window.location.protocol}//${window.location.hostname}:5000`)
const baseURL = `${origin}/api`

const api = axios.create({ baseURL })

// Tempelkan token JWT otomatis ke setiap request.
api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Token ditolak backend (kedaluwarsa/tidak valid) -> bersihkan sesi dan kembali ke halaman login.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const isLoginRequest = error.config?.url?.includes('/auth/login')
    if (error.response?.status === 401 && !isLoginRequest) {
      clearSession()
      if (window.location.pathname !== '/') {
        window.location.assign('/?expired=1')
      }
    }
    return Promise.reject(error)
  },
)

export default api
