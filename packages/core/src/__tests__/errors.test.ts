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

describe("toPimError on the errors imapflow and nodemailer actually throw (#129 review)", () => {
  const coded = (message: string, code: string, cause?: Error) =>
    Object.assign(new Error(message, cause ? { cause } : undefined), { code });

  it("classifies nodemailer's ESOCKET / ECONNECTION / EDNS as retryable connection failures", () => {
    for (const code of ["ESOCKET", "ECONNECTION", "EDNS"]) {
      const err = toPimError(coded("connect EHOSTUNREACH 192.0.2.1:465", code));
      expect(err.code, code).toBe(ErrorCode.CONNECTION_FAILED);
      expect(err.isRetryable, code).toBe(true);
      expect(err.message, code).toBe(`connect EHOSTUNREACH 192.0.2.1:465 (${code})`);
    }
  });

  it("classifies imapflow's timeouts as CONNECTION_TIMEOUT and its closed connections as failures", () => {
    for (const code of ["ETIMEOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "UPGRADE_TIMEOUT"]) {
      expect(toPimError(coded("Timeout", code)).code, code).toBe(ErrorCode.CONNECTION_TIMEOUT);
    }
    for (const code of ["NoConnection", "EConnectionClosed"]) {
      expect(toPimError(coded("Socket is already closed", code)).code, code).toBe(
        ErrorCode.CONNECTION_FAILED,
      );
    }
  });

  it("prefers a recognised code deeper in the chain over an unrecognised one on top", () => {
    const err = toPimError(
      coded("upstream failed", "E_WRAPPER", coded("connect ECONNREFUSED", "ECONNREFUSED")),
    );
    expect(err.code).toBe(ErrorCode.CONNECTION_FAILED);
  });

  it("isRetryableError agrees with toPimError", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: coded("x", "EHOSTUNREACH"),
    });
    expect(isRetryableError(fetchFailed)).toBe(true);
    expect(isRetryableError(new Error("something broke"))).toBe(false);
  });
});

