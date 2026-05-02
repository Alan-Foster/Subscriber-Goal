import { defineConfig } from 'vitest/config';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { devvit } from '@devvit/start/vite';

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwind(), ...(command === 'build' ? [devvit()] : [])],
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
}));
