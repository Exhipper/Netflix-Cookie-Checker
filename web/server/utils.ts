/** Decode HTML entities, unicode escapes, and normalize whitespace in extracted values. */
export function decodeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let cleaned = String(value);
  // HTML entity unescape (basic)
  cleaned = cleaned
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Replacements from Python
  const replacements: Record<string, string> = {
    "\\x20": " ",
    "\\u00A0": " ",
    "\\u00a0": " ",
    u00A0: " ",
  };
  for (const [src, tgt] of Object.entries(replacements)) {
    cleaned = cleaned.split(src).join(tgt);
  }
  cleaned = cleaned.replace(/\\\//g, "/").replace(/\\"/g, '"').replace(/\\n/g, " ").replace(/\\t/g, " ");

  // Unicode/hex escape decoding (repeat up to 3 times)
  for (let i = 0; i < 3; i++) {
    const prev = cleaned;
    cleaned = cleaned.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch { return _; }
    });
    cleaned = cleaned.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch { return _; }
    });
    cleaned = cleaned.replace(/(?<!\\)\bu([0-9a-fA-F]{4})(?![0-9a-fA-F])/g, (_, hex: string) => {
      try { return String.fromCharCode(parseInt(hex, 16)); } catch { return _; }
    });
    cleaned = cleaned.replace(/\\\\/g, "\\");
    if (cleaned === prev) break;
  }

  // Fix split unicode like "Est u00E1ndar"
  cleaned = cleaned.replace(/([A-Za-z])\s+([^\x00-\x7F])/g, "$1$2");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

export function normalizeOutputValue(
  value: unknown,
  fallback = "UNKNOWN",
  naWhenFalse = false
): string {
  const cleaned = decodeValue(value);
  if (cleaned === null || cleaned === "") return fallback;
  const lowered = cleaned.trim().toLowerCase();
  if (["false", "none", "null"].includes(lowered)) {
    return naWhenFalse ? "N/A" : fallback;
  }
  return cleaned;
}

const MONTH_ALIASES: Record<string, number> = {
  january: 1, enero: 1, janvier: 1, januar: 1, janeiro: 1, ocak: 1,
  styczen: 1, stycznia: 1, jan: 1, januari: 1, gennaio: 1, ianuarie: 1,
  february: 2, febrero: 2, fevrier: 2, fevereiro: 2, subat: 2,
  luty: 2, lutego: 2, feb: 2, februari: 2, febbraio: 2, februarie: 2,
  march: 3, marzo: 3, mars: 3, marco: 3, marzec: 3, marca: 3,
  maret: 3, mac: 3, mart: 3, martie: 3, marz: 3, mar: 3, maart: 3, marcius: 3,
  abril: 4, avril: 4, kwiecien: 4, kwietnia: 4, april: 4, apr: 4, aprile: 4, aprilie: 4,
  may: 5, mayo: 5, mai: 5, maj: 5, maja: 5, mei: 5, maggio: 5, mayis: 5,
  june: 6, junio: 6, juin: 6, haziran: 6, czerwiec: 6, czerwca: 6,
  juni: 6, giugno: 6, junho: 6, iunie: 6, jun: 6,
  july: 7, julio: 7, juillet: 7, temmuz: 7, lipiec: 7, lipca: 7,
  juli: 7, luglio: 7, julho: 7, iulie: 7, jul: 7,
  august: 8, agosto: 8, aout: 8, agost: 8, sierpien: 8, sierpnia: 8,
  agustus: 8, agustos: 8, aug: 8,
  september: 9, septiembre: 9, setembro: 9, eylul: 9, wrzesien: 9, wrzesnia: 9,
  setembre: 9, setiembre: 9, sep: 9, sept: 9, settembre: 9,
  october: 10, octubre: 10, outubro: 10, ekim: 10, pazdziernik: 10, pazdziernika: 10,
  oktober: 10, ottobre: 10, oktobar: 10, oct: 10,
  november: 11, noviembre: 11, novembro: 11, kasim: 11, listopad: 11, listopada: 11,
  nov: 11, novembar: 11, novembre: 11, noiembrie: 11,
  december: 12, diciembre: 12, dezembro: 12, aralik: 12, grudzien: 12, grudnia: 12,
  desember: 12, dec: 12, decembre: 12, decembar: 12, decembrie: 12,
};

