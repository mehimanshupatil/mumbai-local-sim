import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// served at https://mehimanshupatil.github.io/mumbai-local-sim/
export default defineConfig({
  base: '/mumbai-local-sim/',
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
