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

export function isRetryableError(error: Error): boolean {
  if (error instanceof PimError) {
    return error.isRetryable;
  }
  const msg = error.message;
  return msg.includes("ECONNRESET") || msg.includes("ENOTFOUND") || msg.includes("ETIMEDOUT");
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
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** The first `code` found walking an error's `cause` chain (bounded). */
function causeCode(error: Error): string | undefined {
  let current: unknown = error.cause;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = current.cause;
  }
  return undefined;
}

export function toPimError(error: Error): PimError {
  if (error instanceof PimError) return error;
  // Node's fetch (undici, under tsdav) reports every network failure as a bare
  // "fetch failed" and puts the reason in `cause`. Without this an
  // unreachable host surfaced as a non-retryable internal error with no hint why.
  const code = causeCode(error);
  if (code && UNREACHABLE_CODES.has(code)) {
    return new ConnectionError(`${error.message} (${code})`);
  }
  if (code && TIMEOUT_CODES.has(code)) {
    return new ConnectionError(`${error.message} (${code})`, ErrorCode.CONNECTION_TIMEOUT);
  }
  const msg = error.message.toLowerCase();
  if (msg.includes("auth") || msg.includes("login") || msg.includes("credential")) {
    return new AuthenticationError(error.message);
  }
  if (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("connection")
  ) {
    return new ConnectionError(error.message);
  }
  if (msg.includes("timeout") || msg.includes("etimedout")) {
    return new ConnectionError(error.message, ErrorCode.CONNECTION_TIMEOUT);
  }
  const wrapped = new (class InternalError extends PimError {
    constructor() {
      super(error.message, ErrorCode.INTERNAL_ERROR, false);
      this.stack = error.stack;
    }
  })();
  return wrapped;
}
