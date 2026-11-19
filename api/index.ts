/**
 * Vercel serverless entry point. vercel.json rewrites every /api/* request to this function, and the
 * Express app routes it by its original path. Migrations and reference data are applied at build time
 * (server/src/scripts/prepare-deploy.ts); the web client is served as static files from client/dist.
 */
import { createApp } from '../server/src/app';

const app = createApp();

export default app;
