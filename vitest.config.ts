import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared')
    }
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['electron/**/*.test.ts', 'shared/**/*.test.ts']
  }
})
