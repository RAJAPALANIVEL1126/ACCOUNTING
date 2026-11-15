import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL must be set to run the test-suite (it is wiped on every run).');
if (testUrl === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must not point at the same database as DATABASE_URL.');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // All files share one database, so they run one after another.
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
      APP_URL: 'http://localhost:5173',
      UPLOAD_DIR: './uploads-test',
      // Dummy gateway credentials so webhook signature handling can be exercised. No network calls are made.
      RAZORPAY_KEY_ID: 'rzp_test_unit',
      RAZORPAY_KEY_SECRET: 'unit-test-key-secret',
      RAZORPAY_WEBHOOK_SECRET: 'unit-test-webhook-secret',
    },
  },
});
