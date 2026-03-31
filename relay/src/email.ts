import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.FROM_EMAIL || "noreply@peer67.com";

export async function sendMagicLink(
  to: string,
  verifyUrl: string
): Promise<void> {
  if (!resend) {
    console.log(`[email-disabled] Magic link for ${to}: ${verifyUrl}`);
    return;
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: "Verify your Peer67 identity",
    text: [
      "Click the link below to verify your Peer67 identity:",
      "",
      verifyUrl,
      "",
      "This link expires in 10 minutes.",
      "",
      "If you didn't request this, ignore this email.",
    ].join("\n"),
  });
}

export async function sendInviteEmail(
  to: string,
  fromHandle: string
): Promise<void> {
  if (!resend) {
    console.log(`[email-disabled] Invite to ${to} from ${fromHandle}`);
    return;
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: `${fromHandle} wants to message you on Peer67`,
    text: [
      `${fromHandle} invited you to Peer67 — encrypted ephemeral messaging.`,
      "",
      "To get started:",
      "  npm install -g @peer67/mcp",
      "  peer67 setup",
      "",
      "Messages are end-to-end encrypted and auto-delete after 24 hours.",
      "",
      "https://peer67.com",
    ].join("\n"),
  });
}

export function isEmailConfigured(): boolean {
  return resend !== null;
}
