// Email Service — currently simulates sending
// To enable real email: set SMTP credentials in .env and uncomment nodemailer config

async function sendSessionNotesEmail({ sessionNumber, groupName, supervisorName, notes, sessionDate }) {
  const to = process.env.NOTIFICATION_EMAIL || 'notes@ritzoini.com';

  const subject = `[Ritzoini] Session ${sessionNumber} Notes — ${groupName}`;
  const body = `
Session Notes Submitted
=======================
Group:      ${groupName}
Session:    #${sessionNumber}
Date:       ${sessionDate}
Supervisor: ${supervisorName}

Notes:
------
${notes}

---
Submitted via Ritzoini Platform
  `.trim();

  // SIMULATED — logs to console instead of sending
  console.log('\n📧 EMAIL SIMULATED:');
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(`Body:\n${body}\n`);

  // To enable real sending, install nodemailer and uncomment:
  /*
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({ from: process.env.SMTP_USER, to, subject, text: body });
  */

  return { simulated: true, to, subject };
}

module.exports = { sendSessionNotesEmail };
