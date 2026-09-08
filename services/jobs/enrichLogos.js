// Company logo enrichment — keyless, no API key required.
//
// The domain TABLE, the host and the two pure functions over it live in shared/companyLogos.js
// (AE5), because the board resolves the same company client-side and must not do it from a second
// copy. What stays here is the part that needs the network, plus the re-export so existing
// importers are unaffected.
//
// TASK X — this module used to name Clearbit in its own first line and build the URL itself. It
// now asks shared/companyLogos.js for the URL, so retiring a provider is one edit in one file
// instead of a hunt for a hostname across two layers of the app.

import axios from 'axios';
import {
  companyToDomain, getKnownLogoUrl, KNOWN_DOMAINS, logoUrlForDomain, isKnownLogoUrlHost, LOGO_HOST,
} from '../../shared/companyLogos.js';

export { companyToDomain, getKnownLogoUrl, KNOWN_DOMAINS, logoUrlForDomain, isKnownLogoUrlHost, LOGO_HOST };

/**
 * Returns the logo URL, verifying it exists via a HEAD request.
 *
 * Returns null — NOT a URL — when the check does not succeed. The previous version answered its
 * own catch block with `getKnownLogoUrl(companyName)`, which is the SAME provider's URL the HEAD
 * request had just failed to reach, so a dead host produced a confidently-stored dead URL. That is
 * how 1290 of 1296 rows came to hold an address that resolves to nothing: the fallback for "this
 * provider is unreachable" was that provider.
 *
 * A null here is honest and cheap to recover from — CompanyIcon resolves the same URL client-side
 * from the same table, and falls back to the lettered tile when the image does not load. Storing a
 * URL nothing verified is the one outcome with no recovery.
 */
export async function fetchLogoUrl(companyName, timeout = 3000) {
  const domain = companyToDomain(companyName);
  if (!domain) return null;
  const url = logoUrlForDomain(domain);
  try {
    const { status } = await axios.head(url, { timeout });
    return status === 200 ? url : null;
  } catch {
    return null;
  }
}