export function normalizeCalendarYear(year: number): number | null {
  if (2400 <= year && year <= 2700) return year - 543;
  return year;
}

export function parseLocalizedDate(cleaned: string): Date | null {
  if (!cleaned) return null;

  // ISO formats
  const isoFormats = ["%Y-%m-%d", "%Y-%m-%dT%H:%M:%S"];
  for (const fmt of ["YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DDTHH:mm:ss.SSS"]) {
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d;
  }

  const isoCandidate = cleaned.replace("Z", "+00:00");
  try {
    const d = new Date(isoCandidate);
    if (!isNaN(d.getTime())) return d;
  } catch { /* ignore */ }

  // East Asian date format
  const eaMatch = cleaned.match(/(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월](?:\s*(\d{1,2})\s*[日日])?/);
  if (eaMatch) {
    try {
      const year = normalizeCalendarYear(parseInt(eaMatch[1], 10));
      const month = parseInt(eaMatch[2], 10);
      const day = eaMatch[3] ? parseInt(eaMatch[3], 10) : 1;
      if (year !== null) return new Date(year, month - 1, day);
    } catch { /* ignore */ }
  }

  const numericParts = (cleaned.match(/\d+/g) || []).map(Number);
  if (numericParts.length >= 3) {
    const [first, second, third] = numericParts;
    try {
      const y1 = normalizeCalendarYear(first);
      const y3 = normalizeCalendarYear(third);
      if (y1 !== null && 1900 <= y1 && y1 <= 3000 && 1 <= second && second <= 12 && 1 <= third && third <= 31) {
        return new Date(y1, second - 1, third);
      }
      if (1 <= first && first <= 31 && 1 <= second && second <= 12 && y3 !== null && 1900 <= y3 && y3 <= 3000) {
        return new Date(y3, second - 1, first);
      }
    } catch { /* ignore */ }
  }

  const rawLower = cleaned.toLowerCase();
  let month: number | null = null;
  for (const [alias, aliasMonth] of Object.entries(MONTH_ALIASES)) {
    if (rawLower.includes(alias)) { month = aliasMonth; break; }
  }
  if (month === null) return null;

  let year: number | null = null;
  for (const num of numericParts) {
    const ny = normalizeCalendarYear(num);
    if (ny !== null && 1900 <= ny && ny <= 3000) { year = ny; break; }
  }
  if (year === null) {
    const ym = rawLower.match(/\b\d{4}\b/);
    if (ym) year = normalizeCalendarYear(parseInt(ym[0], 10));
  }
  if (year === null) return null;

  let day = 1;
  for (const num of numericParts) {
    const ny = normalizeCalendarYear(num);
    if (ny === year) continue;
    if (1 <= num && num <= 31) { day = num; break; }
  }

  try { return new Date(year, month - 1, day); } catch { return null; }
}

export function formatDisplayDate(value: unknown): string {
  const cleaned = decodeValue(value);
  if (!cleaned) return "UNKNOWN";
  const parsed = parseLocalizedDate(cleaned);
  if (parsed) {
    return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }
  return cleaned;
}

export function formatMemberSince(value: unknown): string {
  const cleaned = decodeValue(value);
  if (!cleaned) return "UNKNOWN";
  const parsed = parseLocalizedDate(cleaned);
  if (parsed) {
    return parsed.toLocaleDateString("en-US", { year: "numeric", month: "long" });
  }

  const numericParts = (cleaned.match(/\d+/g) || []).map(Number);
  if (numericParts.length >= 2) {
    try {
      const month = numericParts[0];
      const year = normalizeCalendarYear(numericParts[numericParts.length - 1]);
      if (year !== null && 1 <= month && month <= 12 && 1900 <= year && year <= 3000) {
        return new Date(year, month - 1, 1).toLocaleDateString("en-US", { year: "numeric", month: "long" });
      }
    } catch { /* ignore */ }
  }

  return cleaned;
}

export function normalizePhoneNumber(value: unknown, countryCode?: string | null): string | null {
  const cleaned = decodeValue(value);
  if (!cleaned) return null;
  if (String(cleaned).startsWith("+")) return cleaned;

  const digits = String(cleaned).replace(/\D+/g, "");
  if (!digits) return cleaned;

  const normalizedCountry = (decodeValue(countryCode) || "").trim().toUpperCase();
  const dialPrefixMap: Record<string, string> = { IN: "91" };
  const dialPrefix = dialPrefixMap[normalizedCountry];
  if (dialPrefix && digits.startsWith("0") && digits.length >= 10) {
    return `+${dialPrefix}${digits.replace(/^0+/, "")}`;
  }
  return cleaned;
}

