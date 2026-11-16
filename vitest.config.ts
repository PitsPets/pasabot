import { defineConfig } from 'vitest/config';

// `source` makes workspace packages resolve to their TypeScript sources, so tests never need a build first.
const conditions = ['source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['source'] } },
  test: {
    include: ['{apps,packages,providers,channels,modules,plugins}/*/{src,web}/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
