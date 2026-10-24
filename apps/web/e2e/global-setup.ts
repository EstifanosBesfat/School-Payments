import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export default function globalSetup(): void {
  const repo = path.resolve(__dirname, '../../..');
  const token = execFileSync('node', ['apps/api/scripts/playwright-pay-token.cjs'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  fs.writeFileSync(path.join(__dirname, 'pay-token.txt'), token);
}
