import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export * from './generated/prisma/client';

export interface CreatePrismaClientOptions {
  connectionString: string;
  maxConnections?: number;
  logQueries?: boolean;
}

export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });
  return new PrismaClient({
    adapter,
    log: options.logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}
