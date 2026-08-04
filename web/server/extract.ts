import type { AccountInfo } from "./types.js";
import {
  decodeValue,
  extractFirstMatch,
  extractBoolValue,
  formatBooleanLabel,
  normalizePlanKey,
  normalizePhoneNumber,
} from "./utils.js";

function extractProfileNames(text: string): string | null {
  const names: string[] = [];
  const patterns = [
    /"profileName"\s*:\s*"([^"]+)"/g,
    /"profileName"\s*:\s*\{\s*"fieldType"\s*:\s*"String"\s*,\s*"value"\s*:\s*"([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const decoded = decodeValue(match[1]);
      if (decoded && !names.includes(decoded)) names.push(decoded);
    }
  }

  // GraphQL Profile typename pattern
  const typenameRegex = /"__typename"\s*:\s*"Profile"/g;
  let tm: RegExpExecArray | null;
  while ((tm = typenameRegex.exec(text)) !== null) {
    const snippet = text.slice(tm.index, tm.index + 1200);
    const nameMatch = snippet.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch) {
      const decoded = decodeValue(nameMatch[1]);
      if (decoded && !names.includes(decoded)) names.push(decoded);
    }
  }

  if (!names.length) return null;
  return names.join(", ");
}

function hasCompleteAccountInfo(info: AccountInfo | null): boolean {
  if (!info) return false;
  const required = ["countryOfSignup", "membershipStatus", "localizedPlanName", "maxStreams", "videoQuality"];
  return required.every((f) => {
    const val = (info as any)[f];
    return val && val !== "null";
  });
}

