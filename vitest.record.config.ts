import { defineConfig } from 'vitest/config';

// scripts/record-fixtures.spec.ts only (it needs APP_DIR); `npm test` never runs it
export default defineConfig({ test: { include: ['scripts/record-fixtures.spec.ts'], environment: 'node' } });
