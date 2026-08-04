import { ProxyAgent, fetch as undiciFetch } from "undici";
import { parseProxies, type ProxyFormatHint } from "./proxy.js";
import type { ProxyEntry } from "./types.js";

export interface ValidatedProxy {
  entry: ProxyEntry;
  ip: string;
  port: number;
  scheme: string;
  alive: boolean;
  lastChecked: number;
  failureCount: number;
  /** Host:port string used as a unique key. */
  key: string;
}

interface ProxySource {
  url: string;
  /** Refresh interval in hours. Staggered so sources refresh at different times. */
  intervalHours: number;
  /** How to parse the proxy list body. */
  formatHint?: ProxyFormatHint;
  enabled: boolean;
}

const VALIDATION_TIMEOUT_MS = 8000;
const VALIDATION_URL = "https://httpbin.org/ip";
const MAX_FAILURES = 3; // mark dead after 3 consecutive failures
const TARGET_VALIDATED = 300; // stop validating once we have enough live proxies

// Memory-safe tuning: free proxy lists can be huge, so we cap everything.
const FETCH_CONCURRENCY = 5; // fetch sources in small batches
const MAX_SOURCE_BODY_BYTES = 1024 * 1024; // 1 MB cap per source response
const MAX_ENTRIES_PER_SOURCE = 150; // parse at most this many proxies from one source
const MAX_TOTAL_PARSED = 4000; // total unique candidates to validate across all sources
const VALIDATION_CONCURRENCY = 16; // lower than before to reduce heap pressure
const MAX_POOL_SIZE = 600; // keep the validated pool from growing forever

let validatedPool: ValidatedProxy[] = [];
let currentIndex = 0;
let isFetching = false;
let sourceTimers: Map<string, NodeJS.Timeout> = new Map();
const textDecoder = new TextDecoder();

/** Expand date templates in proxy URLs (e.g. {YYYY}, {MM}, {DD}, {HH/4}). */
function expandDateTemplates(url: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const hour = now.getUTCHours();
  const hourBlock = Math.floor(hour / 4) * 4;

  const pad2 = (n: number) => String(n).padStart(2, "0");

  return url
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{YY\}/g, String(year).slice(-2))
    .replace(/\{MM\}/g, pad2(month))
    .replace(/\{M\}/g, String(month))
    .replace(/\{DD\}/g, pad2(day))
    .replace(/\{D\}/g, String(day))
    .replace(/\{HH\}/g, pad2(hour))
    .replace(/\{H\}/g, String(hour))
    .replace(/\{HH\/4\}/g, pad2(hourBlock));
}

