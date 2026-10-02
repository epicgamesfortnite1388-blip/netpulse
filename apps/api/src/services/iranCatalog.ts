import type { ConnectivityCategory, ConnectivityTarget } from '@netpulse/shared';

/**
 * Iran Connectivity test catalog.
 *
 * A data-driven list of Internet services commonly relevant to users in Iran.
 * Reachability is NEVER assumed — the current state is determined by live
 * measurements. `source`/`verifiedAt` document where each entry was verified;
 * entries without a source are marked unverified. The catalog is editable via
 * the custom-target API (SSRF-guarded).
 */
const VERIFIED_AT = 1_789_000_000_000;

function t(
  id: string,
  name: string,
  category: ConnectivityCategory,
  hostnames: string[],
  extra: Partial<ConnectivityTarget> = {},
): ConnectivityTarget {
  const primary = hostnames[0]!;
  return {
    id,
    name,
    category,
    hostnames,
    urls: extra.urls ?? [`https://${primary}/`],
    expectedProtocols: extra.expectedProtocols ?? ['https'],
    port: extra.port ?? 443,
    region: extra.region,
    source: extra.source,
    verifiedAt: extra.verifiedAt,
    custom: false,
  };
}

export const IRAN_CATALOG: ConnectivityTarget[] = [
  // Search
  t('search-google', 'Google Search', 'Search', ['google.com', 'www.google.com'], { source: 'https://www.google.com/', verifiedAt: VERIFIED_AT }),
  t('search-bing', 'Bing', 'Search', ['bing.com', 'www.bing.com'], { source: 'https://www.bing.com/', verifiedAt: VERIFIED_AT }),
  t('search-duckduckgo', 'DuckDuckGo', 'Search', ['duckduckgo.com'], { source: 'https://duckduckgo.com/', verifiedAt: VERIFIED_AT }),
  t('search-yandex', 'Yandex', 'Search', ['yandex.com', 'ya.ru'], { source: 'https://yandex.com/', verifiedAt: VERIFIED_AT }),

  // Social
  t('social-instagram', 'Instagram', 'Social', ['instagram.com', 'www.instagram.com'], { source: 'https://www.instagram.com/', verifiedAt: VERIFIED_AT }),
  t('social-twitter', 'X (Twitter)', 'Social', ['x.com', 'twitter.com'], { source: 'https://x.com/', verifiedAt: VERIFIED_AT }),
  t('social-facebook', 'Facebook', 'Social', ['facebook.com', 'www.facebook.com'], { source: 'https://www.facebook.com/', verifiedAt: VERIFIED_AT }),
  t('social-linkedin', 'LinkedIn', 'Social', ['linkedin.com', 'www.linkedin.com'], { source: 'https://www.linkedin.com/', verifiedAt: VERIFIED_AT }),
  t('social-tiktok', 'TikTok', 'Social', ['tiktok.com', 'www.tiktok.com'], { source: 'https://www.tiktok.com/', verifiedAt: VERIFIED_AT }),

  // Messaging
  t('msg-telegram', 'Telegram', 'Messaging', ['telegram.org', 'web.telegram.org'], { source: 'https://telegram.org/', verifiedAt: VERIFIED_AT }),
  t('msg-whatsapp', 'WhatsApp', 'Messaging', ['whatsapp.com', 'web.whatsapp.com'], { source: 'https://www.whatsapp.com/', verifiedAt: VERIFIED_AT }),
  t('msg-discord', 'Discord', 'Messaging', ['discord.com', 'cdn.discordapp.com'], { source: 'https://discord.com/', verifiedAt: VERIFIED_AT }),
  t('msg-signal', 'Signal', 'Messaging', ['signal.org'], { source: 'https://signal.org/', verifiedAt: VERIFIED_AT }),
  t('msg-icq', 'ICQ', 'Messaging', ['icq.com'], { source: 'https://icq.com/', verifiedAt: VERIFIED_AT }),

  // Developer
  t('dev-github', 'GitHub', 'Developer', ['github.com', 'api.github.com'], { source: 'https://github.com/', verifiedAt: VERIFIED_AT }),
  t('dev-gitlab', 'GitLab', 'Developer', ['gitlab.com'], { source: 'https://gitlab.com/', verifiedAt: VERIFIED_AT }),
  t('dev-stackoverflow', 'Stack Overflow', 'Developer', ['stackoverflow.com'], { source: 'https://stackoverflow.com/', verifiedAt: VERIFIED_AT }),
  t('dev-npm', 'npm registry', 'Developer', ['npmjs.com', 'registry.npmjs.org'], { source: 'https://www.npmjs.com/', verifiedAt: VERIFIED_AT }),
  t('dev-pypi', 'PyPI', 'Developer', ['pypi.org', 'files.pythonhosted.org'], { source: 'https://pypi.org/', verifiedAt: VERIFIED_AT }),
  t('dev-docker', 'Docker Hub', 'Developer', ['hub.docker.com', 'registry-1.docker.io'], { source: 'https://hub.docker.com/', verifiedAt: VERIFIED_AT }),

  // Cloud
  t('cloud-aws', 'AWS', 'Cloud', ['aws.amazon.com', 'console.aws.amazon.com'], { source: 'https://aws.amazon.com/', verifiedAt: VERIFIED_AT }),
  t('cloud-azure', 'Microsoft Azure', 'Cloud', ['azure.microsoft.com', 'portal.azure.com'], { source: 'https://azure.microsoft.com/', verifiedAt: VERIFIED_AT }),
  t('cloud-gcp', 'Google Cloud', 'Cloud', ['cloud.google.com'], { source: 'https://cloud.google.com/', verifiedAt: VERIFIED_AT }),
  t('cloud-cloudflare', 'Cloudflare', 'Cloud', ['cloudflare.com', 'www.cloudflare.com'], { source: 'https://www.cloudflare.com/', verifiedAt: VERIFIED_AT }),
  t('cloud-vercel', 'Vercel', 'Cloud', ['vercel.com'], { source: 'https://vercel.com/', verifiedAt: VERIFIED_AT }),

  // AI
  t('ai-chatgpt', 'ChatGPT', 'AI', ['chatgpt.com', 'openai.com'], { source: 'https://chatgpt.com/', verifiedAt: VERIFIED_AT }),
  t('ai-claude', 'Claude', 'AI', ['claude.ai', 'anthropic.com'], { source: 'https://claude.ai/', verifiedAt: VERIFIED_AT }),
  t('ai-gemini', 'Google Gemini', 'AI', ['gemini.google.com', 'ai.google'], { source: 'https://gemini.google.com/', verifiedAt: VERIFIED_AT }),
  t('ai-grok', 'xAI Grok', 'AI', ['grok.com', 'x.ai'], { source: 'https://grok.com/', verifiedAt: VERIFIED_AT }),
  t('ai-huggingface', 'Hugging Face', 'AI', ['huggingface.co'], { source: 'https://huggingface.co/', verifiedAt: VERIFIED_AT }),

  // Video / Streaming
  t('video-youtube', 'YouTube', 'Video', ['youtube.com', 'www.youtube.com'], { source: 'https://www.youtube.com/', verifiedAt: VERIFIED_AT }),
  t('video-netflix', 'Netflix', 'Streaming', ['netflix.com', 'www.netflix.com'], { source: 'https://www.netflix.com/', verifiedAt: VERIFIED_AT }),
  t('video-twitch', 'Twitch', 'Streaming', ['twitch.tv', 'www.twitch.tv'], { source: 'https://www.twitch.tv/', verifiedAt: VERIFIED_AT }),
  t('video-spotify', 'Spotify', 'Streaming', ['spotify.com', 'open.spotify.com'], { source: 'https://www.spotify.com/', verifiedAt: VERIFIED_AT }),
  t('video-soundcloud', 'SoundCloud', 'Streaming', ['soundcloud.com'], { source: 'https://soundcloud.com/', verifiedAt: VERIFIED_AT }),

  // Gaming
  t('game-steam', 'Steam', 'Gaming', ['steampowered.com', 'store.steampowered.com'], { source: 'https://store.steampowered.com/', verifiedAt: VERIFIED_AT }),
  t('game-epic', 'Epic Games', 'Gaming', ['epicgames.com', 'www.epicgames.com'], { source: 'https://www.epicgames.com/', verifiedAt: VERIFIED_AT }),
  t('game-riot', 'Riot Games', 'Gaming', ['riotgames.com', 'www.riotgames.com'], { source: 'https://www.riotgames.com/', verifiedAt: VERIFIED_AT }),
  t('game-xbox', 'Xbox Live', 'Gaming', ['xbox.com', 'www.xbox.com'], { source: 'https://www.xbox.com/', verifiedAt: VERIFIED_AT }),
  t('game-battlenet', 'Battle.net', 'Gaming', ['battle.net', 'us.battle.net'], { source: 'https://www.blizzard.com/en-us/apps/battle.net', verifiedAt: VERIFIED_AT }),
  t('game-roblox', 'Roblox', 'Gaming', ['roblox.com', 'www.roblox.com'], { source: 'https://www.roblox.com/', verifiedAt: VERIFIED_AT }),
  t('game-valorant', 'VALORANT', 'Gaming', ['playvalorant.com', 'valorant.riotgames.com'], { source: 'https://playvalorant.com/', verifiedAt: VERIFIED_AT }),
  t('game-pubg', 'PUBG', 'Gaming', ['pubg.com', 'www.pubg.com'], { source: 'https://www.pubg.com/', verifiedAt: VERIFIED_AT }),

  // Education
  t('edu-coursera', 'Coursera', 'Education', ['coursera.org', 'www.coursera.org'], { source: 'https://www.coursera.org/', verifiedAt: VERIFIED_AT }),
  t('edu-udemy', 'Udemy', 'Education', ['udemy.com', 'www.udemy.com'], { source: 'https://www.udemy.com/', verifiedAt: VERIFIED_AT }),
  t('edu-khan', 'Khan Academy', 'Education', ['khanacademy.org', 'www.khanacademy.org'], { source: 'https://www.khanacademy.org/', verifiedAt: VERIFIED_AT }),
  t('edu-wikipedia', 'Wikipedia', 'Education', ['wikipedia.org', 'en.wikipedia.org'], { source: 'https://www.wikipedia.org/', verifiedAt: VERIFIED_AT }),

  // News
  t('news-bbc', 'BBC', 'News', ['bbc.com', 'www.bbc.com'], { source: 'https://www.bbc.com/', verifiedAt: VERIFIED_AT }),
  t('news-cnn', 'CNN', 'News', ['cnn.com', 'www.cnn.com'], { source: 'https://www.cnn.com/', verifiedAt: VERIFIED_AT }),
  t('news-reuters', 'Reuters', 'News', ['reuters.com', 'www.reuters.com'], { source: 'https://www.reuters.com/', verifiedAt: VERIFIED_AT }),
  t('news-voa', 'Voice of America', 'News', ['voanews.com', 'www.voanews.com'], { source: 'https://www.voanews.com/', verifiedAt: VERIFIED_AT }),
  t('news-aljazeera', 'Al Jazeera', 'News', ['aljazeera.com', 'www.aljazeera.com'], { source: 'https://www.aljazeera.com/', verifiedAt: VERIFIED_AT }),

  // Productivity
  t('prod-gmail', 'Gmail', 'Productivity', ['gmail.com', 'mail.google.com'], { source: 'https://mail.google.com/', verifiedAt: VERIFIED_AT }),
  t('prod-outlook', 'Outlook', 'Productivity', ['outlook.com', 'www.outlook.com'], { source: 'https://www.outlook.com/', verifiedAt: VERIFIED_AT }),
  t('prod-google-drive', 'Google Drive', 'Productivity', ['drive.google.com'], { source: 'https://drive.google.com/', verifiedAt: VERIFIED_AT }),
  t('prod-notion', 'Notion', 'Productivity', ['notion.so', 'www.notion.so'], { source: 'https://www.notion.so/', verifiedAt: VERIFIED_AT }),
  t('prod-slack', 'Slack', 'Productivity', ['slack.com', 'app.slack.com'], { source: 'https://slack.com/', verifiedAt: VERIFIED_AT }),

  // Finance
  t('fin-paypal', 'PayPal', 'Finance', ['paypal.com', 'www.paypal.com'], { source: 'https://www.paypal.com/', verifiedAt: VERIFIED_AT }),
  t('fin-wise', 'Wise', 'Finance', ['wise.com', 'wise.com'], { source: 'https://wise.com/', verifiedAt: VERIFIED_AT }),
  t('fin-binance', 'Binance', 'Finance', ['binance.com', 'www.binance.com'], { source: 'https://www.binance.com/', verifiedAt: VERIFIED_AT }),
  t('fin-coinbase', 'Coinbase', 'Finance', ['coinbase.com', 'www.coinbase.com'], { source: 'https://www.coinbase.com/', verifiedAt: VERIFIED_AT }),

  // Open Source / Software Distribution
  t('os-sourceforge', 'SourceForge', 'Open Source', ['sourceforge.net'], { source: 'https://sourceforge.net/', verifiedAt: VERIFIED_AT }),
  t('os-archive', 'Internet Archive', 'Open Source', ['archive.org'], { source: 'https://archive.org/', verifiedAt: VERIFIED_AT }),
  t('sw-chrome', 'Chrome Web Store', 'Software Distribution', ['chromewebstore.google.com', 'chrome.google.com'], { source: 'https://chromewebstore.google.com/', verifiedAt: VERIFIED_AT }),
  t('sw-google-play', 'Google Play', 'Software Distribution', ['play.google.com'], { source: 'https://play.google.com/', verifiedAt: VERIFIED_AT }),
  t('sw-apple', 'Apple', 'Software Distribution', ['apple.com', 'www.apple.com'], { source: 'https://www.apple.com/', verifiedAt: VERIFIED_AT }),
  t('sw-microsoft', 'Microsoft', 'Software Distribution', ['microsoft.com', 'www.microsoft.com'], { source: 'https://www.microsoft.com/', verifiedAt: VERIFIED_AT }),

  // Maps
  t('maps-google', 'Google Maps', 'Maps', ['maps.google.com', 'www.google.com/maps'], { source: 'https://maps.google.com/', verifiedAt: VERIFIED_AT }),
  t('maps-openstreetmap', 'OpenStreetMap', 'Maps', ['openstreetmap.org', 'www.openstreetmap.org'], { source: 'https://www.openstreetmap.org/', verifiedAt: VERIFIED_AT }),

  // Email
  t('email-protonmail', 'Proton Mail', 'Email', ['proton.me', 'mail.proton.me'], { source: 'https://proton.me/mail', verifiedAt: VERIFIED_AT }),
  t('email-fastmail', 'Fastmail', 'Email', ['fastmail.com'], { source: 'https://www.fastmail.com/', verifiedAt: VERIFIED_AT }),

  // CDN / Infrastructure
  t('cdn-jsdelivr', 'jsDelivr CDN', 'CDN', ['jsdelivr.com', 'cdn.jsdelivr.net'], { source: 'https://www.jsdelivr.com/', verifiedAt: VERIFIED_AT }),
  t('cdn-unpkg', 'unpkg CDN', 'CDN', ['unpkg.com'], { source: 'https://unpkg.com/', verifiedAt: VERIFIED_AT }),
  t('cdn-cloudflare-dns', '1.1.1.1 DNS', 'Infrastructure', ['one.one.one.one', 'cloudflare-dns.com'], { source: 'https://1.1.1.1/', verifiedAt: VERIFIED_AT }),
  t('infra-google-dns', 'Google Public DNS', 'Infrastructure', ['dns.google', '8.8.8.8'], { source: 'https://dns.google/', verifiedAt: VERIFIED_AT }),
  t('infra-ntp', 'NTP Pool', 'Infrastructure', ['pool.ntp.org', 'time.google.com'], { source: 'https://www.ntppool.org/', verifiedAt: VERIFIED_AT }),
  t('infra-verisign', 'Verisign', 'Infrastructure', ['verisign.com', 'www.verisign.com'], { source: 'https://www.verisign.com/', verifiedAt: VERIFIED_AT }),
];

export function catalogById(id: string): ConnectivityTarget | null {
  return IRAN_CATALOG.find((c) => c.id === id) ?? null;
}

/** Curated default selection — a representative slice of every category. */
export const DEFAULT_TEST_IDS: string[] = [
  'search-google', 'search-duckduckgo',
  'social-instagram', 'social-tiktok',
  'msg-telegram', 'msg-discord',
  'dev-github', 'dev-npm', 'dev-docker',
  'cloud-cloudflare',
  'ai-chatgpt', 'ai-gemini', 'ai-huggingface',
  'video-youtube', 'video-netflix', 'video-twitch',
  'game-steam', 'game-riot', 'game-valorant',
  'edu-wikipedia', 'edu-khan',
  'news-bbc', 'news-voa',
  'prod-gmail', 'prod-notion',
  'fin-paypal', 'fin-binance',
  'os-archive', 'sw-google-play', 'sw-microsoft',
  'maps-google', 'maps-openstreetmap',
  'email-protonmail',
  'cdn-jsdelivr', 'infra-google-dns',
];