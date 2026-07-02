import { describe, it, expect } from "vitest";
import { eventStart, etToUtc } from "@/lib/kalshi/eventTime";

// Timestamps are asserted exactly (timezone-independent); labels depend on the runner's
// locale/timezone, so they are only asserted loosely.

describe("etToUtc", () => {
  it("converts an EDT wall time (summer, UTC-4)", () => {
    // Verified against the live feed: ...26JUL042010... has close_time 00:10Z (+3 days).
    expect(etToUtc(2026, 6, 4, 20, 10)).toBe(Date.UTC(2026, 6, 5, 0, 10));
  });
  it("converts an EST wall time (winter, UTC-5)", () => {
    expect(etToUtc(2026, 0, 15, 19, 5)).toBe(Date.UTC(2026, 0, 16, 0, 5));
  });
});

describe("eventStart", () => {
  it("parses an MLB ticker (date + HHMM, US Eastern)", () => {
    const { ts, label } = eventStart("KXMLBGAME-26JUL042010SFCOL", "2026-07-08T00:10:00Z");
    expect(ts).toBe(Date.UTC(2026, 6, 5, 0, 10)); // NOT the close_time (start + 3 days)
    expect(label).toContain("·"); // date · time
  });
  it("parses a World Cup ticker (date only, no timezone shifting)", () => {
    const { ts, label } = eventStart("KXWCTOTAL-26JUL05BRANOR", "2026-07-19T00:00:00Z");
    expect(ts).toBe(Date.UTC(2026, 6, 5));
    expect(label).toBe("Jul 5");
  });
  it("parses a WCM match-card id", () => {
    const { ts, label } = eventStart("WCM-26JUL01ENGCOD", "");
    expect(ts).toBe(Date.UTC(2026, 6, 1));
    expect(label).toBe("Jul 1");
  });
  it("parses a market ticker with a trailing outcome suffix", () => {
    const { ts } = eventStart("KXMLBGAME-26JUN271905STLCHC-STL", "");
    expect(ts).toBe(etToUtc(2026, 5, 27, 19, 5));
  });
  it("falls back to close_time for futures tickers", () => {
    const close = "2040-12-31T00:00:00Z";
    const { ts } = eventStart("KXOAIANTH-40", close);
    expect(ts).toBe(Date.parse(close));
  });
  it("handles no date at all", () => {
    const { ts, label } = eventStart("", "");
    expect(ts).toBe(Number.POSITIVE_INFINITY);
    expect(label).toBe("—");
  });
});
