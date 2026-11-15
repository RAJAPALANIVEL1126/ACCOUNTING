import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '../db';
import { config } from '../config';
import { AppError, notFound } from '../lib/errors';
import { randomToken } from '../lib/tokens';
import { companyOf, h, requirePerm } from '../middleware/auth';

// Files are held in memory (size-capped), content-sniffed, and only then written under a random name.
export const uploadSingle = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } }).single('file');

const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', ext: '.png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: '.webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
];

/** The stored type comes from the file's magic bytes, never from the client-supplied name or MIME type. */
export function sniff(buffer: Buffer) {
  return SIGNATURES.find((s) => buffer.length > 12 && s.test(buffer)) ?? null;
}

export async function saveUpload(req: Request, purpose: string, allowed: string[]) {
  const file = req.file;
  if (!file) throw new AppError(400, 'UPLOAD_ERROR', 'No file was uploaded');
  const kind = sniff(file.buffer);
  if (!kind || !allowed.includes(kind.mime)) {
    throw new AppError(400, 'UPLOAD_ERROR', `Unsupported file type. Allowed: ${allowed.map((m) => m.split('/')[1].toUpperCase()).join(', ')}`);
  }
  const companyId = companyOf(req);
  const storedName = randomToken(18) + kind.ext;
  const dir = path.join(config.uploadDir, companyId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, storedName), file.buffer, { flag: 'wx' });
  const fileName = path.basename(file.originalname).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file' + kind.ext;
  return prisma.attachment.create({
    data: { companyId, purpose, fileName, storedName, mimeType: kind.mime, size: file.size, uploadedById: req.auth!.userId },
  });
}

export async function attachmentPath(companyId: string, id: string) {
  const att = await prisma.attachment.findFirst({ where: { id, companyId } });
  if (!att) throw notFound('Attachment');
  return { att, file: path.join(config.uploadDir, companyId, path.basename(att.storedName)) };
}

export async function sendAttachment(res: Response, companyId: string, id: string, inline = false) {
  const { att, file } = await attachmentPath(companyId, id);
  try {
    await fs.access(file);
  } catch {
    throw notFound('Attachment file');
  }
  res.setHeader('Content-Type', att.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Disposition', `${inline && att.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${att.fileName.replace(/"/g, '')}"`);
  res.sendFile(file);
}

export const attachmentsRouter = Router();

attachmentsRouter.post('/', requirePerm('transactions.create'), uploadSingle, h(async (req, res) => {
  const att = await saveUpload(req, 'transaction', ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
  res.status(201).json({ data: { id: att.id, fileName: att.fileName, mimeType: att.mimeType, size: att.size } });
}));

attachmentsRouter.get('/:id/file', requirePerm('transactions.view'), h(async (req, res) => {
  await sendAttachment(res, companyOf(req), req.params.id);
}));
