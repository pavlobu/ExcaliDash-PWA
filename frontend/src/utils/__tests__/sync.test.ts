import { describe, expect, it } from "vitest";
import { reconcileElements, applyElementOrder } from "../sync";

describe("reconcileElements", () => {
  it("preserves local-only elements", () => {
    const local = [
      { id: "a", version: 1, versionNonce: 1, updated: 1, isDeleted: false },
    ];
    const remote: any[] = [];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("adds remote-only elements", () => {
    const local: any[] = [];
    const remote = [
      { id: "b", version: 1, versionNonce: 1, updated: 1, isDeleted: false },
    ];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("picks the element with higher version when both devices edited the same element", () => {
    const local = [
      { id: "shared", version: 6, versionNonce: 100, updated: 1000, x: 10, isDeleted: false },
    ];
    const remote = [
      { id: "shared", version: 5, versionNonce: 200, updated: 2000, x: 20, isDeleted: false },
    ];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe(6);
    expect(result[0].x).toBe(10);
  });

  it("picks the remote element when its version is higher", () => {
    const local = [
      { id: "shared", version: 3, versionNonce: 100, updated: 1000, x: 10, isDeleted: false },
    ];
    const remote = [
      { id: "shared", version: 7, versionNonce: 200, updated: 2000, x: 20, isDeleted: false },
    ];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe(7);
    expect(result[0].x).toBe(20);
  });

  it("merges non-overlapping edits from two devices", () => {
    const local = [
      { id: "phone-edit", version: 6, versionNonce: 100, updated: 1000, isDeleted: false },
    ];
    const remote = [
      { id: "computer-edit", version: 5, versionNonce: 200, updated: 2000, isDeleted: false },
    ];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(2);
    const ids = result.map((el) => el.id).sort();
    expect(ids).toEqual(["computer-edit", "phone-edit"]);
  });

  it("uses updated timestamp as tiebreaker when versions are equal", () => {
    const local = [
      { id: "shared", version: 5, versionNonce: 100, updated: 1000, x: 10, isDeleted: false },
    ];
    const remote = [
      { id: "shared", version: 5, versionNonce: 200, updated: 3000, x: 20, isDeleted: false },
    ];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(1);
    expect(result[0].updated).toBe(3000);
    expect(result[0].x).toBe(20);
  });

  it("uses versionNonce as tiebreaker when version and updated are equal", () => {
    const local = [
      { id: "shared", version: 5, versionNonce: 100, updated: 1000, x: 10, isDeleted: false },
    ];
    const remote = [
      { id: "shared", version: 5, versionNonce: 200, updated: 1000, x: 20, isDeleted: false },
    ];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(1);
    expect(result[0].versionNonce).toBe(200);
    expect(result[0].x).toBe(20);
  });

  it("handles empty inputs", () => {
    expect(reconcileElements([], [])).toEqual([]);
  });

  it("handles elements without version fields gracefully", () => {
    const local = [{ id: "a", isDeleted: false }];
    const remote = [{ id: "b", isDeleted: false }];
    const result = reconcileElements(local, remote);
    expect(result).toHaveLength(2);
  });
});

describe("applyElementOrder", () => {
  it("returns elements as-is when no order provided", () => {
    const elements = [
      { id: "a", version: 1 },
      { id: "b", version: 2 },
    ];
    expect(applyElementOrder(elements, null)).toEqual(elements);
    expect(applyElementOrder(elements, undefined)).toEqual(elements);
    expect(applyElementOrder(elements, [])).toEqual(elements);
  });

  it("reorders elements according to the given order", () => {
    const elements = [
      { id: "a", version: 1 },
      { id: "b", version: 2 },
      { id: "c", version: 3 },
    ];
    const result = applyElementOrder(elements, ["c", "a", "b"]);
    expect(result.map((el) => el.id)).toEqual(["c", "a", "b"]);
  });

  it("appends unordered elements at the end", () => {
    const elements = [
      { id: "a", version: 1 },
      { id: "b", version: 2 },
      { id: "c", version: 3 },
    ];
    const result = applyElementOrder(elements, ["b"]);
    expect(result.map((el) => el.id)).toEqual(["b", "a", "c"]);
  });
});
