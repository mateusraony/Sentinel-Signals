import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // docs/roadmap.md Bloco 5 (bundle >500kB) — recharts é usado na
        // rota padrão (Dashboard), então o code-splitting por rota em
        // App.jsx sozinho não tira ele do carregamento inicial. Isolar num
        // chunk próprio melhora reuso de cache entre deploys (recharts não
        // muda a cada release do app) sem mudar nenhum comportamento.
        manualChunks: {
          recharts: ['recharts'],
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
        },
      },
    },
  },
});
