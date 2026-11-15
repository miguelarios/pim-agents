import type { TypedValue } from "@miguelarios/pim-core";
import { describe, expect, it } from "vitest";
import { pickPreferred } from "../services/preferred.js";

describe("pickPreferred", () => {
  it("is undefined for an empty list", () => {
    expect(pickPreferred([])).toBeUndefined();
  });

  it("takes the first value when none is preferred", () => {
    const values: TypedValue[] = [{ value: "a" }, { value: "b" }];
    expect(pickPreferred(values)?.value).toBe("a");
  });

  it("takes the preferred value wherever it sits", () => {
    expect(pickPreferred([{ value: "a" }, { value: "b", pref: true }])?.value).toBe("b");
  });

  it("narrows by type token, case-insensitive, before preferring", () => {
    const values = [
      { type: "home", value: "h", pref: true },
      { type: "home/work", value: "hw" },
      { type: "work", value: "w", pref: true },
    ];
    expect(pickPreferred(values, "WORK")?.value).toBe("w");
    expect(pickPreferred(values, " home ")?.value).toBe("h");
  });

  it("is undefined, not another type, when none has the type", () => {
    expect(pickPreferred([{ type: "home", value: "h" }], "work")).toBeUndefined();
  });

  it("works for postal addresses, which carry type and pref too", () => {
    const addrs = [
      { type: "home", city: "A" },
      { type: "work", city: "B", pref: true },
    ];
    expect(pickPreferred(addrs)?.city).toBe("B");
  });
});
