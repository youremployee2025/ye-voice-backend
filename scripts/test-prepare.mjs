// Applies migrations to the local test database only.
// Mirrors the guard in test/setup.ts: this must never reach production.
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config();

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  console.error('TEST_DATABASE_URL is not set. See README for the local test Postgres setup.');
  process.exit(1);
}

if (url.includes('neon.tech')) {
  console.error('TEST_DATABASE_URL points at a Neon host — that is production. Refusing to migrate.');
  process.exit(1);
}

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});

process.exit(result.status ?? 1);
