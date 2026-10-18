import { EmailError, ErrorCode, PimError, toPimError } from "@miguelarios/pim-core";

/**
 * The fields imapflow puts on a failed command. Every tagged `NO`/`BAD` is
 * thrown as `Error("Command failed")` with the server's words only in
 * `responseText`, so classifying by `message` alone loses both the reason and
 * the condition.
 */
interface ImapFlowError {
  message?: string;
  code?: string;
  responseStatus?: string;
  responseText?: string;
  serverResponseCode?: string;
  mailboxMissing?: boolean;
  response?: unknown;
}

/**
 * Server texts for a missing mailbox, for servers that send no RFC 5530 code:
 * Dovecot and Cyrus ("Mailbox doesn't exist" / "does not exist"), Courier,
 * Gmail ("Unknown Mailbox"), Exchange ("Folder not found").
 */
const MISSING_MAILBOX_TEXT =
  /mailbox (?:doesn't|does not) exist|unknown mailbox|no such (?:mailbox|folder)|(?:mailbox|folder) not found|nonexistent/i;

/** The response code inside a raw imapflow response object, when not lifted onto the error. */
function rawResponseCode(response: unknown): string | undefined {
  const value = (response as { attributes?: Array<{ section?: Array<{ value?: unknown }> }> })
    ?.attributes?.[0]?.section?.[0]?.value;
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function serverText(e: ImapFlowError): string | undefined {
  if (e.responseText) return e.responseText;
  const nested = e.response as ImapFlowError | undefined;
  if (nested && typeof nested === "object" && nested.responseText) return nested.responseText;
  return undefined;
}

function isMissingMailbox(e: ImapFlowError): boolean {
  // STATUS on a missing folder (imapflow verifies with LIST first).
  if (e.code === "NotFound") return true;
  // getMailboxLock after a refused SELECT, also verified with LIST.
  if (e.mailboxMissing === true) return true;
  const code =
    e.serverResponseCode?.toUpperCase() ??
    rawResponseCode(e.response) ??
    rawResponseCode((e.response as ImapFlowError | undefined)?.response);
  if (code === "NONEXISTENT" || code === "TRYCREATE") return true;
  const text = serverText(e);
  return (
    !!text &&
    (e.responseStatus === "NO" || e.code === "NotFound") &&
    MISSING_MAILBOX_TEXT.test(text)
  );
}

/**
 * Classifies an error from an IMAP operation on `folder`.
 *
 * A missing mailbox gets `FOLDER_NOT_FOUND`, naming the folder; everything
 * else, including a wrong password and any other refusal, is pim-core's
 * `toPimError`, which reads imapflow's structured fields.
 */
export function toImapError(error: unknown, folder?: string): PimError {
  if (error instanceof PimError) return error;
  const e = (error ?? {}) as ImapFlowError;
  const text = serverText(e);

  if (isMissingMailbox(e)) {
    const named = folder ? `Folder not found: ${folder}` : "Folder not found";
    return new EmailError(
      `${named}${text ? ` (${text})` : ""}. Call list_folders for the exact path.`,
      ErrorCode.FOLDER_NOT_FOUND,
    );
  }
  return toPimError(error instanceof Error ? error : new Error(String(error)));
}
