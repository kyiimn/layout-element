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
      entry: path.resolve(__dirname, 'src/engine/index.ts'),
      fileName: (_format, _entryName) => 'layout-element-engine.mjs',
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
  },
  plugins: [
    dts({
      insertTypesEntry: false,
      include: ['src/engine/**/*.ts'],
      exclude: ['src/components/**', 'src/edit/**', 'src/resource/**', 'src/react/**', 'src/examples/**'],
    }),
  ],
});