describe("toPimError reads structured fields before text (misclassified errors, #150 follow-up)", () => {
  const classify = (err: Error) => {
    const p = toPimError(err);
    return { code: p.code, retryable: p.isRetryable, message: p.message };
  };
  const tsdav = (status: string, body = "") =>
    new Error(`Collection query failed: ${status}.${body ? ` Raw response: ${body}` : ""}`);
  const imapNo = (fields: Record<string, unknown>) =>
    Object.assign(new Error("Command failed"), { responseStatus: "NO", ...fields });
  const smtp = (code: string, responseCode: number, message: string) =>
    Object.assign(new Error(message), { code, responseCode });

  it.each([["Database connection lost"], ['<a href="/login">Login</a>'], ["upstream timeout"]])(
    "misclassified: a tsdav 500 whose body says %j is OPERATION_FAILED, not retryable",
    (body) => {
      expect(classify(tsdav("500 Internal Server Error", body))).toMatchObject({
        code: ErrorCode.OPERATION_FAILED,
        retryable: false,
      });
    },
  );

  it.each([
    ["401 ", ErrorCode.AUTH_FAILED, false],
    ["401 Unauthorized", ErrorCode.AUTH_FAILED, false],
    ["403 Forbidden", ErrorCode.OPERATION_FAILED, false],
    ["404 Not Found", ErrorCode.OPERATION_FAILED, false],
    ["429 Too Many Requests", ErrorCode.OPERATION_FAILED, true],
    ["502 Bad Gateway", ErrorCode.CONNECTION_FAILED, true],
    ["503 Service Unavailable", ErrorCode.CONNECTION_FAILED, true],
    ["504 Gateway Timeout", ErrorCode.CONNECTION_TIMEOUT, true],
    ["408 Request Timeout", ErrorCode.CONNECTION_TIMEOUT, true],
  ] as const)("a tsdav %s is classified by its status", (status, code, retryable) => {
    expect(classify(tsdav(status))).toMatchObject({ code, retryable });
  });

  it("reads tsdav's '<prop> returned <status>' form", () => {
    expect(
      toPimError(new Error("Calendar discovery failed: resourcetype returned 403 Forbidden")).code,
    ).toBe(ErrorCode.OPERATION_FAILED);
  });

  it.each([
    "Collection sync failed: 401 Unauthorized",
    "Collection status check failed: 401 ",
    "Calendar discovery failed: 401 ",
    "Address book discovery failed: 401 ",
    "VCard fetch failed: 401 ",
    "Calendar object fetch failed: 401 ",
  ])("reads the status from every tsdav prefix: %s", (message) => {
    expect(toPimError(new Error(message)).code).toBe(ErrorCode.AUTH_FAILED);
  });

  it.each([
    'Failed to import "Login page redesign"',
    'Folder "Connection notes" is empty',
    "Requested from address is not allowed: auth@example.com",
    "Event title: timeout review",
  ])("misclassified: caller text %j does not steer the code", (message) => {
    expect(classify(new Error(message))).toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      retryable: false,
    });
  });

  it("misclassified: an imapflow wrong password is AUTH_FAILED, with the server's words", () => {
    const err = imapNo({
      authenticationFailed: true,
      responseText: "Authentication failed.",
      serverResponseCode: "AUTHENTICATIONFAILED",
    });
    expect(classify(err)).toMatchObject({ code: ErrorCode.AUTH_FAILED, retryable: false });
    expect(toPimError(err).message).toContain("Authentication failed.");
  });

  it.each([
    ["NoConnection", ErrorCode.CONNECTION_FAILED],
    ["ETIMEOUT", ErrorCode.CONNECTION_TIMEOUT],
  ] as const)(
    "a connection lost during LOGIN (%s) stays a retryable connection error",
    (code, expected) => {
      // imapflow sets authenticationFailed on any error from LOGIN, including a dropped socket.
      const err = Object.assign(new Error("Connection not available"), {
        code,
        authenticationFailed: true,
      });
      expect(classify(err)).toMatchObject({ code: expected, retryable: true });
    },
  );

  it("a temporary auth backend failure at LOGIN (UNAVAILABLE) is retryable, not AUTH_FAILED", () => {
    const err = imapNo({
      authenticationFailed: true,
      responseText: "Temporary authentication failure.",
      serverResponseCode: "UNAVAILABLE",
    });
    expect(classify(err)).toMatchObject({ code: ErrorCode.OPERATION_FAILED, retryable: true });
  });

  it("an imapflow AuthenticationFailure without the word is still AUTH_FAILED", () => {
    const err = Object.assign(new Error("No password configured"), { authenticationFailed: true });
    expect(toPimError(err).code).toBe(ErrorCode.AUTH_FAILED);
  });

  it("misclassified: another IMAP refusal is OPERATION_FAILED and keeps the server's text", () => {
    const err = imapNo({ responseText: "Permission denied", serverResponseCode: "NOPERM" });
    expect(classify(err)).toMatchObject({ code: ErrorCode.OPERATION_FAILED, retryable: false });
    expect(toPimError(err).message).toBe("Command failed: Permission denied");
  });

  it("an IMAP UNAVAILABLE refusal is retryable", () => {
    const err = imapNo({ responseText: "Try later", serverResponseCode: "UNAVAILABLE" });
    expect(classify(err)).toMatchObject({ code: ErrorCode.OPERATION_FAILED, retryable: true });
  });

  it("Gmail's missing-mailbox text ('now in authenticated state') is not AUTH_FAILED", () => {
    const err = imapNo({
      responseText: "Unknown Mailbox: Nope (now in authenticated state) (Failure)",
      serverResponseCode: "NONEXISTENT",
    });
    expect(toPimError(err).code).toBe(ErrorCode.OPERATION_FAILED);
  });

  it("imapflow ETHROTTLE is retryable", () => {
    const err = Object.assign(new Error("Command failed"), { code: "ETHROTTLE" });
    expect(classify(err)).toMatchObject({ code: ErrorCode.OPERATION_FAILED, retryable: true });
  });

  it("imapflow ClosedAfterConnectTLS is CONNECTION_FAILED", () => {
    const err = Object.assign(new Error("Unexpected close"), { code: "ClosedAfterConnectTLS" });
    expect(classify(err)).toMatchObject({ code: ErrorCode.CONNECTION_FAILED, retryable: true });
  });

  it("nodemailer EAUTH is AUTH_FAILED from the code", () => {
    expect(toPimError(smtp("EAUTH", 535, "Invalid login: 535 5.7.8 rejected")).code).toBe(
      ErrorCode.AUTH_FAILED,
    );
  });

  it("misclassified: a 5xx SMTP rejection mentioning auth is SEND_FAILED, not retryable", () => {
    const err = smtp("EENVELOPE", 553, "Sender address rejected: not owned by auth user");
    expect(classify(err)).toMatchObject({ code: ErrorCode.SEND_FAILED, retryable: false });
  });

  it("misclassified: a 5xx SMTP rejection mentioning connection is SEND_FAILED, not retryable", () => {
    const err = smtp("EMESSAGE", 554, "Message rejected on this connection");
    expect(classify(err)).toMatchObject({ code: ErrorCode.SEND_FAILED, retryable: false });
  });

  it("a 4xx SMTP refusal is SEND_FAILED and retryable", () => {
    const err = smtp("EENVELOPE", 451, "Temporary local problem");
    expect(classify(err)).toMatchObject({ code: ErrorCode.SEND_FAILED, retryable: true });
  });

  it("an AbortSignal timeout is CONNECTION_TIMEOUT by its name", () => {
    const err = Object.assign(new Error("The operation was aborted due to timeout"), {
      name: "TimeoutError",
    });
    expect(classify(err)).toMatchObject({ code: ErrorCode.CONNECTION_TIMEOUT, retryable: true });
  });

  it("still classifies tsdav's own credential and OAuth messages as AUTH_FAILED", () => {
    expect(
      toPimError(
        new Error("Invalid credentials: PROPFIND https://example.com/ returned 401 Unauthorized"),
      ).code,
    ).toBe(ErrorCode.AUTH_FAILED);
    expect(toPimError(new Error("Oauth credentials missing")).code).toBe(ErrorCode.AUTH_FAILED);
  });
});
