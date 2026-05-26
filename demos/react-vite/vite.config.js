import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
var demoDir = path.dirname(fileURLToPath(import.meta.url));
var libraryRoot = path.resolve(demoDir, '../..');
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@coveragemap/speed-test': path.join(libraryRoot, 'src/index.ts'),
        },
    },
    server: {
        fs: {
            allow: [demoDir, libraryRoot],
        },
    },
    optimizeDeps: {
        exclude: ['@coveragemap/speed-test'],
    },
});
