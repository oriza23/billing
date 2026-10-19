import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, Lock, User } from 'lucide-react'
import api from './api/axios.js'
import { hasValidToken, saveSession } from './api/auth.js'
import './Login.css'

function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const sessionExpired = searchParams.get('expired') === '1'

  if (hasValidToken()) {
    return <Navigate to="/dashboard" replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await api.post('/api/auth/login', {
        username: username.trim(),
        password,
      })

      if (response.data?.token) {
        saveSession(response.data)
        navigate('/dashboard', { replace: true })
      } else {
        setError('Login gagal, token tidak diterima.')
      }
    } catch (requestError) {
      if (requestError.response) {
        setError(requestError.response.data?.message || 'Username atau password salah')
      } else {
        setError('Tidak dapat terhubung ke server.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-glow login-glow-left" />
      <div className="login-glow login-glow-right" />

      <section className="login-card">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">
            B
          </span>
          <div>
            <p className="login-kicker">Sistem Billing</p>
            <h1>Masuk ke akun Anda</h1>
          </div>
        </div>

        <p className="login-lead">
          Kelola tagihan dan pelanggan dari satu tempat.
        </p>

        {sessionExpired && !error && (
          <p className="login-notice" role="status">Sesi Anda berakhir, silakan login kembali.</p>
        )}
        {error && <p className="login-error" role="alert">{error}</p>}

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span>Username</span>
            <div className="login-input">
              <User size={18} aria-hidden="true" />
              <input
                type="text"
                name="username"
                autoComplete="username"
                placeholder="Masukkan username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                autoFocus
              />
            </div>
          </label>

          <label className="login-field">
            <span>Password</span>
            <div className="login-input">
              <Lock size={18} aria-hidden="true" />
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                placeholder="Masukkan password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button
                type="button"
                className="login-toggle"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          <button className="login-button" type="submit" disabled={loading}>
            {loading ? 'Memeriksa...' : 'Login'}
          </button>
        </form>
      </section>
    </main>
  )
}

export default Login
