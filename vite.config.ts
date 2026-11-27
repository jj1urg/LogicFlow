import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
  lint: {
    options: {
      typeAware: true,
    },
  },
  fmt: {
    singleQuote: true,
    semi: true,
    printWidth: 100,
    ignorePatterns: ['docs/main.md', 'docs/memo.md', 'docs/test_hdl'],
  },
});