function extractInfoFromGraphqlPayload(text: string): AccountInfo {
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return {};
  }
  if (!payload || typeof payload !== "object") return {};

  const data = payload.data;
  if (!data || typeof data !== "object") return {};

  const growthAccount = data.growthAccount || {};
  const currentProfile = data.currentProfile || {};
  const currentPlan = (growthAccount.currentPlan || {}).plan || {};
  const nextPlan = (growthAccount.nextPlan || {}).plan || {};
  const nextBilling = growthAccount.nextBillingDate || {};
  const holdMeta = growthAccount.growthHoldMetadata || {};
  const localPhone = growthAccount.growthLocalizablePhoneNumber || {};
  const rawPhone = localPhone.rawPhoneNumber || {};
  const paymentMethods = growthAccount.growthPaymentMethods || [];
  const paymentMethod = paymentMethods[0] && typeof paymentMethods[0] === "object" ? paymentMethods[0] : {};
  const paymentLogo = (paymentMethod.paymentOptionLogo || {}).paymentOptionLogo;
  const paymentTypename = String(paymentMethod.__typename || "");
  const paymentDisplayText = decodeValue(paymentMethod.displayText);
  const profiles = growthAccount.profiles || [];

  let phoneDigits: string | null = null;
  let phoneVerifiedGraphql: string | null = null;
  let phoneCountryCode: string | null = null;
  if (rawPhone && typeof rawPhone === "object") {
    const phoneDigitsObj = rawPhone.phoneNumberDigits || {};
    phoneDigits = typeof phoneDigitsObj === "object" ? phoneDigitsObj.value : rawPhone.phoneNumberDigits;
    phoneVerifiedGraphql = rawPhone.isVerified;
    phoneCountryCode = rawPhone.countryCode;
  } else {
    phoneDigits = rawPhone;
  }

  function growthEmail(profileObj: any): [string | null, string | null] {
    if (!profileObj || typeof profileObj !== "object") return [null, null];
    const gEmail = profileObj.growthEmail || {};
    const emailObj = gEmail.email || {};
    const emailValue = typeof emailObj === "object" ? emailObj.value : null;
    return [emailValue, gEmail.isVerified];
  }

  let [emailValue, emailVerified] = growthEmail(currentProfile);
  if (!emailValue) {
    for (const profile of profiles) {
      [emailValue, emailVerified] = growthEmail(profile);
      if (emailValue) break;
    }
  }

  const profileNames: string[] = [];
  for (const profile of profiles) {
    if (profile && typeof profile === "object") {
      const name = decodeValue(profile.name);
      if (name && !profileNames.includes(name)) profileNames.push(name);
    }
  }

  const featureTypes: string[] = [];
  for (const planObj of [currentPlan, nextPlan]) {
    for (const feature of (planObj.availableFeatures || [])) {
      if (feature && typeof feature === "object" && feature.type) {
        featureTypes.push(String(feature.type).toUpperCase());
      }
    }
  }

  function extractPriceValue(planObj: any): string | null {
    if (!planObj || typeof planObj !== "object") return null;
    const directCandidates = [
      planObj.priceDisplay, planObj.displayPrice, planObj.formattedPrice,
      planObj.formattedPlanPrice, planObj.planPriceDisplay,
    ];
    for (const c of directCandidates) {
      const decoded = decodeValue(c);
      if (decoded) return decoded;
    }
    const priceObj = planObj.price;
    if (priceObj && typeof priceObj === "object") {
      for (const key of ["displayValue", "formatted", "formattedPrice", "displayPrice", "value", "amountDisplay"]) {
        const decoded = decodeValue(priceObj[key]);
        if (decoded) return decoded;
      }
    }
    return null;
  }

  const holdStatus = [holdMeta.isUserOnHold, holdMeta.holdStatus, holdMeta.isOnHold, holdMeta.pastDue,
    growthAccount.isUserOnHold, growthAccount.holdStatus, growthAccount.isOnHold,
    growthAccount.pastDue, growthAccount.isPastDue]
    .map((v) => formatBooleanLabel(v))
    .find((v) => v !== null && v !== undefined) || null;

  const info: AccountInfo = {
    accountOwnerName: decodeValue(currentProfile.name),
    email: decodeValue(emailValue),
    countryOfSignup: decodeValue((growthAccount.countryOfSignUp || {}).code),
    memberSince: decodeValue(growthAccount.memberSince),
    nextBillingDate: decodeValue(nextBilling.localDate || nextBilling.date),
    userGuid: decodeValue(growthAccount.ownerGuid || currentProfile.guid),
    showExtraMemberSection: featureTypes.includes("EXTRA_MEMBER") ? "Yes" : (featureTypes.length ? "No" : null),
    membershipStatus: decodeValue(growthAccount.membershipStatus),
    localizedPlanName: decodeValue(currentPlan.name || nextPlan.name),
    planPrice: extractPriceValue(currentPlan) || extractPriceValue(nextPlan),
    paymentMethodType: decodeValue(paymentLogo || growthAccount.payer),
    maskedCard: null,
    phoneNumber: normalizePhoneNumber(phoneDigits, phoneCountryCode),
    videoQuality: decodeValue(currentPlan.videoQuality),
    holdStatus,
    emailVerified: formatBooleanLabel(emailVerified),
    phoneVerified: formatBooleanLabel(phoneVerifiedGraphql),
    profiles: profileNames.length ? profileNames.join(", ") : null,
  };

  if (paymentTypename.includes("Card")) {
    info.paymentMethodType = "CC";
    if (paymentDisplayText) {
      info.maskedCard = paymentDisplayText;
    }
  } else if (paymentDisplayText && !paymentLogo && !/^\d{4}$/.test(paymentDisplayText)) {
    info.paymentMethodType = info.paymentMethodType || paymentDisplayText;
  }

  if (!info.paymentMethodType && paymentMethods.length && paymentTypename.includes("Card")) {
    info.paymentMethodType = "CC";
  }

  // Strip null/empty values
  const result: AccountInfo = {};
  for (const [key, value] of Object.entries(info)) {
    if (value !== null && value !== "" && value !== undefined) {
      (result as any)[key] = value;
    }
  }
  return result;
}

function mergeInfo(primary: AccountInfo | null, fallback: AccountInfo | null): AccountInfo {
  const merged: AccountInfo = { ...(fallback || {}) };
  for (const [key, value] of Object.entries(primary || {})) {
    if (value !== null && value !== "" && value !== undefined) {
      (merged as any)[key] = value;
    }
  }
  return merged;
}

