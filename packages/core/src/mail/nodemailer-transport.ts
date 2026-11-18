// SPDX-License-Identifier: AGPL-3.0-or-later
import { createTransport } from "nodemailer";
import type {
  MailDelivery,
  MailMessage,
  MailTransport,
  SmtpConnection,
} from "./mailer";

/**
 * Real SMTP delivery through nodemailer. Errors are thrown unchanged so the
 * mailer can classify them by the SMTP phase nodemailer reports; nothing here
 * logs the connection, the credentials or the message body.
 */
export function nodemailerTransport(): MailTransport {
  return {
    deliver(settings: SmtpConnection, message: MailMessage): Promise<MailDelivery> {
      const transport = createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.secure,
        auth: { user: settings.username, pass: settings.password },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        logger: false,
        debug: false,
      });
      return new Promise<MailDelivery>((resolve, reject) => {
        transport.sendMail(
          {
            from: { name: settings.fromName, address: settings.fromAddress },
            to: message.to,
            subject: message.subject,
            text: message.text,
          },
          (error, info) => {
            transport.close();
            if (error) {
              reject(error);
              return;
            }
            resolve({
              delivered: true,
              recipient: message.to,
              messageId: info.messageId,
              deliveredAt: new Date().toISOString(),
            });
          },
        );
      });
    },
  };
}
