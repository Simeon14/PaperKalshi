import { describe, it, expect } from "vitest";
import { computeParlayHolds } from "@/lib/parlayHold";

// Temporary hold rules: MLB anything-goes; World Cup only when fully independent (different
// match/event AND no shared team); everything else unsupported. Delete with lib/parlayHold.ts.

const MLB_A = "KXMLBGAME-26JUL021235PITPHI-PHI";
const MLB_B = "KXMLBTEAMTOTAL-26JUL021235PITPHI-PHI2";
const WC_ESP_ML = "KXWCGAME-26JUL02ESPAUT-ESP";
const WC_ESP_SCORE = "KXWCSCORE-26JUL02ESPAUT-ESP2AUT0";
const WC_ENG_ML = "KXWCGAME-26JUL03ENGCOD-ENG";
const WC_ESP_FINAL = "KXWCROUND-26FINAL-ESP";
const WC_ARG_FINAL = "KXWCROUND-26FINAL-ARG";
const OTHER = "KXHIGHNY-26JUL05-B58.5";

describe("computeParlayHolds", () => {
  it("MLB combos are unrestricted (the model covers them)", () => {
    expect(computeParlayHolds([MLB_A, MLB_B])).toEqual([]);
  });
  it("independent WC legs pass (different matches, disjoint teams)", () => {
    expect(computeParlayHolds([WC_ESP_ML, WC_ENG_ML])).toEqual([]);
  });
  it("MLB + independent WC mix passes", () => {
    expect(computeParlayHolds([MLB_A, WC_ESP_ML])).toEqual([]);
  });
  it("two WC legs from the same match are held", () => {
    expect(computeParlayHolds([WC_ESP_ML, WC_ESP_SCORE])).toEqual(["wc_correlated"]);
  });
  it("the same WC team across different events is held", () => {
    expect(computeParlayHolds([WC_ESP_ML, WC_ESP_FINAL])).toEqual(["wc_correlated"]);
  });
  it("two legs in the same WC futures event are held (conservative)", () => {
    expect(computeParlayHolds([WC_ESP_FINAL, WC_ARG_FINAL])).toEqual(["wc_correlated"]);
  });
  it("draw/tie outcomes in different matches do NOT collide as a shared team", () => {
    expect(
      computeParlayHolds(["KXWCGAME-26JUL02ESPAUT-TIE", "KXWCGAME-26JUL03ENGCOD-TIE"]),
    ).toEqual([]);
  });
  it("a non-MLB non-WC leg is held as unsupported", () => {
    expect(computeParlayHolds([MLB_A, OTHER])).toEqual(["unsupported_market"]);
  });
  it("mixed problems report both holds", () => {
    expect(computeParlayHolds([WC_ESP_ML, WC_ESP_SCORE, OTHER])).toEqual([
      "unsupported_market",
      "wc_correlated",
    ]);
  });
});
