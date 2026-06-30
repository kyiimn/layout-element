import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'LayoutElement',
      fileName: 'layout-element',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        globals: {},
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  plugins: [
    dts({
      insertTypesEntry: true,
      rollupTypes: true,
    }),
  ],
  server: {
    open: '/examples/index.html',
  },
});