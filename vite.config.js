import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages (served from /<repo-name>/)
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1000 }, // three.js alone is ~500 kB
});
