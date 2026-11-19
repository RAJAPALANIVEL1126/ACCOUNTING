/**
 * Deployment preparation, run once per deploy before the new version serves traffic
 * (on Vercel it is part of the build command):
 *   1. apply pending database migrations;
 *   2. make sure the roles and permissions exist.
 * Creates no users, companies or financial records.
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import path from 'path';
import { databaseUrl, prisma } from '../db';
import { ensureReferenceData } from '../services/reference';

async function main() {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL is not set. Add it to the project environment variables before deploying.');
  console.log('Applying database migrations…');
  execSync('npx prisma migrate deploy', { cwd: path.resolve(__dirname, '../..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  console.log('Ensuring roles and permissions…');
  await ensureReferenceData();
  console.log('Database ready.');
}

main()
  .catch((e) => {
    console.error('\nDeployment preparation failed: ' + e.message + '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