export function extractInfo(text: string): AccountInfo {
  const graphqlInfo = extractInfoFromGraphqlPayload(text);

  const extraMemberPatterns = [
    /assinante\s+extra\s+no\s+plano\s+de\s+outra\s+pessoa/i,
    /suscriptor\s+extra\s+en\s+el\s+plan\s+de\s+otra\s+persona/i,
    /extra\s+on\s+someone.?else.?s\s+plan/i,
  ];
  const isExtraMemberByText = extraMemberPatterns.some((p) => p.test(text));

  let extracted: AccountInfo;
  if (hasCompleteAccountInfo(graphqlInfo)) {
    extracted = { ...graphqlInfo };
  } else {
    extracted = {
      accountOwnerName: extractFirstMatch(text, [
        /userInfo"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/,
        /"accountOwnerName"\s*:\s*"([^"]+)"/,
        /"name"\s*:\s*\{\s*"fieldType"\s*:\s*"String"\s*,\s*"value"\s*:\s*"([^"]+)"/,
        /"firstName"\s*:\s*"([^"]+)"/,
      ]),
      email: extractFirstMatch(text, [
        /"emailAddress"\s*:\s*"([^"]+)"/,
        /"email"\s*:\s*"([^"]+)"/,
        /"loginId"\s*:\s*"([^"]+)"/,
      ]),
      countryOfSignup: extractFirstMatch(text, [
        /"currentCountry"\s*:\s*"([^"]+)"/,
        /"countryOfSignup":\s*"([^"]+)"/,
      ]),
      memberSince: extractFirstMatch(text, [/"memberSince":\s*"([^"]+)"/]),
      nextBillingDate: extractFirstMatch(text, [
        /"GrowthNextBillingDate"\s*,\s*"date"\s*:\s*"([^"T]+)T/,
        /"nextBillingDate"\s*:\s*"([^"]+)"/,
      ]),
      userGuid: extractFirstMatch(text, [/"userGuid":\s*"([^"]+)"/]),
      showExtraMemberSection: extractBoolValue(text, [
        /"showExtraMemberSection":\s*\{\s*"fieldType":\s*"Boolean",\s*"value":\s*(true|false)/,
        /"showExtraMemberSection"\s*:\s*(true|false)/,
      ]),
      membershipStatus: extractFirstMatch(text, [/"membershipStatus":\s*"([^"]+)"/]),
      maxStreams: extractFirstMatch(text, [
        /maxStreams":\{"fieldType":"Numeric","value":([^,]+),/,
        /"maxStreams"\s*:\s*"?([^",}]+)"?/,
      ]),
      localizedPlanName: extractFirstMatch(text, [
        /"MemberPlan"\s*,\s*"fields"\s*:\s*\{\s*"localizedPlanName"\s*:\s*\{\s*"fieldType"\s*:\s*"String"\s*,\s*"value"\s*:\s*"([^"]+)"/,
        /localizedPlanName":\{"fieldType":"String","value":"([^"]+)"/,
        /"currentPlan"\s*:\s*\{[\s\S]*?"plan"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/,
        /"nextPlan"\s*:\s*\{[\s\S]*?"plan"\s*:\s*\{[\s\S]*?"name"\s*:\s*"([^"]+)"/,
        /"localizedPlanName"\s*:\s*"([^"]+)"/,
        /"planName"\s*:\s*"([^"]+)"/,
      ]),
      planPrice: extractFirstMatch(text, [
        /"formattedPlanPrice"\s*:\s*"([^"]+)"/,
        /"formattedPrice"\s*:\s*"([^"]+)"/,
        /"planPriceDisplay"\s*:\s*"([^"]+)"/,
        /"displayPrice"\s*:\s*"([^"]+)"/,
        /"planPrice"\s*:\s*\{[\s\S]*?"value"\s*:\s*"([^"]+)"/,
        /"planPrice"[^}]+"value":"([^"]+)"/,
        /"price"\s*:\s*\{\s*"fieldType"\s*:\s*"String"\s*,\s*"value"\s*:\s*"([^"]+)"/,
        /"planPrice"\s*:\s*"([^"]+)"/,
      ]),
      paymentMethodType: extractFirstMatch(text, [
        /"paymentMethod"\s*:\s*\{\s*"fieldType"\s*:\s*"String"\s*,\s*"value"\s*:\s*"([^"]+)"/,
        /"paymentMethod"\s*:\s*"([^"]+)"/,
        /"paymentType"\s*:\s*"([^"]+)"/,
        /"paymentMethodType"\s*:\s*"([^"]+)"/,
      ]),
      maskedCard: extractFirstMatch(text, [
        /"__typename"\s*:\s*"GrowthCardPaymentMethod"[\s\S]*?"displayText"\s*:\s*"([^"]+)"/,
        /"paymentCardDisplayString"\s*:\s*"([^"]+)"/,
        /"paymentMethodLast4"\s*:\s*"([^"]+)"/,
        /"paymentMethodLastFour"\s*:\s*"([^"]+)"/,
        /"lastFour"\s*:\s*"([^"]+)"/,
        /"creditCardLast4"\s*:\s*"([^"]+)"/,
        /"maskedCard"\s*:\s*"([^"]+)"/,
      ]),
      phoneNumber: extractFirstMatch(text, [
        /"phoneNumberDigits"\s*:\s*\{[\s\S]*?"value"\s*:\s*"([^"]+)"/,
        /"phoneNumber"\s*:\s*"([^"]+)"/,
        /"mobilePhone"\s*:\s*"([^"]+)"/,
      ]),
      videoQuality: extractFirstMatch(text, [
        /videoQuality"\s*:\s*\{\s*"fieldType"\s*:\s*"String"\s*,\s*"value"\s*:\s*"([^"]+)"/,
        /"videoQuality"\s*:\s*"([^"]+)"/,
        /"quality"\s*:\s*"([^"]+)"/,
      ]),
      holdStatus: extractBoolValue(text, [
        /"holdStatus"\s*:\s*(true|false)/,
        /"holdStatus"\s*:\s*\{\s*"fieldType"\s*:\s*"Boolean"\s*,\s*"value":\s*(true|false)/,
        /"isUserOnHold"\s*:\s*(true|false)/,
        /"isOnHold"\s*:\s*(true|false)/,
        /"pastDue"\s*:\s*(true|false)/,
        /"isPastDue"\s*:\s*(true|false)/,
      ]),
      emailVerified: extractBoolValue(text, [
        /"emailVerified"\s*:\s*(true|false)/,
        /"isEmailVerified"\s*:\s*(true|false)/,
        /"emailAddressVerified"\s*:\s*(true|false)/,
      ]),
      profiles: extractProfileNames(text),
    };

    extracted = mergeInfo(graphqlInfo, extracted);
  }

  if (!extracted.paymentMethodType) extracted.paymentMethodType = null;
  if (!extracted.maskedCard) extracted.maskedCard = null;
  if (!extracted.holdStatus) extracted.holdStatus = null;
  if (!extracted.emailVerified) extracted.emailVerified = null;
  if (!extracted.phoneNumber) extracted.phoneNumber = null;
  if (!extracted.countryOfSignup) extracted.countryOfSignup = null;
  if (!extracted.membershipStatus) extracted.membershipStatus = null;
  if (!extracted.localizedPlanName) extracted.localizedPlanName = null;

  if (isExtraMemberByText) {
    extracted.isExtraMemberAccount = "Yes";
  }

  if (extracted.localizedPlanName) {
    extracted.localizedPlanName = extracted.localizedPlanName.replace("miembro u00A0extra", "(Extra Member)");
  }

  if (extracted.maskedCard && /^\d{4}$/.test(extracted.maskedCard)) {
    if (!extracted.paymentMethodType || extracted.paymentMethodType === "Yes") {
      extracted.paymentMethodType = "CC";
    }
  }

  if (extracted.holdStatus === null) {
    const membershipStatusKey = normalizePlanKey(extracted.membershipStatus);
    if (membershipStatusKey === "current_member") {
      extracted.holdStatus = "No";
    } else if (["hold", "past_due", "payment_retry", "paused", "suspend"].some((t) => membershipStatusKey.includes(t))) {
      extracted.holdStatus = "Yes";
    }
  }

  if (extracted.emailVerified === null && extracted.email) {
    extracted.emailVerified = "Yes";
  }

  const phoneNumber = extracted.phoneNumber;
  extracted.phoneDisplay = normalizePhoneNumber(phoneNumber, extracted.countryOfSignup);

  const profiles = extracted.profiles;
  if (profiles) {
    const profileCount = profiles.split(", ").filter(Boolean).length;
    extracted.profileCount = profileCount;
    extracted.profilesDisplay = profiles;
  } else {
    extracted.profileCount = null;
    extracted.profilesDisplay = null;
  }

  return extracted;
}
