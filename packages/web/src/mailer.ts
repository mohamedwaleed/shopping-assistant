import nodemailer from "nodemailer";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * The only way the application sends email. Verification links are credentials,
 * so a mailer never logs what it sends.
 */
export interface Mailer {
  send(message: OutgoingEmail): Promise<void>;
}

export function createSmtpMailer(smtpUrl: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await transport.sendMail(message);
    },
  };
}

/** Repeatable delivery for tests: the message is recorded, never sent. */
export function createRecordingMailer(): Mailer & { sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}
