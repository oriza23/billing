import { getPageWindow } from './pagination.js'

// Footer tabel untuk server-side pagination: info "Showing X to Y of N entries"
// di kiri, kontrol Previous / nomor halaman / Next di kanan bawah.
function ServerPagination({ page, totalPages, totalData, limit, onPageChange, label = 'Navigasi halaman', disabled = false }) {
  const firstIndex = (page - 1) * limit
  const showingStart = totalData === 0 ? 0 : firstIndex + 1
  const showingEnd = Math.min(firstIndex + limit, totalData)

  return (
    <div className="stok-foot">
      <p className="stok-info">
        Showing {showingStart.toLocaleString('id-ID')} to {showingEnd.toLocaleString('id-ID')} of {totalData.toLocaleString('id-ID')} entries
      </p>
      <nav className="stok-pages" aria-label={label}>
        <button
          type="button"
          className="stok-nav"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        {getPageWindow(page, totalPages).map((item) => (
          typeof item === 'number' ? (
            <button
              key={item}
              type="button"
              className={item === page ? 'stok-page is-active' : 'stok-page'}
              aria-current={item === page ? 'page' : undefined}
              disabled={disabled}
              onClick={() => onPageChange(item)}
            >
              {item}
            </button>
          ) : (
            <span key={item} className="stok-gap" aria-hidden="true">…</span>
          )
        ))}
        <button
          type="button"
          className="stok-nav"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </nav>
    </div>
  )
}

export default ServerPagination
