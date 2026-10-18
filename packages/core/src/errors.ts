export enum ErrorCode {
  CONNECTION_FAILED = "CONNECTION_FAILED",
  CONNECTION_TIMEOUT = "CONNECTION_TIMEOUT",
  CONNECTION_REFUSED = "CONNECTION_REFUSED",
  AUTH_FAILED = "AUTH_FAILED",
  AUTH_INVALID_CREDENTIALS = "AUTH_INVALID_CREDENTIALS",
  VALIDATION_FAILED = "VALIDATION_FAILED",
  INVALID_INPUT = "INVALID_INPUT",
  CONFIG_INVALID = "CONFIG_INVALID",
  CONFIG_MISSING = "CONFIG_MISSING",
  CONTACT_NOT_FOUND = "CONTACT_NOT_FOUND",
  ADDRESSBOOK_NOT_FOUND = "ADDRESSBOOK_NOT_FOUND",
  CONTACT_CONFLICT = "CONTACT_CONFLICT",
  EMAIL_NOT_FOUND = "EMAIL_NOT_FOUND",
  FOLDER_NOT_FOUND = "FOLDER_NOT_FOUND",
  SEND_FAILED = "SEND_FAILED",
  ATTACHMENT_NOT_FOUND = "ATTACHMENT_NOT_FOUND",
  CALENDAR_NOT_FOUND = "CALENDAR_NOT_FOUND",
  EVENT_NOT_FOUND = "EVENT_NOT_FOUND",
  INVALID_ICS = "INVALID_ICS",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  OPERATION_FAILED = "OPERATION_FAILED",
  WRITE_FAILED = "WRITE_FAILED",
}

export abstract class PimError extends Error {
  public readonly code: ErrorCode;
  public readonly isRetryable: boolean;
  public readonly timestamp: Date;

  constructor(message: string, code: ErrorCode, isRetryable = false) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.isRetryable = isRetryable;
    this.timestamp = new Date();
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      isRetryable: this.isRetryable,
      timestamp: this.timestamp,
    };
  }
}

export class ConnectionError extends PimError {
  constructor(message: string, code: ErrorCode = ErrorCode.CONNECTION_FAILED) {
    super(message, code, true);
  }
}

export class AuthenticationError extends PimError {
  constructor(message: string, code: ErrorCode = ErrorCode.AUTH_FAILED) {
    super(message, code, false);
  }
}

export class ValidationError extends PimError {
  public readonly field?: string;
  constructor(message: string, field?: string) {
    super(message, ErrorCode.VALIDATION_FAILED, false);
    this.field = field;
  }
}

export class ConfigurationError extends PimError {
  public readonly configKey?: string;
  constructor(message: string, configKey?: string) {
    super(message, ErrorCode.CONFIG_INVALID, false);
    this.configKey = configKey;
  }
}

export class ContactError extends PimError {
  public readonly contactId?: string;
  constructor(message: string, code: ErrorCode, contactId?: string) {
    super(message, code, false);
    this.contactId = contactId;
  }
}

export class EmailError extends PimError {
  public readonly emailUid?: number;
  constructor(message: string, code: ErrorCode, emailUid?: number) {
    super(message, code, false);
    this.emailUid = emailUid;
  }
}

export class CalendarError extends PimError {
  public readonly eventUid?: string;
  constructor(message: string, code: ErrorCode, eventUid?: string) {
    super(message, code, false);
    this.eventUid = eventUid;
  }
}

/** Whether retrying could help, by the same classification toPimError applies. */
export function isRetryableError(error: Error): boolean {
  return toPimError(error).isRetryable;
}