// Proxy sources with staggered refresh intervals. Reliable/high-volume lists get shorter
// intervals (1-2h), smaller/more volatile lists get longer intervals (3-6h).
const PROXY_SOURCES: ProxySource[] = [
  // High-volume / reliable — refresh frequently
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/all.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", intervalHours: 2, enabled: false },
  { url: "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt", intervalHours: 1, enabled: true },
  { url: "https://raw.githubusercontent.com/andigwandi/free-proxy/main/proxy_list.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/master/proxy_list.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/refs/heads/master/proxy_list.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/MrMarble/proxy-list/main/all.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/SevenworksDev/proxy-list/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/SevenworksDev/proxy-list/main/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/SevenworksDev/proxy-list/main/proxies/unknown.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/TuanMinPay/live-proxy/master/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/TuanMinPay/live-proxy/master/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/Tsprnay/Proxy-lists/master/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Tsprnay/Proxy-lists/master/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Tsprnay/Proxy-lists/master/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/officialputuid/KangProxy/refs/heads/KangProxy/http/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/officialputuid/KangProxy/refs/heads/KangProxy/https/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/officialputuid/KangProxy/refs/heads/KangProxy/sock4/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Vann-Dev/proxy-list/main/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/r00tee/Proxy-List/main/Https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/r00tee/Proxy-List/main/Socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/noarche/proxylist-socks5-sock4-exported-updates/main/http-online.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/noarche/proxylist-socks5-sock4-exported-updates/main/socks4-online.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/noarche/proxylist-socks5-sock4-exported-updates/main/connect-online.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ArteffKod/socks4/main/socks4%20proxy", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/gitrecon1455/fresh-proxy-list/refs/heads/main/proxylist.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/im-razn/proxy_list/main/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/KUTlime/ProxyList/main/ProxyList.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/dinoz0rg/proxy-list/main/scraped_proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/dinoz0rg/proxy-list/raw/refs/heads/main/scraped_proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/dinoz0rg/proxy-list/main/scraped_proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/zebbern/Proxy-Scraper/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/zebbern/Proxy-Scraper/main/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/zebbern/Proxy-Scraper/main/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxies/unchecked.txt", intervalHours: 3, enabled: true },
  { url: "https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/javadbazokar/PROXY-List/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/javadbazokar/PROXY-List/main/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/vmheaven/VMHeaven-Free-Proxy-Updated/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/vmheaven/VMHeaven-Free-Proxy-Updated/main/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/vmheaven/VMHeaven-Free-Proxy-Updated/main/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/saisuiu/Lionkings-Http-Proxys-Proxies/refs/heads/main/free.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/FifzzSENZE/Master-Proxy/master/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/FifzzSENZE/Master-Proxy/master/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/FifzzSENZE/Master-Proxy/master/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/fyvri/fresh-proxy-list/archive/storage/classic/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/fyvri/fresh-proxy-list/archive/storage/classic/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/fyvri/fresh-proxy-list/archive/storage/classic/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://github.com/handeveloper1/Proxy/raw/refs/heads/main/Proxies-Ercin/http.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/handeveloper1/Proxy/raw/refs/heads/main/Proxies-Ercin/https.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/handeveloper1/Proxy/raw/refs/heads/main/Proxies-Ercin/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://github.com/Anonym0usWork1221/Free-Proxies/raw/refs/heads/main/proxy_files/http_proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/Anonym0usWork1221/Free-Proxies/raw/refs/heads/main/proxy_files/https_proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/Anonym0usWork1221/Free-Proxies/raw/refs/heads/main/proxy_files/socks4_proxies.txt", intervalHours: 3, enabled: false },
  { url: "https://github.com/zenjahid/FreeProxy4u/raw/refs/heads/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/zenjahid/FreeProxy4u/raw/refs/heads/main/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/casals-ar/proxy-list/refs/heads/main/http", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/casals-ar/proxy-list/refs/heads/main/socks4", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/BreakingTechFr/Proxy_Free/refs/heads/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/BreakingTechFr/Proxy_Free/refs/heads/main/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/VolkanSah/Auto-Proxy-Fetcher/refs/heads/main/proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/databay-labs/free-proxy-list/refs/heads/master/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/databay-labs/free-proxy-list/refs/heads/master/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/refs/heads/main/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/refs/heads/main/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/variableninja/proxyscraper/refs/heads/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/variableninja/proxyscraper/refs/heads/main/proxies/socks.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/berkay-digital/Proxy-Scraper/refs/heads/main/proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/iniridwanul/Hoot/refs/heads/master/proxylist/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/iniridwanul/Hoot/refs/heads/master/proxylist/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/iniridwanul/Hoot/refs/heads/master/anonymous-proxylist/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/iniridwanul/Hoot/refs/heads/master/anonymous-proxylist/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://github.com/XigmaDev/proxy/raw/refs/heads/main/proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/chekamarue/proxies/raw/refs/heads/main/https.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/chekamarue/proxies/raw/refs/heads/main/httpss.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/claude89757/free_https_proxies/raw/refs/heads/main/https_proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/claude89757/free_https_proxies/raw/refs/heads/main/isz_https_proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/joy-deploy/free-proxy-list/refs/heads/main/data/latest/types/http/proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/joy-deploy/free-proxy-list/refs/heads/main/data/latest/types/https/proxies.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/joy-deploy/free-proxy-list/refs/heads/main/data/latest/types/socks4/proxies.txt", intervalHours: 3, enabled: false },
  // Date-templated sources
  { url: "https://raw.githubusercontent.com/joy-deploy/free-proxy-list/refs/heads/main/data/{YYYY}-{MM}/{DD}/{HH/4}-00/proxies.txt", intervalHours: 1, enabled: true },
  { url: "https://a.nodeshare.xyz/uploads/{YYYY}/{M}/{YYYY}{MM}{DD}.txt", intervalHours: 2, enabled: true },
  // Third-party APIs / miscellaneous
  { url: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=ipport&format=text&timeout=20000", intervalHours: 2, enabled: true },
  { url: "https://proxyspace.pro/http.txt", intervalHours: 2, enabled: true },
  { url: "https://rootjazz.com/proxies/proxies.txt", intervalHours: 3, enabled: true },
  { url: "https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/http-proxy-list-by-EbraSha.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/https-proxy-list-by-EbraSha.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/socks4-proxy-list-by-EbraSha.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/casa-ls/proxy-list/refs/heads/main/http", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/casa-ls/proxy-list/refs/heads/main/socks4", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/jetkai/proxy-list/refs/heads/main/online-proxies/txt/proxies-http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/jetkai/proxy-list/refs/heads/main/online-proxies/txt/proxies-https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/jetkai/proxy-list/refs/heads/main/online-proxies/txt/proxies-socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://github.com/Thordata/awesome-free-proxy-list/raw/refs/heads/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/Thordata/awesome-free-proxy-list/raw/refs/heads/main/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/Thordata/awesome-free-proxy-list/raw/refs/heads/main/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://github.com/proxygenerator1/ProxyGenerator/raw/refs/heads/main/Stable/http.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/proxygenerator1/ProxyGenerator/raw/refs/heads/main/Stable/https.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/proxygenerator1/ProxyGenerator/raw/refs/heads/main/Stable/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://github.com/proxygenerator1/ProxyGenerator/raw/refs/heads/main/Unstable/http.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/proxygenerator1/ProxyGenerator/raw/refs/heads/main/Unstable/https.txt", intervalHours: 2, enabled: true },
  { url: "https://github.com/proxygenerator1/ProxyGenerator/raw/refs/heads/main/Unstable/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_all.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_ssl.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_nossl.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_elite.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_anonymous.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_transparent.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_ssl_elite.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_ssl_anonymous.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/socks4_all.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/elliottophellia/proxylist/master/results/pmix_checked.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/fahimscirex/proxybd/refs/heads/master/proxylist/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/fahimscirex/proxybd/refs/heads/master/proxylist/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/parserpp/ip_ports/refs/heads/main/proxyinfo.txt", intervalHours: 2, enabled: true, formatHint: "space" },
  { url: "https://github.com/6Kmfi6HP/proxy_files/raw/refs/heads/main/proxies.txt", intervalHours: 2, enabled: true, formatHint: "space" },
  { url: "https://github.com/murtaja89/public-proxies/raw/refs/heads/main/proxies_all.txt", intervalHours: 2, enabled: true, formatHint: "space" },
  { url: "https://github.com/andigwandi/free-proxy/raw/refs/heads/main/proxy_list.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Firmfox/Proxify/refs/heads/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Firmfox/Proxify/refs/heads/main/proxies/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Firmfox/Proxify/refs/heads/main/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/Vadim287/free-proxy/refs/heads/main/proxies/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/Vadim287/free-proxy/refs/heads/main/proxies/socks4.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", intervalHours: 3, enabled: false },
  { url: "https://raw.githubusercontent.com/fyvri/fresh-proxy-list/archive/storage/classic/http.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/fyvri/fresh-proxy-list/archive/storage/classic/https.txt", intervalHours: 2, enabled: true },
  { url: "https://raw.githubusercontent.com/fyvri/fresh-proxy-list/archive/storage/classic/socks4.txt", intervalHours: 3, enabled: false },
];

/** Extract IP and port from a ProxyEntry. */
function extractIpPort(entry: ProxyEntry): { ip: string; port: number; scheme: string } {
  const url = entry.https || entry.http;
  try {
    const parsed = new URL(url);
    return {
      ip: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: parseInt(parsed.port, 10) || 0,
      scheme: parsed.protocol.replace(":", ""),
    };
  } catch {
    const match = url.match(/^(?:(\w+):\/\/)?(?:[^@]*@)?\[?([^\]:]+)\]?:(\d+)/);
    if (match) {
      return { ip: match[2], port: parseInt(match[3], 10), scheme: match[1] || "http" };
    }
    return { ip: "unknown", port: 0, scheme: "http" };
  }
}

/** Build a dispatcher (ProxyAgent) for a validated proxy. */
function createDispatcher(proxy: ValidatedProxy): ProxyAgent | null {
  try {
    const proxyUrl = proxy.entry.https || proxy.entry.http;
    return new ProxyAgent(proxyUrl);
  } catch {
    return null;
  }
}

/** Validate a single proxy by making a test request through it. */
async function validateProxy(entry: ProxyEntry): Promise<ValidatedProxy | null> {
  const { ip, port, scheme } = extractIpPort(entry);
  if (!ip || ip === "unknown" || !port) return null;

  const key = `${ip}:${port}`;
  const proxyUrl = entry.https || entry.http;

  try {
    const dispatcher = new ProxyAgent(proxyUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

    const response = await undiciFetch(VALIDATION_URL, {
      dispatcher,
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0" },
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      return {
        entry,
        ip,
        port,
        scheme,
        alive: true,
        lastChecked: Date.now(),
        failureCount: 0,
        key,
      } as ValidatedProxy;
    }
    return null;
  } catch {
    return null;
  }
}

/** Validate a list of proxy entries using a worker pool with limited concurrency. Stops once target count is reached. */
async function validateWithConcurrency(
  entries: ProxyEntry[],
  concurrency: number,
  target: number
): Promise<ValidatedProxy[]> {
  const validated: ValidatedProxy[] = [];
  const inFlight = new Set<Promise<void>>();
  let queueIndex = 0;

  const spawnNext = () => {
    if (queueIndex >= entries.length || validated.length >= target) return;
    const entry = entries[queueIndex++];
    const promise = validateProxy(entry).then((result) => {
      if (result && validated.length < target) {
        validated.push(result);
      }
    }).finally(() => {
      inFlight.delete(promise);
      spawnNext();
    });
    inFlight.add(promise);
  };

  // Seed the worker pool
  const seedCount = Math.min(concurrency, entries.length);
  for (let i = 0; i < seedCount; i++) spawnNext();

  await Promise.all(inFlight);
  return validated;
}

/** Fetch a single proxy source and return parsed entries. Response body is streamed with a byte cap. */
async function fetchSource(source: ProxySource): Promise<ProxyEntry[]> {
  const url = expandDateTemplates(source.url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await undiciFetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[proxy-manager] Source failed ${response.status}: ${url}`);
      return [];
    }

    if (!response.body) {
      const text = await response.text();
      return parseProxies(text, source.formatHint || "default", MAX_ENTRIES_PER_SOURCE);
    }

    const reader = response.body.getReader();
    let buffer = "";
    let readBytes = 0;
    let done = false;

    while (!done && readBytes < MAX_SOURCE_BODY_BYTES) {
      const { value, done: d } = await reader.read();
      done = d || false;
      if (value && value.length > 0) {
        readBytes += value.byteLength;
        buffer += textDecoder.decode(value, { stream: !done });
      }
    }

    if (!done) {
      reader.cancel().catch(() => {});
    }
    // Flush any remaining decoder state
    buffer += textDecoder.decode();

    return parseProxies(buffer, source.formatHint || "default", MAX_ENTRIES_PER_SOURCE);
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn(`[proxy-manager] Source timeout: ${url}`);
    } else {
      console.warn(`[proxy-manager] Source error: ${url}`, err?.message || err);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Fetch and validate proxies from all enabled remote sources, throttled and capped. */
export async function fetchAndValidateProxies(): Promise<ValidatedProxy[]> {
  if (isFetching) return validatedPool;
  isFetching = true;

  try {
    const enabledSources = PROXY_SOURCES.filter((s) => s.enabled);
    const allEntries: ProxyEntry[] = [];
    const seenKeys = new Set<string>();

    for (let i = 0; i < enabledSources.length; i += FETCH_CONCURRENCY) {
      const batch = enabledSources.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((source) => fetchSource(source)));

      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        if (result.status === "rejected") {
          console.warn(`[proxy-manager] Failed source ${batch[j].url}: ${result.reason}`);
          continue;
        }
        for (const entry of result.value) {
          if (allEntries.length >= MAX_TOTAL_PARSED) break;
          const { ip, port } = extractIpPort(entry);
          const key = `${ip}:${port}`;
          if (!key || key.includes("unknown") || seenKeys.has(key)) continue;
          seenKeys.add(key);
          allEntries.push(entry);
        }
      }

      if (allEntries.length >= MAX_TOTAL_PARSED) break;
    }

    if (allEntries.length === 0) {
      console.warn("[proxy-manager] No proxies parsed from remote sources");
      return validatedPool;
    }

    console.log(`[proxy-manager] Parsed ${allEntries.length} unique proxy candidates from ${enabledSources.length} sources, validating with ${VALIDATION_CONCURRENCY} threads...`);

    const validated = await validateWithConcurrency(allEntries, VALIDATION_CONCURRENCY, TARGET_VALIDATED);

    console.log(`[proxy-manager] Validated ${validated.length} live proxies`);

    const existingKeys = new Set(validated.map((v) => v.key));
    validatedPool = [...validated, ...validatedPool.filter((v) => v.alive && !existingKeys.has(v.key))];
    prunePool();

    return validatedPool;
  } catch (err) {
    console.error("[proxy-manager] Fetch/validate error:", err);
    return validatedPool;
  } finally {
    isFetching = false;
  }
}

/** Keep only alive proxies and cap total pool size. */
function prunePool(): void {
  validatedPool = validatedPool
    .filter((p) => p.alive)
    .sort((a, b) => b.lastChecked - a.lastChecked)
    .slice(0, MAX_POOL_SIZE);
}

/** Schedule a single source to refresh at its configured interval. */
function scheduleSource(source: ProxySource): void {
  if (!source.enabled) return;
  const url = expandDateTemplates(source.url);
  const intervalMs = source.intervalHours * 60 * 60 * 1000;
  const jitter = Math.floor(Math.random() * Math.min(intervalMs, 5 * 60 * 1000)); // up to 5 min jitter

  const run = async () => {
    try {
      const needed = Math.max(0, TARGET_VALIDATED - validatedPool.filter((p) => p.alive).length);
      if (needed <= 0) return;

      const entries = await fetchSource(source);
      if (entries.length === 0) return;

      const existingKeys = new Set(validatedPool.map((p) => p.key));
      const newEntries = entries
        .map((e) => {
          const { ip, port } = extractIpPort(e);
          return { key: `${ip}:${port}`, entry: e };
        })
        .filter((e) => e.key && !e.key.includes("unknown") && !existingKeys.has(e.key))
        .map((e) => e.entry)
        .slice(0, MAX_ENTRIES_PER_SOURCE);

      if (newEntries.length === 0) return;

      const validated = await validateWithConcurrency(newEntries, VALIDATION_CONCURRENCY, needed);
      const newKeys = new Set(validated.map((v) => v.key));
      validatedPool = [...validatedPool.filter((p) => p.alive && !newKeys.has(p.key)), ...validated];
      prunePool();
      console.log(`[proxy-manager] Source ${url} added ${validated.length} live proxies (needed ${needed})`);
    } catch (err) {
      console.error(`[proxy-manager] Scheduled source error ${url}:`, err);
    } finally {
      sourceTimers.set(url, setTimeout(run, intervalMs));
    }
  };

  // Wait a full interval before the first scheduled refresh to avoid a startup burst.
  sourceTimers.set(url, setTimeout(run, intervalMs + jitter));
}

/** Start the auto-fetch background loop. Each source refreshes on its own schedule. */
export function startProxyAutoFetch(): void {
  if (sourceTimers.size > 0) return;

  // Initial bulk fetch is throttled and memory-capped.
  fetchAndValidateProxies().catch((err) =>
    console.error("[proxy-manager] Initial fetch error:", err)
  );

  // Schedule individual source refreshes with staggered intervals.
  for (const source of PROXY_SOURCES) {
    scheduleSource(source);
  }
}

/** Stop all auto-fetch loops. */
export function stopProxyAutoFetch(): void {
  for (const timer of sourceTimers.values()) {
    clearTimeout(timer);
  }
  sourceTimers.clear();
}

/** Get the current proxy pool status. */
export function getProxyPoolStatus(): {
  total: number;
  alive: number;
  dead: number;
  lastFetch: number | null;
  isFetching: boolean;
} {
  return {
    total: validatedPool.length,
    alive: validatedPool.filter((p) => p.alive).length,
    dead: validatedPool.filter((p) => !p.alive).length,
    lastFetch: validatedPool.length > 0 ? Math.max(...validatedPool.map((p) => p.lastChecked)) : null,
    isFetching,
  };
}

/** Get the next alive proxy in round-robin order. */
export function getNextProxy(): ValidatedProxy | null {
  if (validatedPool.length === 0) return null;

  const alive = validatedPool.filter((p) => p.alive);
  if (alive.length === 0) return null;

  const proxy = alive[currentIndex % alive.length];
  currentIndex = (currentIndex + 1) % alive.length;
  return proxy;
}

/** Mark a proxy as failed. */
export function markProxyFailed(key: string): void {
  const proxy = validatedPool.find((p) => p.key === key);
  if (proxy) {
    proxy.failureCount++;
    if (proxy.failureCount >= MAX_FAILURES) {
      proxy.alive = false;
      console.log(`[proxy-manager] Proxy ${key} marked dead after ${proxy.failureCount} failures`);
    }
  }
}

/** Mark a proxy as successfully used. */
export function markProxySuccess(key: string): void {
  const proxy = validatedPool.find((p) => p.key === key);
  if (proxy) {
    proxy.failureCount = 0;
    proxy.lastChecked = Date.now();
  }
}

/** Get a dispatcher for a validated proxy. */
export function getDispatcher(proxy: ValidatedProxy): ProxyAgent | null {
  return createDispatcher(proxy);
}

/**
 * Fetch a URL through a validated proxy. Automatically rotates to the next alive
 * proxy if the current one fails.
 */
export async function fetchThroughProxy(
  url: string,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxProxyRetries?: number;
  } = {}
): Promise<{ text: string; status: number; proxyIp: string | null; proxyKey: string | null }> {
  const maxRetries = options.maxProxyRetries ?? 5;
  const timeoutMs = options.timeoutMs ?? 15000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const proxy = getNextProxy();
    if (!proxy) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        if (options.signal) {
          options.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        const response = await undiciFetch(url, {
          method: "GET",
          headers: options.headers || {},
          signal: controller.signal,
          redirect: "manual" as any,
        });
        clearTimeout(timeoutId);
        const text = await response.text();
        return { text, status: response.status, proxyIp: null, proxyKey: null };
      } catch (err: any) {
        if (err?.name === "AbortError") {
          return { text: "", status: 0, proxyIp: null, proxyKey: null };
        }
        throw err;
      }
    }

    const dispatcher = createDispatcher(proxy);
    if (!dispatcher) {
      markProxyFailed(proxy.key);
      continue;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      if (options.signal) {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      const response = await undiciFetch(url, {
        method: "GET",
        headers: options.headers || {},
        signal: controller.signal,
        dispatcher,
        redirect: "manual" as any,
      });
      clearTimeout(timeoutId);

      const text = await response.text();
      markProxySuccess(proxy.key);
      return { text, status: response.status, proxyIp: proxy.ip, proxyKey: proxy.key };
    } catch (err: any) {
      markProxyFailed(proxy.key);
      if (err?.name === "AbortError" && options.signal?.aborted) {
        return { text: "", status: 0, proxyIp: proxy.ip, proxyKey: proxy.key };
      }
      continue;
    }
  }

  // All proxies exhausted
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const response = await undiciFetch(url, {
      method: "GET",
      headers: options.headers || {},
      signal: controller.signal,
      redirect: "manual" as any,
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    return { text, status: response.status, proxyIp: null, proxyKey: null };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { text: "", status: 0, proxyIp: null, proxyKey: null };
    }
    return { text: "", status: 0, proxyIp: null, proxyKey: null };
  }
}

/** Trigger an immediate proxy refetch across all sources. */
export async function refreshProxies(): Promise<{ fetched: number; alive: number }> {
  await fetchAndValidateProxies();
  return {
    fetched: validatedPool.length,
    alive: validatedPool.filter((p) => p.alive).length,
  };
}
