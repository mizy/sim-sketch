import { defineConfig } from 'vitest/config';

// GitHub Pages 子路径部署：所有资源用相对路径。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022'
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
