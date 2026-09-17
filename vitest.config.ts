import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A suite nao fala com a rede. O avaliador real (Jev) so entra por tools/calibrate.
    testTimeout: 20_000,
  },
});
