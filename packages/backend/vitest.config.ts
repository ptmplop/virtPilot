import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // Source is compiled as CommonJS but written with ESM-style specifiers
      // (`./validate.js`), which is what `tsc` wants. Vite resolves those
      // literally and would look for a .js file that does not exist, so strip
      // the extension and let it find the .ts.
      { find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // config.ts refuses to boot without a JWT secret unless it can tell it is
    // running under test, where it mints an ephemeral one. secretsCrypto reads
    // process.env directly, so it needs a real value to derive a key from.
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
    },
  },
});