export function countryCodeToFlag(countryCode: string | null): string {
  const raw = (decodeValue(countryCode) || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) {
    return String.fromCodePoint(...upper.split("").map((c) => 127397 + c.charCodeAt(0)));
  }

  const alpha3ToAlpha2: Record<string, string> = {
    PHL: "PH", IND: "IN", BHR: "BH", BRA: "BR", USA: "US", GBR: "GB",
    JPN: "JP", KOR: "KR", IDN: "ID", MYS: "MY", SGP: "SG", THA: "TH",
    VNM: "VN", ARE: "AE", SAU: "SA", QAT: "QA", KWT: "KW", OMN: "OM",
    CAN: "CA", AUS: "AU",
  };
  const mapped = alpha3ToAlpha2[upper];
  if (mapped && mapped.length === 2) {
    return String.fromCodePoint(...mapped.split("").map((c) => 127397 + c.charCodeAt(0)));
  }
  return "";
}

export function formatCountryWithFlag(countryValue: unknown, fallback = "UNKNOWN"): string {
  const normalized = normalizeOutputValue(countryValue, fallback);
  const flag = countryCodeToFlag(normalized);
  return flag ? `${normalized} ${flag}` : normalized;
}

export function normalizePlanKey(planName: string | null | undefined): string {
  if (!planName) return "unknown";
  // NFKD normalization - strip combining marks
  const simplified = planName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const normalized = simplified.toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

export function formatPlanLabel(planKey: string): string {
  if (!planKey) return "Unknown";
  const label = planKey.replace(/_/g, " ").trim();
  return label ? label.replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown";
}

export function intOrNull(value: unknown): number | null {
  const cleaned = decodeValue(value);
  if (cleaned === null) return null;
  const n = parseInt(String(cleaned).trim(), 10);
  if (!isNaN(n)) return n;
  const match = String(cleaned).match(/\d+/);
  if (match) return parseInt(match[0], 10);
  return null;
}

export function parseBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && !isNaN(value)) {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const key of ["value", "isUserOnHold", "holdStatus", "isOnHold", "pastDue", "isPastDue", "isVerified", "verified"]) {
      if (key in v) {
        const parsed = parseBooleanValue(v[key]);
        if (parsed !== null) return parsed;
      }
    }
    return null;
  }
  const cleaned = decodeValue(value);
  if (cleaned === null) return null;
  const lowered = String(cleaned).trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(lowered)) return true;
  if (["false", "no", "0", "off"].includes(lowered)) return false;
  return null;
}

export function formatBooleanLabel(value: unknown): string | null {
  const parsed = parseBooleanValue(value);
  if (parsed === true) return "Yes";
  if (parsed === false) return "No";
  return null;
}

export function extractFirstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return decodeValue(match[1]);
  }
  return null;
}

export function extractBoolValue(text: string, patterns: RegExp[]): string | null {
  const value = extractFirstMatch(text, patterns);
  if (value === null) return null;
  const parsed = formatBooleanLabel(value);
  if (parsed !== null) return parsed;
  return value;
}

export function escapeHtml(text: unknown): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const CANONICAL_PLAN_LABELS: Record<string, string> = {
  premium: "Premium",
  standard_with_ads: "Standard With Ads",
  standard: "Standard",
  basic: "Basic",
  mobile: "Mobile",
  extra_member_premium: "Premium (Extra Member)",
  free: "Free",
  duplicate: "Duplicate",
  unknown: "Unknown",
};

export function getCanonicalOutputLabelSafe(planKey: string): string {
  return CANONICAL_PLAN_LABELS[planKey] || "Unknown";
}

export function describeHttpError(statusCode: number): string {
  const descriptions: Record<number, string> = {
    403: "HTTP 403 Forbidden",
    429: "HTTP 429 Rate Limited",
    500: "HTTP 500 Server Error",
    502: "HTTP 502 Bad Gateway",
    503: "HTTP 503 Service Available",
    504: "HTTP 504 Gateway Timeout",
  };
  return descriptions[statusCode] || `HTTP ${statusCode}`;
}
