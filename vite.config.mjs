import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    {
      name: 'copy-environment-assets',
      apply: 'build',
      async closeBundle() {
        const outputAssets = resolve(process.cwd(), 'dist', 'Assets');
        await mkdir(resolve(process.cwd(), 'dist'), { recursive: true });
        await cp(resolve(process.cwd(), 'Assets'), outputAssets, {
          recursive: true,
          force: true,
        });
      },
    },
  ],
});
