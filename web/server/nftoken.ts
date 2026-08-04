import type { NfTokenData } from "./types";
import { decodeValue } from "./utils";

const NFTOKEN_API_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48";
const NFTOKEN_QUERY_PARAMS: Record<string, string> = {
  appVersion: "15.48.1",
  config: '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
  device_type: "NFAPPL-02-",
  esn: "NFAPPL-02-IPHONE8%3D1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  idiom: "phone",
  iosVersion: "15.8.5",
  isTablet: "false",
  languages: "en-US",
  locale: "en-US",
  maxDeviceWidth: "375",
  model: "saget",
  modelType: "IPHONE8-1",
  odpAware: "true",
  path: '["account","token","default"]',
  pathFormat: "graph",
  pixelDensity: "2.0",
  progressive: "false",
  responseFormat: "json",
};

const NFTOKEN_HEADERS: Record<string, string> = {
  "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
  "x-netflix.request.attempt": "1",
  "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
  "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
  "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
  "x-netflix.context.app-version": "15.48.1",
  "x-netflix.argo.translated": "true",
  "x-netflix.context.form-factor": "phone",
  "x-netflix.context.sdk-version": "2012.4",
  "x-netflix.client.appversion": "15.48.1",
  "x-netflix.context.max-device-width": "375",
  "x-netflix.context.ab-tests": "",
  "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
  "x-netflix.client.type": "argo",
  "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  "x-netflix.context.locales": "en-US",
  "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
  "x-netflix.client.iosversion": "15.8.5",
  "accept-language": "en-US;q=1",
  "x-netflix.argo.abtests": "",
  "x-netflix.context.os-version": "15.8.5",
  "x-netflix.request.client.context": '{"appState":"foreground"}',
  "x-netflix.context.ui-flavor": "argo",
  "x-netflix.argo.nfnsm": "9",
  "x-netflix.context.pixel-density": "2.0",
  "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
  "x-netflix.request.client.timezoneid": "Asia/Dhaka",
};

function getNfTokenExpiryUtc(expires?: unknown): string {
  let normalized = decodeValue(expires);
  if (normalized && typeof normalized === "string") {
    normalized = normalized.trim();
    if (/^\d+$/.test(normalized)) {
      const ts = parseInt(normalized, 10);
      if (String(Math.abs(ts)).length === 13) {
        return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
      }
      return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    }
  }
  const future = new Date(Date.now() + 60 * 60 * 1000);
  return future.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function hasUsableNfToken(data: NfTokenData | null | undefined): boolean {
  if (!data || typeof data !== "object") return false;
  const token = decodeValue(data.token);
  if (!token) return false;
  const lowered = String(token).trim().toLowerCase();
  if (["unavailable", "unknown", "none", "null", "false"].includes(lowered)) return false;
  return true;
}

export async function createNfToken(
  cookieDict: Record<string, string>,
  attempts = 1,
  fetchFn: typeof fetch = fetch
): Promise<[NfTokenData | null, string | null]> {
  const netflixId = decodeValue(cookieDict["NetflixId"]);
  if (!netflixId) return [null, "Missing required cookies for NFToken"];

  const headers = { ...NFTOKEN_HEADERS, Cookie: `NetflixId=${netflixId}` };
  const maxAttempts = Math.max(1, attempts);
  let lastError = "NFToken API error";

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const url = new URL(NFTOKEN_API_URL);
      for (const [key, val] of Object.entries(NFTOKEN_QUERY_PARAMS)) {
        url.searchParams.set(key, val);
      }

      const response = await fetchFn(url.toString(), {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (response.status !== 200) {
        if (response.status === 403) lastError = "403";
        else if (response.status === 429) lastError = "429";
        else lastError = "NFToken API error";
        continue;
      }

      const data = await response.json() as any;
      const tokenData =
        ((data?.value?.account?.token?.default) || {});
      const token = decodeValue(tokenData.token);
      const expires = tokenData.expires;

      if (token) {
        return [{ token, expires_at_utc: getNfTokenExpiryUtc(expires) }, null];
      }
      lastError = "Token missing in response";
    } catch (err: any) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        lastError = "timeout";
      } else if (err?.code === "ECONNREFUSED" || err?.message?.includes("proxy")) {
        lastError = "proxy error";
      } else {
        lastError = "NFToken API error";
      }
    }
  }
  return [null, lastError];
}

export function buildNfTokenLinks(
  token: string,
  mode: string
): Array<[string, string]> {
  const normalizedToken = decodeValue(token);
  const normalizedMode = (mode || "false").trim().toLowerCase();
  if (!normalizedToken || normalizedMode === "false") return [];

  if (normalizedMode === "pc") {
    return [["🖥️ PC Login", `https://netflix.com/?nftoken=${normalizedToken}`]];
  }
  if (normalizedMode === "mobile") {
    return [["📱 Phone Login", `https://netflix.com/unsupported?nftoken=${normalizedToken}`]];
  }
  return [
    ["🖥️ PC Login", `https://netflix.com/?nftoken=${normalizedToken}`],
    ["📱 Phone Login", `https://netflix.com/unsupported?nftoken=${normalizedToken}`],
  ];
}

export function getNfTokenExpiryUnix(expiresAtUtc: string): number | null {
  const cleaned = decodeValue(expiresAtUtc);
  if (!cleaned) return null;
  try {
    const parsed = new Date(cleaned.replace(" UTC", "Z"));
    return Math.floor(parsed.getTime() / 1000);
  } catch {
    return null;
  }
}
