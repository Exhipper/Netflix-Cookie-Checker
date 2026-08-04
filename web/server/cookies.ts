import type { CookieEntry, CookieBundle } from "./types.js";

const LOGIN_REQUIRED_COOKIES = ["NetflixId"];
const OPTIONAL_COOKIES = ["SecureNetflixId", "nfvdid", "OptanonConsent"];
const ALL_COOKIE_NAMES = new Set([...LOGIN_REQUIRED_COOKIES, ...OPTIONAL_COOKIES]);
const CANONICAL_MAP: Record<string, string> = {};
for (const name of ALL_COOKIE_NAMES) {
  CANONICAL_MAP[name.toLowerCase()] = name;
}

export function canonicalizeCookieName(name: string): string {
  const normalized = (name || "").trim();
  return CANONICAL_MAP[normalized.toLowerCase()] || normalized;
}

export function isNetflixDomain(domain: string): boolean {
  let normalized = (domain || "").trim();
  if (normalized.startsWith("#HttpOnly_")) {
    normalized = normalized.slice("#HttpOnly_".length);
  }
  return normalized.toLowerCase().includes("netflix.");
}

export function isNetflixCookieEntry(domain: string, name: string): boolean {
  const canonical = canonicalizeCookieName(name);
  return ALL_COOKIE_NAMES.has(canonical) || isNetflixDomain(domain);
}

export function hasRequiredCookies(cookieDict: Record<string, string>): boolean {
  if (!cookieDict || typeof cookieDict !== "object") return false;
  for (const name of LOGIN_REQUIRED_COOKIES) {
    if (!cookieDict[name]) return false;
  }
  return true;
}

function buildCookieEntry(
  domain: string,
  tailMatch: string,
  path: string,
  secure: string,
  expires: string,
  name: string,
  value: string,
  position: number
): CookieEntry {
  let normalizedExpires = (expires || "0").trim();
  if (/^-?\d+\.\d+$/.test(normalizedExpires)) {
    normalizedExpires = String(parseInt(parseFloat(normalizedExpires).toString(), 10));
  }
  return {
    domain: (domain || "").replace(/^#HttpOnly_/, ""),
    tail_match: tailMatch.toUpperCase() === "TRUE" ? "TRUE" : "FALSE",
    path: path || "/",
    secure: secure.toUpperCase() === "TRUE" ? "TRUE" : "FALSE",
    expires: normalizedExpires || "0",
    name: canonicalizeCookieName(name),
    value: value || "",
    position,
  };
}

export function formatCookieEntry(entry: CookieEntry): string {
  return `${entry.domain}\t${entry.tail_match}\t${entry.path}\t${entry.secure}\t${entry.expires}\t${entry.name}\t${entry.value}`;
}

function splitNetscapeColumns(line: string): string[] {
  let stripped = line.trim();
  if (!stripped) return [];
  if (stripped.startsWith("#") && !stripped.startsWith("#HttpOnly_")) return [];
  if (stripped.startsWith("#HttpOnly_")) stripped = stripped.slice("#HttpOnly_".length);
  if (!stripped) return [];

  const tabParts = stripped.split("\t");
  if (tabParts.length >= 7) {
    return [...tabParts.slice(0, 6), tabParts.slice(6).join("\t")];
  }

  const spaceParts = stripped.split(/\s+/);
  if (spaceParts.length >= 7) return spaceParts;
  return [];
}

function isNetscapeCookieLine(line: string): boolean {
  const parts = splitNetscapeColumns(line);
  if (parts.length < 7) return false;
  if (!["TRUE", "FALSE"].includes(parts[1].toUpperCase())) return false;
  if (!["TRUE", "FALSE"].includes(parts[3].toUpperCase())) return false;
  if (!/^-?\d+(?:\.\d+)?$/.test(parts[4].trim())) return false;
  return true;
}

export function extractNetscapeEntries(rawText: string): CookieEntry[] {
  const entries: CookieEntry[] = [];
  const lines = rawText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!isNetscapeCookieLine(lines[i])) continue;
    const parts = splitNetscapeColumns(lines[i]);
    if (parts.length < 7) continue;
    const domain = parts[0];
    const name = canonicalizeCookieName(parts[5]);
    if (!isNetflixCookieEntry(domain, name)) continue;
    entries.push(
      buildCookieEntry(domain, parts[1], parts[2], parts[3], parts[4], name, parts[6], i)
    );
  }
  return entries;
}

