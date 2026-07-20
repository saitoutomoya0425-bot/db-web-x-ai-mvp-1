const SALES_DOMAINS = ["dmm.com", "dmm.co.jp", "fanza.com", "fanza.co.jp"];

function verifiedSalesUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ["http:", "https:"].includes(url.protocol)
      && SALES_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
      ? url
      : null;
  } catch {
    return null;
  }
}

export function resolveSalesUrl(affiliateUrl: string | null, officialUrl: string | null) {
  const affiliate = verifiedSalesUrl(affiliateUrl);
  if (affiliate) {
    return { url: affiliate.toString(), isAffiliate: true };
  }

  const official = verifiedSalesUrl(officialUrl);
  return official ? { url: official.toString(), isAffiliate: false } : null;
}
