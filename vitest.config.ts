import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { testTimeout: 90000, hookTimeout: 90000, fileParallelism: false } })
