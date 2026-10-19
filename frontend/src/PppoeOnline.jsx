import { useEffect, useState } from 'react'
import axios from 'axios'
import './PppoeOnline.css'

function formatLoginTime(value) {
  if (!value) {
    return '-'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleString('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function PppoeOnline() {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [disconnecting, setDisconnecting] = useState('')

  async function fetchOnline() {
    const response = await axios.get('http://192.168.69.70:5000/api/pppoe/online')
    setSessions(Array.isArray(response.data) ? response.data : [])
    setError('')
  }

  useEffect(() => {
    let ignore = false

    async function loadOnline() {
      try {
        const response = await axios.get('http://192.168.69.70:5000/api/pppoe/online')
        if (!ignore) {
          setSessions(Array.isArray(response.data) ? response.data : [])
          setError('')
        }
      } catch {
        if (!ignore) {
          setError('Gagal memuat data pelanggan online.')
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    loadOnline()

    return () => {
      ignore = true
    }
  }, [])

  function handleDisconnect(session) {
    const confirmed = window.confirm('Putus koneksi pelanggan ini?')
    if (!confirmed) {
      return
    }

    setDisconnecting(`${session.username}|${session.ip_address}`)
    setActionError('')

    axios
      .post('http://192.168.69.70:5000/api/pppoe/disconnect', {
        username: session.username,
        ip_address: session.ip_address,
      })
      .then(() => {
        setTimeout(() => {
          fetchOnline()
            .catch(() => {
              setError('Gagal memuat data pelanggan online.')
            })
            .finally(() => {
              setDisconnecting('')
            })
        }, 2000)
      })
      .catch(() => {
        setActionError('Gagal memutus koneksi pelanggan.')
        setDisconnecting('')
      })
  }

  return (
    <section className="monitoring">
      <header className="monitoring-header">
        <p>Sesi Aktif</p>
        <h1>Langganan Online</h1>
      </header>

      <div className="monitoring-card">
        {loading && <p className="monitoring-status">Memuat data sesi...</p>}
        {error && <p className="monitoring-status monitoring-error">{error}</p>}
        {actionError && <p className="monitoring-status monitoring-error">{actionError}</p>}

        {!loading && !error && sessions.length === 0 && (
          <p className="monitoring-status">Tidak ada pelanggan yang sedang online</p>
        )}

        {!loading && !error && sessions.length > 0 && (
          <div className="monitoring-table-wrap">
            <table className="monitoring-table">
              <thead>
                <tr>
                  <th>No</th>
                  <th>Username</th>
                  <th>IP Address</th>
                  <th>Waktu Login</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session, index) => (
                  <tr key={`${session.username}-${session.ip_address}-${index}`}>
                    <td>{index + 1}</td>
                    <td>{session.username}</td>
                    <td>{session.ip_address || '-'}</td>
                    <td>{formatLoginTime(session.login_time)}</td>
                    <td>
                      <button
                        type="button"
                        className="monitoring-disconnect"
                        onClick={() => handleDisconnect(session)}
                        disabled={disconnecting === `${session.username}|${session.ip_address}`}
                      >
                        {disconnecting === `${session.username}|${session.ip_address}` ? 'Memutus...' : 'Disconnect'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

export default PppoeOnline
