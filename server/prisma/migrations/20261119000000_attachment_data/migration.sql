-- Uploaded files are stored in the database so the app runs on hosts without a persistent disk (e.g. Vercel).
ALTER TABLE "Attachment" ADD COLUMN "data" BYTEA;
