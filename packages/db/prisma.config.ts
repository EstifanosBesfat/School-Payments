import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ path: path.resolve(process.cwd(), '../../.env') });
config();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
  },
});
