import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    restoreMocks: true,
    include: ['src/**/*.test.{js,jsx}']
  }
});
