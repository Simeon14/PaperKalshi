// MLB team-name mapping. Kalshi labels its KXMLBGAME markets by city ("San Diego",
// "Chicago C") and encodes the team code in the market ticker suffix ("...-SD", "...-CHC").
// We display the club nickname ("Padres", "Cubs") instead. Source of truth is the table below;
// the by-code and by-city lookups are derived from it.

// [ticker code, yes_sub_title / city, nickname]
const MLB_TEAMS: [string, string, string][] = [
  ["ATH", "A's", "Athletics"],
  ["ATL", "Atlanta", "Braves"],
  ["AZ", "Arizona", "Diamondbacks"],
  ["BAL", "Baltimore", "Orioles"],
  ["BOS", "Boston", "Red Sox"],
  ["CHC", "Chicago C", "Cubs"],
  ["CIN", "Cincinnati", "Reds"],
  ["CLE", "Cleveland", "Guardians"],
  ["COL", "Colorado", "Rockies"],
  ["CWS", "Chicago WS", "White Sox"],
  ["DET", "Detroit", "Tigers"],
  ["HOU", "Houston", "Astros"],
  ["KC", "Kansas City", "Royals"],
  ["LAA", "Los Angeles A", "Angels"],
  ["LAD", "Los Angeles D", "Dodgers"],
  ["MIA", "Miami", "Marlins"],
  ["MIL", "Milwaukee", "Brewers"],
  ["MIN", "Minnesota", "Twins"],
  ["NYM", "New York M", "Mets"],
  ["NYY", "New York Y", "Yankees"],
  ["PHI", "Philadelphia", "Phillies"],
  ["PIT", "Pittsburgh", "Pirates"],
  ["SD", "San Diego", "Padres"],
  ["SEA", "Seattle", "Mariners"],
  ["SF", "San Francisco", "Giants"],
  ["STL", "St. Louis", "Cardinals"],
  ["TB", "Tampa Bay", "Rays"],
  ["TEX", "Texas", "Rangers"],
  ["TOR", "Toronto", "Blue Jays"],
  ["WSH", "Washington", "Nationals"],
];

const NICK_BY_CODE: Record<string, string> = Object.fromEntries(
  MLB_TEAMS.map(([code, , nick]) => [code, nick]),
);
const NICK_BY_CITY: Record<string, string> = Object.fromEntries(
  MLB_TEAMS.map(([, city, nick]) => [city, nick]),
);

export function isMlbTicker(ticker: string): boolean {
  return ticker.startsWith("KXMLBGAME");
}

// City / yes_sub_title -> nickname. Prefers the ticker-suffix code (exact) and falls back to
// the city label; returns the input unchanged when it isn't a known MLB team (idempotent, so
// applying it to an already-mapped nickname is a no-op).
export function mlbTeam(sub: string, ticker = ""): string {
  const code = ticker.split("-").pop() ?? "";
  return NICK_BY_CODE[code] ?? NICK_BY_CITY[sub] ?? sub;
}

// "San Diego vs Los Angeles D" -> "Padres vs Dodgers". Each side is mapped by its city label;
// unknown sides pass through unchanged.
export function mlbMatchup(title: string): string {
  return title
    .split(" vs ")
    .map((part) => NICK_BY_CITY[part.trim()] ?? part.trim())
    .join(" vs ");
}
