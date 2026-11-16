// SMTP email (daily reports + user-approved outreach emails only).
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { getSecret } from '../secrets.js';
import { IntegrationMissingError } from './errors.js';

export function mailConfigured() {
  return Boolean(config.smtp.host && config.smtp.from && (config.smtp.user ? getSecret('SMTP_PASS') : true));
}

export async function sendMail({ to, subject, text, html, replyTo }) {
  if (!mailConfigured()) {
    throw new IntegrationMissingError('Email (SMTP)', 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM and SMTP_PASS (e.g. a Google Workspace app password).');
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: getSecret('SMTP_PASS') } : undefined,
  });
  const info = await transport.sendMail({ from: config.smtp.from, to, subject, text, html, replyTo });
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}
