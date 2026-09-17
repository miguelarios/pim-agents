/**
 * The SORT command wrapper on its own: capability gating, the attributes it
 * puts on the wire, and the fail-soft contract that lets ImapService keep its
 * client-side path as a fallback.
 */
import type { ImapFlow } from "imapflow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supportsSort, uidSort } from "../imapSort.js";

const mockExec = vi.fn();

function fakeClient(capabilities: string[] = ["SORT"]): ImapFlow {
  return {
    capabilities: new Map(capabilities.map((c) => [c, true])),
    enabled: new Set(),
    mailbox: { flags: new Set() },
    exec: mockExec,
  } as unknown as ImapFlow;
}

const answersWith = (uids: number[]) => {
  mockExec.mockImplementation(async (_command, _attributes, options: any) => {
    await options.untagged.SORT({ attributes: uids.map((u) => ({ value: String(u) })) });
    return { next: vi.fn() };
  });
};

beforeEach(() => {
  mockExec.mockReset();
});

describe("supportsSort", () => {
  it("is true only when the server advertises SORT", () => {
    expect(supportsSort(fakeClient(["SORT", "IDLE"]))).toBe(true);
    expect(supportsSort(fakeClient(["IDLE"]))).toBe(false);
  });

  it("is false rather than throwing when there is no capability map", () => {
    expect(supportsSort({} as unknown as ImapFlow)).toBe(false);
  });
});

describe("uidSort", () => {
  it("returns the UIDs in the server's order, not sorted numerically", async () => {
    answersWith([30, 10, 20]);
    expect(await uidSort(fakeClient(), {}, "date", "desc")).toEqual([30, 10, 20]);
  });

  it("issues UID SORT with the sort keys, charset and search key in that order", async () => {
    answersWith([1]);
    await uidSort(fakeClient(), {}, "from", "asc");

    const [command, attributes] = mockExec.mock.calls[0];
    expect(command).toBe("UID SORT");
    expect(attributes[0]).toEqual([{ type: "ATOM", value: "FROM" }]);
    expect(attributes[1]).toEqual({ type: "ATOM", value: "UTF-8" });
    expect(attributes[2]).toEqual({ type: "ATOM", value: "ALL" });
  });

  it("prefixes the key with REVERSE for a descending sort", async () => {
    answersWith([1]);
    await uidSort(fakeClient(), {}, "subject", "desc");

    expect(mockExec.mock.calls[0][1][0]).toEqual([
      { type: "ATOM", value: "REVERSE" },
      { type: "ATOM", value: "SUBJECT" },
    ]);
  });

  it("compiles real criteria into the search key", async () => {
    answersWith([1]);
    await uidSort(fakeClient(), { seen: true }, "date", "desc");

    const attributes = mockExec.mock.calls[0][1];
    expect(attributes.slice(2)).toEqual([{ type: "ATOM", value: "SEEN" }]);
  });

  it("releases the response so the connection is not left waiting", async () => {
    const next = vi.fn();
    mockExec.mockImplementation(async (_c, _a, options: any) => {
      await options.untagged.SORT({ attributes: [] });
      return { next };
    });

    await uidSort(fakeClient(), {}, "date", "desc");
    expect(next).toHaveBeenCalled();
  });

  it("returns null without issuing anything when SORT is not advertised", async () => {
    expect(await uidSort(fakeClient([]), {}, "date", "desc")).toBeNull();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns null when the server rejects the command", async () => {
    mockExec.mockRejectedValue(new Error("BADCHARSET"));
    expect(await uidSort(fakeClient(), {}, "date", "desc")).toBeNull();
  });

  it("returns an empty list, not null, when the thread genuinely matches nothing", async () => {
    answersWith([]);
    expect(await uidSort(fakeClient(), {}, "date", "desc")).toEqual([]);
  });

  it("ignores anything in the SORT response that is not a UID", async () => {
    mockExec.mockImplementation(async (_c, _a, options: any) => {
      await options.untagged.SORT({
        // A CONDSTORE server can append a (MODSEQ n) group; an empty value
        // would otherwise become UID 0, since Number("") is 0.
        attributes: [{ value: "5" }, { value: "MODSEQ" }, { value: "" }, { value: "7" }],
      });
      return { next: vi.fn() };
    });

    expect(await uidSort(fakeClient(), {}, "date", "desc")).toEqual([5, 7]);
  });
});
