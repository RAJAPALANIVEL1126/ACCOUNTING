import nodemailer from 'nodemailer';
import { config } from '../config';
import { log } from './logger';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}
/** Captured mail — test environment only. */
export const outbox: Mail[] = [];

let transport: nodemailer.Transporter | null = null;
export const mailConfigured = () => Boolean(config.smtp.host);

export async function sendMail(mail: Mail): Promise<void> {
  if (config.isTest) {
    outbox.push(mail);
    return;
  }
  if (!mailConfigured()) {
    if (config.isProd) {
      // Never write tokens to production logs.
      log.warn('E-mail not sent: SMTP is not configured', { to: mail.to, subject: mail.subject });
    } else {
      console.log(
        `\n──── DEV MAIL (SMTP not configured) ────\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n────────────────────────────────────────\n`,
      );
    }
    return;
  }
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
  });
  try {
    await transport.sendMail({ from: config.smtp.from, ...mail });
  } catch (e) {
    log.error('Failed to send e-mail', { to: mail.to, subject: mail.subject, error: (e as Error).message });
  }
}
