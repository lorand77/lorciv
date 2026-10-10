"use strict";

// What a new account may be called, beyond the character and length check in
// routes.js: nothing containing "lor" (the site's own prefix), nothing that
// passes for staff or for a label the UI prints, no English profanity or
// slurs. Only registration asks; existing accounts keep their names. The lists
// live here, server-side only, so nobody can read them to find the gaps.
//
// A name is compared in several readings, because the evasions that fit in
// [A-Za-z0-9_] are case, underscores, digits for letters and stretched letters:
//   plain     lowercase, underscores removed          Big_Admin -> bigadmin
//   leet      plain with digits read as letters       4dm1n     -> admin
//   squeezed  leet with repeated letters collapsed    fuuuck    -> fuck
//   parts     split on "_" and lowerUpper boundaries  BigMod_7  -> big, mod
// "Anywhere" words are looked for inside plain, leet (and squeezed, for
// profanity); "part" words must be a whole part, so short words don't hit
// ordinary ones (ass/classic, mod/modern, sex/Essex).

// Rule 1: anywhere in plain or leet. Also covers LorCiv and LorChess.
const LOR = "lor";

// Rule 2: names that pass for the site, its staff, or a UI label.
const RESERVED_ANYWHERE = ["admin", "moderator", "official", "support", "staff", "system"];
const RESERVED_PARTS = ["mod", "mods", "root", "sysop", "owner", "dev", "devs", "bot", "ai"];
const RESERVED_WHOLE = [
  "guest", "anon", "anonymous", "deleted", "unknown", "nobody", "null", "undefined",
  // Labels the UI prints for seats that are not a person.
  "computer", "cpu", "opponent", "player", "spectator",
];

// Rule 3: English slurs and profanity. Long, unambiguous words match anywhere;
// short ones that hide inside ordinary words only as a whole part.
const OFFENSIVE_ANYWHERE = [
  "nigg", "faggot", "kike", "chink", "wetback", "beaner", "gook", "tranny", "retard",
  "raghead", "towelhead", "hitler", "kkk",
  "fuck", "shit", "cunt", "bitch", "whore", "slut", "pussy", "dildo", "penis", "vagina",
  "blowjob", "handjob", "jizz", "cumshot", "porn", "rapist", "pedophile", "paedo",
  "molest", "bastard", "asshole", "arsehole", "wank", "twat", "bollock", "piss", "hentai",
];
// Squeezed, these become innocent: nig(er), k, gok(han), pis(tol).
const NO_SQUEEZE = new Set(["nigg", "kkk", "gook", "piss"]);
const OFFENSIVE_PARTS = [
  "fag", "fags", "spic", "coon", "dyke", "paki", "negro", "nazi", "jap", "homo",
  "ass", "asses", "arse", "tit", "tits", "titty", "cum", "cock", "cocks", "dick", "dicks",
  "prick", "rape", "raped", "anal", "anus", "sex", "sexy", "pedo", "crap", "boob", "boobs",
  "milf", "nude", "horny", "semen",
];
// Real words and names that contain an anywhere word. They are cut out of a
// reading before rule 3 looks at it; rules 1 and 2 ignore this list.
const ALLOWED_WORDS = [
  "scunthorpe", "penistone", "therapist", "retardant", "swank", "snigger", "sniggle",
  "shiitake", "shitake", "kinoshita", "yamashita", "matsushita", "takeshita", "morishita",
];

const LEET = { 0: "o", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g" };

// Both readings of a string with digits as letters: "1" as i and as l. Digits
// with no letter reading (2, 6) are dropped, and so are runs of three or more,
// which are numbers, not letters: read as letters, Ryan1995 holds a slur.
function leetOf(s) {
  const short = s.replace(/\d{3,}/g, "");
  return ["i", "l"].map((one) => short.replace(/\d/g, (d) => (d === "1" ? one : LEET[d] || "")));
}

function squeeze(s) {
  return s.replace(/(.)\1+/g, "$1");
}

function withoutAllowed(reading, squeezed) {
  for (const word of ALLOWED_WORDS) {
    reading = reading.split(squeezed ? squeeze(word) : word).join("");
  }
  return reading;
}

// Why `name` may not be registered ("shape", "lor", "reserved", "offensive"),
// or null if it may. Assumes the name already passed routes.js's format check.
function usernameProblem(name) {
  if (!/[A-Za-z]/.test(name) || /^_|_$|__/.test(name)) return "shape";

  const plain = name.toLowerCase().replace(/_/g, "");
  const readings = [plain, ...leetOf(plain)];
  const squeezed = leetOf(plain).map(squeeze);
  const parts = name
    .split("_")
    .flatMap((p) => p.split(/(?<=[a-z])(?=[A-Z])/))
    .map((p) => p.toLowerCase())
    // A part with no letters is a number, and a grid reference like A1 is
    // not a word: Bob_41 and Rook_A1 do not say "ai".
    .filter((p) => /[a-z]/.test(p) && !/^[a-h][1-8]$/.test(p))
    .flatMap((p) => [...leetOf(p), ...leetOf(p.replace(/\d+$/, ""))]);
  const isPart = (words) => parts.some((p) => words.includes(p));
  const inside = (words, rs) => rs.some((r) => words.some((w) => r.includes(w)));

  if (readings.some((r) => r.includes(LOR))) return "lor";

  if (
    readings.some((r) => RESERVED_WHOLE.includes(r)) ||
    inside(RESERVED_ANYWHERE, readings) ||
    isPart(RESERVED_PARTS)
  ) {
    return "reserved";
  }

  const cleaned = readings.map((r) => withoutAllowed(r, false));
  const cleanedSqueezed = squeezed.map((r) => withoutAllowed(r, true));
  const squeezable = OFFENSIVE_ANYWHERE.filter((w) => !NO_SQUEEZE.has(w)).map(squeeze);
  if (
    inside(OFFENSIVE_ANYWHERE, cleaned) ||
    inside(squeezable, cleanedSqueezed) ||
    isPart(OFFENSIVE_PARTS)
  ) {
    return "offensive";
  }

  return null;
}

module.exports = { usernameProblem };
