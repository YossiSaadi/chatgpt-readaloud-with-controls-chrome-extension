import { defineConfig } from 'vite';
import copy from 'rollup-plugin-copy';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: 'src/index.ts',
        background: 'src/background.ts',
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
    outDir: 'dist',
  },
  plugins: [
    copy({
      targets: [
        { src: 'manifest.json', dest: 'dist' },
        { src: 'public/icons', dest: 'dist' },
        { src: 'README.md', dest: 'dist' },
        { src: 'privacy.md', dest: 'dist' },
      ],
      hook: 'writeBundle',
    }),
  ],
});