export function extractJsonEntries(content: string): CookieEntry[] {
  let jsonData: any;
  try {
    jsonData = JSON.parse(content);
  } catch {
    return [];
  }

  if (jsonData && typeof jsonData === "object" && !Array.isArray(jsonData)) {
    if (Array.isArray(jsonData.cookies)) jsonData = jsonData.cookies;
    else if (Array.isArray(jsonData.items)) jsonData = jsonData.items;
    else jsonData = [jsonData];
  }
  if (!Array.isArray(jsonData)) return [];

  const entries: CookieEntry[] = [];
  jsonData.forEach((cookie: any, index: number) => {
    if (!cookie || typeof cookie !== "object") return;
    const domain = cookie.domain || "";
    const name = canonicalizeCookieName(cookie.name || "");
    if (!isNetflixCookieEntry(domain, name)) return;
    entries.push(
      buildCookieEntry(
        domain,
        String(domain).startsWith(".") ? "TRUE" : "FALSE",
        cookie.path || "/",
        cookie.secure ? "TRUE" : "FALSE",
        String(cookie.expirationDate ?? cookie.expiration ?? 0),
        name,
        cookie.value || "",
        index
      )
    );
  });
  return entries;
}

export function extractRawEntries(rawText: string): CookieEntry[] {
  const sortedNames = [...ALL_COOKIE_NAMES].sort((a, b) => b.length - a.length);
  const escapedNames = sortedNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `(?:['"])?(?<name>${escapedNames.join("|")})(?:['"])?\\s*(?:=|:)\\s*(?<value>"[^"]*"|'[^']*'|[^;\\s]+)`,
    "gi"
  );
  const entries: CookieEntry[] = [];
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(rawText)) !== null) {
    const cookieName = canonicalizeCookieName(match.groups!.name);
    let value = match.groups!.value;
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/,$/, "");
    }
    entries.push(
      buildCookieEntry(
        ".netflix.com",
        "TRUE",
        "/",
        cookieName === "SecureNetflixId" ? "TRUE" : "FALSE",
        "0",
        cookieName,
        value,
        index++
      )
    );
  }
  return entries;
}

export function cookiesDictFromNetscape(netscapeText: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const line of netscapeText.split("\n")) {
    const parts = splitNetscapeColumns(line);
    if (parts.length >= 7) {
      const domain = parts[0];
      const name = canonicalizeCookieName(parts[5]);
      const value = parts[6];
      if (isNetflixCookieEntry(domain, name)) {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

export function buildCookieBundles(entries: CookieEntry[]): CookieBundle[] {
  if (!entries.length) return [];

  const byName: Record<string, CookieEntry[]> = {};
  for (const entry of entries) {
    if (!entry.name) continue;
    if (!byName[entry.name]) byName[entry.name] = [];
    byName[entry.name].push(entry);
  }
  if (!Object.keys(byName).length) return [];

  const netflixIdCount = (byName["NetflixId"] || []).length;
  const bundleCount =
    netflixIdCount || Math.max(...Object.values(byName).map((e) => e.length));
  const bundles: CookieBundle[] = [];

  for (let bundleIdx = 0; bundleIdx < bundleCount; bundleIdx++) {
    const selected: CookieEntry[] = [];
    for (const nameEntries of Object.values(byName)) {
      if (bundleIdx < nameEntries.length) {
        selected.push(nameEntries[bundleIdx]);
      } else if (nameEntries.length === 1) {
        selected.push(nameEntries[0]);
      }
    }
    if (!selected.length) continue;

    selected.sort((a, b) => a.position - b.position);
    const netscapeText = selected.map(formatCookieEntry).join("\n");
    bundles.push({
      index: bundleIdx + 1,
      total: bundleCount,
      netscape_text: netscapeText,
      cookies: cookiesDictFromNetscape(netscapeText),
    });
  }
  return bundles;
}

export function extractCookieBundles(content: string): CookieBundle[] {
  for (const extractor of [extractJsonEntries, extractNetscapeEntries, extractRawEntries]) {
    const bundles = buildCookieBundles(extractor(content));
    if (bundles.length) return bundles;
  }
  return [];
}
