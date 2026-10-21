import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
  // Port frontend dikunci: 5173. Backend selalu 5000.
  // strictPort: kalau 5173 sedang dipakai, Vite berhenti dengan error (tidak pindah diam-diam ke 5174, 5175, ...).
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
  },
})