/** Socket-level error codes that mean "could not reach the server". */
const UNREACHABLE_CODES = new Set([
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  // nodemailer replaces the socket's code with its own category.
  "ECONNECTION",
  "ESOCKET",
  "EDNS",
  // imapflow's own codes for a dropped or never-opened connection.
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectTLS",
  "ClosedAfterConnectText",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  // imapflow
  "ETIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);
/** nodemailer: the server rejected the credentials. */
const AUTH_CODES = new Set(["EAUTH"]);
/** nodemailer: the server answered and refused the envelope or the message. */
const SEND_CODES = new Set(["EENVELOPE", "EMESSAGE", "EPROTOCOL"]);
/** imapflow: Microsoft 365 asked us to back off. */
const THROTTLE_CODES = new Set(["ETHROTTLE"]);
const KNOWN_CODES = [UNREACHABLE_CODES, TIMEOUT_CODES, AUTH_CODES, SEND_CODES, THROTTLE_CODES];

/** IMAP response codes (RFC 5530) that mean the credentials were refused. */
const IMAP_AUTH_RESPONSE_CODES = new Set([
  "AUTHENTICATIONFAILED",
  "AUTHORIZATIONFAILED",
  "EXPIRED",
]);
/** IMAP response codes for a temporary refusal. */
const IMAP_TEMPORARY_RESPONSE_CODES = new Set(["UNAVAILABLE", "INUSE"]);

/**
 * tsdav's HTTP failures, by their fixed prefix: `Collection query failed: 500
 * Internal Server Error. Raw response: <server body>`. Only the prefix is
 * read, so the server's body (which tsdav includes) cannot steer the class.
 */
const TSDAV_STATUS =
  /^(?:Collection (?:query|sync|status check) failed|(?:Calendar|Address book) discovery failed|(?:VCard|Calendar object) fetch failed): (?:\w+ returned )?(\d{3})\b/;

interface StructuredFields {
  code?: unknown;
  authenticationFailed?: unknown;
  responseStatus?: unknown;
  responseText?: unknown;
  serverResponseCode?: unknown;
  responseCode?: unknown;
}

/** The error and its `cause` chain, bounded. */
function causeChain(error: Error): Array<Error & StructuredFields> {
  const chain: Array<Error & StructuredFields> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    chain.push(current as Error & StructuredFields);
    current = current.cause;
  }
  return chain;
}

/**
 * The code that best explains an error, from the error itself and down its
 * `cause` chain: the first one the tables above recognise, else the first one
 * present. imapflow and nodemailer set `code` on the error they throw;
 * undici's "fetch failed" only on its cause.
 */
function errorCode(chain: StructuredFields[]): string | undefined {
  let first: string | undefined;
  for (const link of chain) {
    const code = link.code;
    if (typeof code === "string") {
      if (KNOWN_CODES.some((table) => table.has(code))) return code;
      first ??= code;
    }
  }
  return first;
}

/** A classified error that is not one of the named subclasses. */
class ClassifiedError extends PimError {
  constructor(message: string, code: ErrorCode, retryable: boolean, stack?: string) {
    super(message, code, retryable);
    if (stack) this.stack = stack;
  }
}

/**
 * Classifies any thrown value as a {@link PimError}.
 *
 * Structured fields decide first: error codes down the `cause` chain
 * (undici, nodemailer, imapflow), imapflow's `authenticationFailed` and IMAP
 * response, the HTTP status in tsdav's fixed message prefix. Only then is
 * text read, and only the library's own words: never a server body, and with
 * patterns narrow enough that a caller's text ("Login page redesign", a
 * folder named "Connection notes") does not match.
 */
export function toPimError(error: Error): PimError {
  if (error instanceof PimError) return error;
  const chain = causeChain(error);
  const code = errorCode(chain);
  const stack = error.stack;

  // imapflow reports every refused command as "Command failed" and keeps the
  // server's reason in `responseText`; bring it into the message.
  const imap = chain.find((l) => l.responseStatus === "NO" || l.responseStatus === "BAD");
  const serverText = typeof imap?.responseText === "string" ? imap.responseText : undefined;
  let message = error.message;
  if (serverText && !message.includes(serverText)) message = `${message}: ${serverText}`;
  // Name the code whenever there is one and the message does not already,
  // including codes outside the tables (a TLS failure such as
  // DEPTH_ZERO_SELF_SIGNED_CERT).
  if (code && !message.includes(code)) message = `${message} (${code})`;

  const response =
    typeof imap?.serverResponseCode === "string" ? imap.serverResponseCode.toUpperCase() : "";

  // Connection codes first: imapflow sets `authenticationFailed` on any error
  // during LOGIN, including a socket that closed or timed out mid-command.
  if (code && UNREACHABLE_CODES.has(code)) return new ConnectionError(message);
  if (code && TIMEOUT_CODES.has(code)) {
    return new ConnectionError(message, ErrorCode.CONNECTION_TIMEOUT);
  }
  if (chain.some((l) => l.authenticationFailed === true)) {
    // Dovecot answers `NO [UNAVAILABLE] Temporary authentication failure`
    // when its auth backend is down: the credentials were never judged.
    if (IMAP_TEMPORARY_RESPONSE_CODES.has(response)) {
      return new ClassifiedError(message, ErrorCode.OPERATION_FAILED, true, stack);
    }
    return new AuthenticationError(message);
  }
  if (code && AUTH_CODES.has(code)) return new AuthenticationError(message);
  if (code && SEND_CODES.has(code)) {
    // An SMTP 4xx is a temporary refusal; 5xx is final, and retrying a
    // rejected message only sends it at the same wall again.
    const reply = chain.map((l) => l.responseCode).find((c) => typeof c === "number") as
      | number
      | undefined;
    const temporary = reply !== undefined && reply >= 400 && reply < 500;
    return new ClassifiedError(message, ErrorCode.SEND_FAILED, temporary, stack);
  }
  if (code && THROTTLE_CODES.has(code)) {
    return new ClassifiedError(message, ErrorCode.OPERATION_FAILED, true, stack);
  }

  if (imap) {
    if (IMAP_AUTH_RESPONSE_CODES.has(response)) return new AuthenticationError(message);
    // The server answered: neither unreachable nor our fault.
    return new ClassifiedError(
      message,
      ErrorCode.OPERATION_FAILED,
      IMAP_TEMPORARY_RESPONSE_CODES.has(response),
      stack,
    );
  }

  const status = TSDAV_STATUS.exec(error.message)?.[1];
  if (status) {
    const n = Number(status);
    if (n === 401) return new AuthenticationError(message);
    if (n === 408 || n === 504) return new ConnectionError(message, ErrorCode.CONNECTION_TIMEOUT);
    if (n === 502 || n === 503) return new ConnectionError(message);
    // 429 asks us to come back later; every other status is the server's answer.
    return new ClassifiedError(message, ErrorCode.OPERATION_FAILED, n === 429, stack);
  }

  if (error.name === "TimeoutError") {
    return new ConnectionError(message, ErrorCode.CONNECTION_TIMEOUT);
  }
  // Last, the library's own words. tsdav appends the server's body after
  // ". Raw response:", which is cut off before matching.
  const own = error.message.split(/\. Raw response:/)[0];
  if (
    /\b(?:authentication failed|invalid credentials|unauthorized)\b/i.test(own) ||
    /^oauth credentials missing/i.test(own)
  ) {
    return new AuthenticationError(message);
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/.test(own)) {
    return new ConnectionError(message);
  }
  if (/\bETIMEDOUT\b/.test(own)) {
    return new ConnectionError(message, ErrorCode.CONNECTION_TIMEOUT);
  }
  return new ClassifiedError(message, ErrorCode.INTERNAL_ERROR, false, stack);
}
