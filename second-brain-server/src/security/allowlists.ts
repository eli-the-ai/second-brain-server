/**
 * Configurable source allowlists for validating ingestion sources.
 * These can be extended by adding entries to the database or config.
 */

// Default trusted email domains for a university environment
const DEFAULT_EMAIL_DOMAINS = [
  "oru.edu",
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "microsoft.com",
];

// Default trusted RSS feed URL prefixes
const DEFAULT_RSS_PREFIXES = [
  "https://natesnewsletter.substack.com/",
  "https://www.youtube.com/feeds/",
  "https://blog.anthropic.com/",
  "https://openai.com/blog/",
  "https://github.blog/",
];

export interface AllowlistConfig {
  emailDomains: string[];
  rssPrefixes: string[];
}

let config: AllowlistConfig = {
  emailDomains: [...DEFAULT_EMAIL_DOMAINS],
  rssPrefixes: [...DEFAULT_RSS_PREFIXES],
};

export function getAllowlistConfig(): AllowlistConfig {
  return config;
}

export function updateAllowlistConfig(update: Partial<AllowlistConfig>): void {
  if (update.emailDomains) config.emailDomains = update.emailDomains;
  if (update.rssPrefixes) config.rssPrefixes = update.rssPrefixes;
}

export function isEmailDomainAllowed(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return config.emailDomains.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
  );
}

export function isRssUrlAllowed(url: string): boolean {
  return config.rssPrefixes.some((prefix) => url.startsWith(prefix));
}
