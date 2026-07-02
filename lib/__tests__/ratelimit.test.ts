import { describe, it, expect, vi, afterEach } from "vitest";
import { rateLimit, clientIp } from "@/lib/ratelimit";

afterEach(() => vi.useRealTimers());

describe("rateLimit", () => {
  it("allows up to the limit then blocks, and resets after the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const key = "test:" + Math.random();
    expect(rateLimit(key, 3, 60_000)).toBe(true);
    expect(rateLimit(key, 3, 60_000)).toBe(true);
    expect(rateLimit(key, 3, 60_000)).toBe(true);
    expect(rateLimit(key, 3, 60_000)).toBe(false);
    vi.setSystemTime(1_000_000 + 60_001);
    expect(rateLimit(key, 3, 60_000)).toBe(true);
  });
  it("tracks keys independently", () => {
    const a = "a:" + Math.random();
    const b = "b:" + Math.random();
    expect(rateLimit(a, 1, 60_000)).toBe(true);
    expect(rateLimit(a, 1, 60_000)).toBe(false);
    expect(rateLimit(b, 1, 60_000)).toBe(true);
  });
});

describe("clientIp", () => {
  it("prefers x-real-ip", () => {
    const req = { headers: new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }) };
    expect(clientIp(req)).toBe("1.2.3.4");
  });
  it("falls back to the LAST x-forwarded-for hop (first hops are client-spoofable)", () => {
    const req = { headers: new Headers({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }) };
    expect(clientIp(req)).toBe("1.2.3.4");
  });
  it("degrades to unknown", () => {
    expect(clientIp({ headers: new Headers() })).toBe("unknown");
  });
});
