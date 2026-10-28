import { beforeEach, expect, it, vi } from "vitest";
import { contentVersion, resetContentVersionForTests } from "../../workers/content-version";

beforeEach(() => resetContentVersionForTests());

it("reads the change stamp at most once a minute and retries straight away after a failed read", async () => {
  const read = vi.fn(async () => "1793165000000");
  expect(await contentVersion(0, read)).toBe("1793165000000");
  expect(await contentVersion(59_000, read)).toBe("1793165000000");
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValueOnce("1793165090000");
  expect(await contentVersion(61_000, read)).toBe("1793165090000");
  resetContentVersionForTests();
  const failing = vi.fn(async () => { throw new Error("offline"); });
  expect(await contentVersion(0, failing)).toBeNull();
  await Promise.resolve();
  expect(await contentVersion(1_000, read)).toBe("1793165000000");
});
