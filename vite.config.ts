import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { devvit } from '@devvit/start/vite';

export default defineConfig({
  plugins: [react(), tailwind(), devvit()],
});
