import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, loadEnvFile } from './lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main() {
  let fileEnv = {};
  try {
    fileEnv = loadEnvFile(await readFile(path.join(repoRoot, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const env = { ...fileEnv, ...process.env };
  const destinationDir = path.resolve(repoRoot, env.BACKUP_DIR || 'backups');
  const result = await createBackup({ env, destinationDir });
  process.stdout.write(
    `Backup written: ${result.dumpPath}\nSHA-256: ${result.sha256}\nChecksum: ${result.checksumPath}\n`,
  );
  if (!result.permissionsRestricted) {
    process.stderr.write(
      'Backup file permissions could not be restricted on this platform. Limit access to the backup directory yourself.\n',
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
