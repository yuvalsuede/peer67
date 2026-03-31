const MAILBOX_ID_REGEX = /^[0-9a-f]{64}$/;

export function isValidMailboxId(id: string): boolean {
  return MAILBOX_ID_REGEX.test(id);
}

export function isValidBase64(str: string): boolean {
  try {
    return Buffer.from(str, "base64").length > 0;
  } catch {
    return false;
  }
}
