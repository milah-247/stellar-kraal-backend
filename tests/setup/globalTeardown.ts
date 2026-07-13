/**
 * tests/setup/globalTeardown.ts
 *
 * Runs once after all test suites complete.
 * Cleans up the test SQLite database file.
 */

import fs from 'fs';
import path from 'path';

export default async function globalTeardown(): Promise<void> {
  const dbPath = path.resolve(__dirname, '../../test.db');
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;

  for (const filePath of [dbPath, walPath, shmPath]) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Non-fatal — test DB cleanup best-effort
    }
  }
}
