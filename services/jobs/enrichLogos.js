// Clearbit Logo API enrichment — free, no API key required.
// HEAD https://logo.clearbit.com/<domain> returns 200 if logo exists.

import axios from 'axios';

const KNOWN_DOMAINS = {
  'google':       'google.com',      'meta':        'meta.com',
  'microsoft':    'microsoft.com',   'amazon':      'amazon.com',
  'apple':        'apple.com',       'netflix':     'netflix.com',
  'stripe':       'stripe.com',      'airbnb':      'airbnb.com',
  'uber':         'uber.com',        'lyft':        'lyft.com',
  'shopify':      'shopify.com',     'salesforce':  'salesforce.com',
  'twilio':       'twilio.com',      'datadog':     'datadoghq.com',
  'snowflake':    'snowflake.com',   'databricks':  'databricks.com',
  'confluent':    'confluent.io',    'hashicorp':   'hashicorp.com',
  'mongodb':      'mongodb.com',     'elastic':     'elastic.co',
  'cloudflare':   'cloudflare.com',  'vercel':      'vercel.com',
  'notion':       'notion.so',       'figma':       'figma.com',
  'linear':       'linear.app',      'github':      'github.com',
  'gitlab':       'gitlab.com',      'atlassian':   'atlassian.com',
  'slack':        'slack.com',       'zoom':        'zoom.us',
  'hubspot':      'hubspot.com',     'zendesk':     'zendesk.com',
  'intercom':     'intercom.com',    'segment':     'segment.com',
  'discord':      'discord.com',     'reddit':      'reddit.com',
  'pinterest':    'pinterest.com',   'square':      'squareup.com',
  'coinbase':     'coinbase.com',    'robinhood':   'robinhood.com',
  'plaid':        'plaid.com',       'brex':        'brex.com',
  'rippling':     'rippling.com',    'gusto':       'gusto.com',
  'lattice':      'lattice.com',     'workday':     'workday.com',
  'oracle':       'oracle.com',      'sap':         'sap.com',
  'ibm':          'ibm.com',         'intel':       'intel.com',
  'nvidia':       'nvidia.com',      'adobe':       'adobe.com',
  'spotify':      'spotify.com',     'twitter':     'x.com',
  'x.com':        'x.com',           'linkedin':    'linkedin.com',
  'greenhouse':   'greenhouse.io',   'lever':       'lever.co',
  'ashby':        'ashbyhq.com',
  'anthropic':    'anthropic.com',   'openai':      'openai.com',
  'mistral':      'mistral.ai',      'cohere':      'cohere.com',
  'perplexity':   'perplexity.ai',   'groq':        'groq.com',
  'together':     'together.ai',     'replicate':   'replicate.com',
  'hugging face': 'huggingface.co',  'scale ai':    'scale.com',
  'palantir':     'palantir.com',    'c3.ai':       'c3.ai',
  'cursor':       'cursor.com',      'supabase':    'supabase.com',
  'neon':         'neon.tech',       'planetscale': 'planetscale.com',
  'fly.io':       'fly.io',          'railway':     'railway.app',
  'render':       'render.com',      'netlify':     'netlify.com',
  'digitalocean': 'digitalocean.com','linode':      'linode.com',
};

export function companyToDomain(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    if (lower.includes(key)) return domain;
  }
  // Naive fallback — strip legal suffixes, append .com
  const slug = lower
    .replace(/\b(inc|llc|ltd|corp|co|the|group|&|and)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
  return slug ? slug + '.com' : null;
}

/**
 * Returns the Clearbit logo URL for a known company without a network request.
 * Use this for offline/cold-start enrichment.
 */
export function getKnownLogoUrl(companyName) {
  const domain = companyToDomain(companyName);
  if (!domain) return null;
  // Only return URLs for domains we explicitly know, not slug guesses
  const lower = companyName.toLowerCase().trim();
  const isKnown = Object.keys(KNOWN_DOMAINS).some(k => lower.includes(k));
  if (!isKnown) return null;
  return 'https://logo.clearbit.com/' + domain;
}

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
