import type { AccountInfo } from "./types";
import {
  decodeValue,
  normalizePlanKey,
  formatBooleanLabel,
  getCanonicalOutputLabelSafe,
} from "./utils";

const PLAN_ALIASES: Record<string, Set<string>> = {
  premium: new Set([
    "premium", "premium_extra_member", "extra_member_premium", "cao_cap",
    "cao_cap_plan", "cao_c_ap", "cao_c_p", "caocap",
    "premium_plan", "ozel",
  ]),
  standard_with_ads: new Set([
    "standard_with_ads", "standardwithads", "estandar_con_anuncios",
    "estandarconanuncios", "padrao_com_anuncios", "standard_with_adverts",
    "standard_avec_pub", "standard_con_pubblicita", "standard_abo_mit_werbung",
  ]),
  standard: new Set([
    "standard", "estandar", "est_andar", "estandar_plan", "padrao",
    "standart", "standar", "tieuchuan", "tieu_chuan", "standaard",
    "standardni", "norma",
  ]),
  basic: new Set([
    "basic", "basic_with_ads", "basico", "dasar", "dasar_paket",
    "basico_con_anuncios", "basique", "basis", "temel", "podstawowy",
    "osnovni", "alap", "base", "essentiel", "asas", "co_ban",
  ]),
  mobile: new Set([
    "ponsel", "mobile", "seluler", "movil",
  ]),
};

export function derivePlanInfo(
  info: AccountInfo,
  isSubscribed: boolean
): [string, string] {
  const rawPlan = decodeValue(info.localizedPlanName);
  const rawQuality = decodeValue(info.videoQuality);
  const streams = parseInt(decodeValue(info.maxStreams) || "0", 10);

  if (!isSubscribed && !rawPlan) return ["free", "Free"];

  const normalized = rawPlan ? normalizePlanKey(rawPlan) : "";

  for (const [canonical, aliases] of Object.entries(PLAN_ALIASES)) {
    if (aliases.has(normalized)) {
      return [canonical, getCanonicalOutputLabelSafe(canonical)];
    }
  }

  if (!isNaN(streams)) {
    const qualityNorm = rawQuality ? normalizePlanKey(rawQuality) : "";
    if (streams >= 4 || ["uhd", "ultra_hd", "4k"].includes(qualityNorm)) {
      return ["premium", "Premium"];
    }
    if (streams >= 2 || ["hd", "full_hd"].includes(qualityNorm)) {
      return ["standard", "Standard"];
    }
    if (streams === 1) {
      if (["ponsel", "mobile"].includes(normalized)) return ["mobile", "Mobile"];
      return ["basic", "Basic"];
    }
  }

  if (rawPlan) return [normalizePlanKey(rawPlan), rawPlan];
  if (!isSubscribed) return ["free", "Free"];
  return ["unknown", "Unknown"];
}

export function isExtraMemberAccount(info: AccountInfo): boolean {
  const explicitFlag = decodeValue(info.isExtraMemberAccount);
  if (explicitFlag) {
    const lowered = explicitFlag.trim().toLowerCase();
    if (["yes", "true", "1"].includes(lowered)) return true;
    if (["no", "false", "0"].includes(lowered)) return false;
  }

  const candidates = [
    decodeValue(info.localizedPlanName) || "",
    decodeValue(info.membershipStatus) || "",
  ];

  const markers = [
    "extra member", "miembro extra", "suscriptor extra", "membro extra",
    "assinante extra", "abbonato extra", "abonne supplementaire",
    "abonné supplémentaire", "abonent extra", "abonado extra",
    "ekstra uye", "ekstra üye", "extra abonnee", "extra abonent",
    "membre supplementaire", "membre supplémentaire",
  ];

  const markersNormalized = [
    "extra_member", "miembro_extra", "suscriptor_extra", "membro_extra",
    "assinante_extra", "abbonato_extra", "abonne_supplementaire",
    "abonent_extra", "ekstra_uye", "extra_abonnee", "membre_supplementaire",
  ];

  for (const value of candidates) {
    if (!value) continue;
    const lowered = value.toLowerCase();
    const normalized = normalizePlanKey(value);
    const normalizedSpaced = normalized.replace(/_/g, " ");
    if (markers.some((m) => lowered.includes(m))) return true;
    if (markersNormalized.some((m) => normalized.includes(m))) return true;
    if (normalizedSpaced.includes("extra member")) return true;
  }
  return false;
}

export function isSubscribedAccount(info: AccountInfo): boolean {
  const status = normalizePlanKey(info.membershipStatus);
  if (status === "current_member") return true;
  return isExtraMemberAccount(info);
}

export function isOnHoldAccount(info: AccountInfo): boolean {
  const holdValue = formatBooleanLabel(info.holdStatus);
  if (holdValue !== null) return holdValue === "Yes";

  const membershipStatus = normalizePlanKey(info.membershipStatus);
  return ["hold", "past_due", "payment_retry", "paused", "suspend"].some((token) =>
    membershipStatus.includes(token)
  );
}

export function deriveOutputPlanBucket(
  info: AccountInfo,
  isSubscribed: boolean
): [string, string, string] {
  const [planKey, planName] = derivePlanInfo(info, isSubscribed);
  const folderLabel = getCanonicalOutputLabelSafe(planKey);
  const displayLabel = planName || folderLabel;

  if (isSubscribed && isExtraMemberAccount(info)) {
    const extraPlanKey = "extra_member_premium";
    const extraLabel = getCanonicalOutputLabelSafe(extraPlanKey);
    return [extraPlanKey, extraLabel, extraLabel];
  }

  return [planKey, folderLabel, displayLabel];
}
