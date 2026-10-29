import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const daemon = process.env.FARSHELF_DEV_DAEMON ?? 'http://127.0.0.1:7420';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: daemon, changeOrigin: false },
      '/stream': { target: daemon, changeOrigin: false },
      '/login': { target: daemon, changeOrigin: false },
    },
  },
});
