import { useState } from 'react'
import axios from 'axios'
import { useNavigate } from 'react-router-dom'
import './Login.css'

function Login() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setLoading(true)

    try {
      const response = await axios.post('http://192.168.69.70:5000/api/login', {
        username,
        password,
      })

      if (response.data.success) {
        localStorage.setItem('admin_user', username)
        navigate('/dashboard')
      } else {
        alert('Username atau Password salah!')
      }
    } catch {
      alert('Username atau Password salah!')
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

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span>Username</span>
            <input
              type="text"
              name="username"
              autoComplete="username"
              placeholder="Masukkan username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="Masukkan password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
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
