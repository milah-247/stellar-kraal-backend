/**
 * tests/setup/globalSetup.ts
 *
 * Runs once before all test suites.
 * Pushes the Prisma schema to the test SQLite database (no migration files needed).
 */

import { execSync } from 'child_process';
import path from 'path';

export default async function globalSetup(): Promise<void> {
  const cwd = path.resolve(__dirname, '../../');
  const env = {
    ...process.env,
    DATABASE_URL: 'file:./test.db',
    NODE_ENV: 'test',
  };

  execSync('npx prisma db push --accept-data-loss --skip-generate', {
    cwd,
    env,
    stdio: 'pipe',
  });
}
