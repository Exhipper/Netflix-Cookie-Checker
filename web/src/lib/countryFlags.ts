/**
 * Country name → ISO 3166-1 alpha-2 code mapping.
 * Used to render flag emojis from NFX country names.
 */
const COUNTRY_CODE_MAP: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "us": "US",
  "united kingdom": "GB",
  "uk": "GB",
  "great britain": "GB",
  "england": "GB",
  "brazil": "BR",
  "brasil": "BR",
  "india": "IN",
  "germany": "DE",
  "deutschland": "DE",
  "france": "FR",
  "canada": "CA",
  "mexico": "MX",
  "spain": "ES",
  "españa": "ES",
  "italy": "IT",
  "italia": "IT",
  "japan": "JP",
  "nippon": "JP",
  "australia": "AU",
  "netherlands": "NL",
  "nederland": "NL",
  "argentina": "AR",
  "south korea": "KR",
  "korea": "KR",
  "republic of korea": "KR",
  "turkey": "TR",
  "türkiye": "TR",
  "poland": "PL",
  "polska": "PL",
  "sweden": "SE",
  "sverige": "SE",
  "norway": "NO",
  "norge": "NO",
  "denmark": "DK",
  "danmark": "DK",
  "finland": "FI",
  "suomi": "FI",
  "belgium": "BE",
  "switzerland": "CH",
  "austria": "AT",
  "östereich": "AT",
  "portugal": "PT",
  "greece": "GR",
  "ellada": "GR",
  "ireland": "IE",
  "czech republic": "CZ",
  "cesko": "CZ",
  "czechia": "CZ",
  "romania": "RO",
  "românia": "RO",
  "hungary": "HU",
  "magyarország": "HU",
  "slovakia": "SK",
  "slovenia": "SI",
  "croatia": "HR",
  "hrvatska": "HR",
  "bulgaria": "BG",
  "serbia": "RS",
  "srbija": "RS",
  "lithuania": "LT",
  "latvia": "LV",
  "estonia": "EE",
  "eesti": "EE",
  "luxembourg": "LU",
  "iceland": "IS",
  "island": "IS",
  "israel": "IL",
  "saudi arabia": "SA",
  "uae": "AE",
  "united arab emirates": "AE",
  "egypt": "EG",
  "south africa": "ZA",
  "nigeria": "NG",
  "kenya": "KE",
  "morocco": "MA",
  "algeria": "DZ",
  "tunisia": "TN",
  "thailand": "TH",
  "philippines": "PH",
  "indonesia": "ID",
  "malaysia": "MY",
  "singapore": "SG",
  "vietnam": "VN",
  "viet nam": "VN",
  "taiwan": "TW",
  "hong kong": "HK",
  "china": "CN",
  "russia": "RU",
  "rossiya": "RU",
  "ukraine": "UA",
  "belarus": "BY",
  "kazakhstan": "KZ",
  "uzbekistan": "UZ",
  "chile": "CL",
  "colombia": "CO",
  "peru": "PE",
  "venezuela": "VE",
  "ecuador": "EC",
  "uruguay": "UY",
  "paraguay": "PY",
  "bolivia": "BO",
  "costa rica": "CR",
  "panama": "PA",
  "guatemala": "GT",
  "dominican republic": "DO",
  "puerto rico": "PR",
  "jamaica": "JM",
  "trinidad and tobago": "TT",
  "new zealand": "NZ",
  "qatar": "QA",
  "kuwait": "KW",
  "bahrain": "BH",
  "oman": "OM",
  "jordan": "JO",
  "lebanon": "LB",
  "iraq": "IQ",
  "iran": "IR",
  "afghanistan": "AF",
  "pakistan": "PK",
  "bangladesh": "BD",
  "sri lanka": "LK",
  "nepal": "NP",
  "maldives": "MV",
  "cyprus": "CY",
  "malta": "MT",
  "andorra": "AD",
  "monaco": "MC",
  "liechtenstein": "LI",
  "san marino": "SM",
  "vatican city": "VA",
  "montenegro": "ME",
  "north macedonia": "MK",
  "macedonia": "MK",
  "albania": "AL",
  "bosnia and herzegovina": "BA",
  "moldova": "MD",
  "georgia": "GE",
  "armenia": "AM",
  "azerbaijan": "AZ",
  "mongolia": "MN",
  "cambodia": "KH",
  "laos": "LA",
  "myanmar": "MM",
  "brunei": "BN",
  "fiji": "FJ",
  "papua new guinea": "PG",
  "ghana": "GH",
  "ethiopia": "ET",
  "tanzania": "TZ",
  "uganda": "UG",
  "zimbabwe": "ZW",
  "zambia": "ZM",
  "botswana": "BW",
  "namibia": "NA",
  "angola": "AO",
  "mozambique": "MZ",
  "cameroon": "CM",
  "ivory coast": "CI",
  "senegal": "SN",
};

/**
 * Convert a 2-letter ISO country code to a flag emoji using regional indicator symbols.
 */
function codeToFlag(code: string): string {
  const upper = code.toUpperCase();
  if (upper.length !== 2 || !/^[A-Z]{2}$/.test(upper)) return "";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + (upper.charCodeAt(0) - 65)) +
    String.fromCodePoint(A + (upper.charCodeAt(1) - 65));
}

/**
 * Get a flag emoji for a country name or ISO code.
 * Returns empty string if the country cannot be resolved.
 */
export function getCountryFlag(country: string | null | undefined): string {
  if (!country || typeof country !== "string") return "";
  const trimmed = country.trim();
  if (!trimmed) return "";

  // Direct 2-letter code
  if (/^[A-Za-z]{2}$/.test(trimmed) && trimmed.length === 2) {
    const flag = codeToFlag(trimmed);
    if (flag) return flag;
  }

  const lower = trimmed.toLowerCase();

  // Direct lookup
  if (COUNTRY_CODE_MAP[lower]) {
    return codeToFlag(COUNTRY_CODE_MAP[lower]);
  }

  // Try to find a partial match
  for (const key of Object.keys(COUNTRY_CODE_MAP)) {
    if (lower.includes(key) || key.includes(lower)) {
      return codeToFlag(COUNTRY_CODE_MAP[key]);
    }
  }

  return "";
}

/**
 * Render a country name with its flag emoji prefixed.
 * Falls back to just the country name if no flag is found.
 */
export function withFlag(country: string | null | undefined): string {
  if (!country) return "";
  const flag = getCountryFlag(country);
  return flag ? `${flag} ${country}` : country;
}
