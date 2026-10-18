import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CalendarError,
  ConfigurationError,
  ConnectionError,
  ContactError,
  ErrorCode,
  type PimError,
  ValidationError,
  isRetryableError,
  toPimError,
} from "../errors.js";

describe("PimError hierarchy", () => {
  it("ConnectionError is retryable by default", () => {
    const err = new ConnectionError("connection lost");
    expect(err.code).toBe(ErrorCode.CONNECTION_FAILED);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toBe("connection lost");
    expect(err).toBeInstanceOf(Error);
  });

  it("AuthenticationError is not retryable by default", () => {
    const err = new AuthenticationError("bad credentials");
    expect(err.code).toBe(ErrorCode.AUTH_FAILED);
    expect(err.isRetryable).toBe(false);
  });

  it("ValidationError is not retryable", () => {
    const err = new ValidationError("bad input", "email");
    expect(err.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(err.isRetryable).toBe(false);
    expect(err.field).toBe("email");
  });

  it("ConfigurationError is not retryable", () => {
    const err = new ConfigurationError("missing CARDDAV_URL", "CARDDAV_URL");
    expect(err.code).toBe(ErrorCode.CONFIG_INVALID);
    expect(err.isRetryable).toBe(false);
    expect(err.configKey).toBe("CARDDAV_URL");
  });

  it("ContactError stores contactId", () => {
    const err = new ContactError("not found", ErrorCode.CONTACT_NOT_FOUND, "abc-123");
    expect(err.code).toBe(ErrorCode.CONTACT_NOT_FOUND);
    expect(err.contactId).toBe("abc-123");
    expect(err.isRetryable).toBe(false);
  });

  it("toJSON serializes error correctly", () => {
    const err = new ConnectionError("timeout", ErrorCode.CONNECTION_TIMEOUT);
    const json = err.toJSON();
    expect(json.name).toBe("ConnectionError");
    expect(json.code).toBe(ErrorCode.CONNECTION_TIMEOUT);
    expect(json.isRetryable).toBe(true);
    expect(json.message).toBe("timeout");
  });

  it("isRetryableError works with PimError and plain Error", () => {
    expect(isRetryableError(new ConnectionError("fail"))).toBe(true);
    expect(isRetryableError(new AuthenticationError("fail"))).toBe(false);
    expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableError(new Error("something else"))).toBe(false);
  });

  it("creates CalendarError with event UID", () => {
    const error = new CalendarError("Event not found", ErrorCode.EVENT_NOT_FOUND, "evt-123");
    expect(error.message).toBe("Event not found");
    expect(error.code).toBe(ErrorCode.EVENT_NOT_FOUND);
    expect(error.eventUid).toBe("evt-123");
    expect(error.isRetryable).toBe(false);
  });

  it("toPimError wraps plain errors intelligently", () => {
    const authErr = toPimError(new Error("authentication failed"));
    expect(authErr.code).toBe(ErrorCode.AUTH_FAILED);

    const connErr = toPimError(new Error("ECONNREFUSED"));
    expect(connErr.code).toBe(ErrorCode.CONNECTION_FAILED);

    const genericErr = toPimError(new Error("something broke"));
    expect(genericErr.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  describe("Node fetch's 'fetch failed', whose reason is only in cause", () => {
    const fetchFailed = (code: string) =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error(`connect ${code} 192.0.2.1:443`), { code }),
      });

    it.each([
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
    ])("classifies %s as a retryable connection failure and names it", (code) => {
      const err = toPimError(fetchFailed(code));
      expect(err.code).toBe(ErrorCode.CONNECTION_FAILED);
      expect(err.isRetryable).toBe(true);
      expect(err.message).toBe(`fetch failed (${code})`);
    });

    it("classifies a socket timeout as CONNECTION_TIMEOUT", () => {
      const err = toPimError(fetchFailed("UND_ERR_CONNECT_TIMEOUT"));
      expect(err.code).toBe(ErrorCode.CONNECTION_TIMEOUT);
      expect(err.message).toBe("fetch failed (UND_ERR_CONNECT_TIMEOUT)");
    });

    it("finds the code on a nested cause", () => {
      const inner = Object.assign(new Error("x"), { code: "ECONNREFUSED" });
      const err = toPimError(
        Object.assign(new TypeError("fetch failed"), {
          cause: new Error("outer", { cause: inner }),
        }),
      );
      expect(err.code).toBe(ErrorCode.CONNECTION_FAILED);
      expect(err.message).toBe("fetch failed (ECONNREFUSED)");
    });

    it("leaves a fetch failure with no recognisable cause as an internal error", () => {
      const err = toPimError(new TypeError("fetch failed"));
      expect(err.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(err.message).toBe("fetch failed");
    });

    it("reads a code set on the error itself, as imapflow and nodemailer throw it", () => {
      const err = toPimError(
        Object.assign(new Error("connect EHOSTUNREACH 192.0.2.1:993"), { code: "EHOSTUNREACH" }),
      );
      expect(err.code).toBe(ErrorCode.CONNECTION_FAILED);
      expect(err.isRetryable).toBe(true);
      // The code is already in the message, so it is not repeated.
      expect(err.message).toBe("connect EHOSTUNREACH 192.0.2.1:993");
    });

    it("names a code outside the tables without changing the classification", () => {
      const err = toPimError(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("self-signed certificate"), {
            code: "DEPTH_ZERO_SELF_SIGNED_CERT",
          }),
        }),
      );
      expect(err.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(err.message).toBe("fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)");
    });
  });
});
