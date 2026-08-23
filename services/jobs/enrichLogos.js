// Clearbit Logo API enrichment - free, no API key required.
// HEAD https://logo.clearbit.com/<domain> returns 200 if logo exists.
//
// The domain TABLE and the two pure functions over it live in shared/companyLogos.js (AE5), because
// the board resolves the same company client-side and must not do it from a second copy. What stays
// here is the part that needs the network, plus the re-export so existing importers are unaffected.

import axios from 'axios';
import { companyToDomain, getKnownLogoUrl, KNOWN_DOMAINS } from '../../shared/companyLogos.js';

export { companyToDomain, getKnownLogoUrl, KNOWN_DOMAINS };

/**
 * Returns the Clearbit logo URL, verifying it exists via a HEAD request.
 * Falls back to getKnownLogoUrl if the network call fails.
 */
export async function fetchLogoUrl(companyName, timeout = 3000) {
  const domain = companyToDomain(companyName);
  if (!domain) return null;
  const url = 'https://logo.clearbit.com/' + domain;
  try {
    const { status } = await axios.head(url, { timeout });
    return status === 200 ? url : null;
  } catch {
    // Network unavailable — return known URL anyway (browser will handle 404)
    return getKnownLogoUrl(companyName);
  }
}
