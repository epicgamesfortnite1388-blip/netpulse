import type { GameDefinition, GameEndpoint } from '@netpulse/shared';

/** Catalog verification date — 2026-09-04T00:00:00Z. */
const VERIFIED_AT = 1_788_480_000_000;

/**
 * Bundled game catalog.
 *
 * SAFETY & HONESTY RULES
 *  - Only hostnames that are documented by the publisher / service operator
 *    are bundled. `verified: false` marks entries that were NOT re-verified
 *    against the live official page on 2026-09-04 — treat them as
 *    "documented at time of writing", not as guarantees. `verified: true`
 *    entries carry `verifiedAt` and were checked against the official source
 *    on 2026-09-04 (or the endpoint was DNS-verified live and the source is
 *    the documenting reference, noted per entry).
 *  - These are *service / login / API front doors*, not authoritative game
 *    servers. Game-server routing (UDP, per-match) can differ materially.
 *    The UI shows this caveat via `note`.
 *  - Add or correct entries by editing this file (data-driven, extensible).
 */
export const GAME_CATALOG: GameDefinition[] = [
  {
    id: 'valorant',
    name: 'VALORANT',
    publisher: 'Riot Games',
    category: 'game',
    statusUrl: 'https://status.riotgames.com/',
    note: 'Endpoints are Riot regional API front doors used for service routing (documented on developer.riotgames.com). In-game RTT to a match server is not measured.',
    regions: [
      { id: 'na', name: 'North America', code: 'NA' },
      { id: 'eu', name: 'Europe', code: 'EU' },
      { id: 'asia', name: 'Asia', code: 'ASIA' },
      { id: 'sea', name: 'Southeast Asia', code: 'SEA' },
    ],
    endpoints: [
      ep('americas.api.riotgames.com', 'na', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('europe.api.riotgames.com', 'eu', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('asia.api.riotgames.com', 'asia', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('sea.api.riotgames.com', 'sea', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('pd.na.a.pvp.net', 'na', 'tcp', 'latency', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host, documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
      ep('pd.eu.a.pvp.net', 'eu', 'tcp', 'latency', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host, documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
      ep('pd.ap.a.pvp.net', 'asia', 'tcp', 'latency', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host, documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
      ep('pd.kr.a.pvp.net', 'asia', 'tcp', 'latency', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host (Korea), documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
      ep('auth.riotgames.com', undefined, 'tls', 'login', 'https://developer.riotgames.com/apis'),
    ],
  },
  {
    id: 'league-of-legends',
    name: 'League of Legends',
    publisher: 'Riot Games',
    category: 'game',
    statusUrl: 'https://status.riotgames.com/',
    note: 'Shares Riot regional service routing with VALORANT.',
    regions: [
      { id: 'na', name: 'North America', code: 'NA' },
      { id: 'eu', name: 'Europe', code: 'EU' },
      { id: 'asia', name: 'Asia', code: 'ASIA' },
      { id: 'sea', name: 'Southeast Asia', code: 'SEA' },
    ],
    endpoints: [
      ep('americas.api.riotgames.com', 'na', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('europe.api.riotgames.com', 'eu', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('asia.api.riotgames.com', 'asia', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('sea.api.riotgames.com', 'sea', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
    ],
  },
  {
    id: 'cs2',
    name: 'Counter-Strike 2',
    publisher: 'Valve',
    category: 'game',
    statusUrl: 'https://steamstat.us/',
    note: 'CS2 match servers are dynamically allocated; latency here reflects Valve/Steam service front doors.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('api.steampowered.com', undefined, 'tcp', 'service', 'https://partner.steamgames.com/doc/webapi'),
      ep('store.steampowered.com', undefined, 'tls', 'service', 'https://store.steampowered.com/'),
    ],
  },
  {
    id: 'dota2',
    name: 'Dota 2',
    publisher: 'Valve',
    category: 'game',
    note: 'Shares Valve/Steam infrastructure with CS2.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [ep('api.steampowered.com', undefined, 'tcp', 'service', 'https://partner.steamgames.com/doc/webapi')],
  },
  {
    id: 'overwatch-2',
    name: 'Overwatch 2',
    publisher: 'Blizzard Entertainment',
    category: 'game',
    statusUrl: 'https://status.blizzard.com/',
    note: 'Regional Battle.net API front doors (Blizzard API docs) plus the per-region login service; China uses the CN gateway (develop.battlenet.com.cn).',
    regions: [
      { id: 'us', name: 'Americas', code: 'US' },
      { id: 'eu', name: 'Europe', code: 'EU' },
      { id: 'kr', name: 'Korea', code: 'KR' },
      { id: 'cn', name: 'China', code: 'CN' },
    ],
    endpoints: [
      ep('us.api.blizzard.com', 'us', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('eu.api.blizzard.com', 'eu', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('kr.api.blizzard.com', 'kr', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('us.actual.battle.net', 'us', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('eu.actual.battle.net', 'eu', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('kr.actual.battle.net', 'kr', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('gateway.battlenet.com.cn', 'cn', 'tcp', 'service', 'https://develop.battle.net/documentation', {
        verified: true,
        note: 'Blizzard API China gateway, documented as the CN host in the Battle.net API reference.',
      }),
      ep('oauth.battlenet.com.cn', 'cn', 'tls', 'login', 'https://develop.battle.net/documentation', {
        verified: true,
        note: 'Battle.net OAuth host for China, documented as the region-specific CN host.',
      }),
    ],
  },
  {
    id: 'world-of-warcraft',
    name: 'World of Warcraft',
    publisher: 'Blizzard Entertainment',
    category: 'game',
    statusUrl: 'https://status.blizzard.com/',
    note: 'Regional Battle.net API front doors plus the per-region login service; China uses the CN gateway (develop.battlenet.com.cn).',
    regions: [
      { id: 'us', name: 'Americas', code: 'US' },
      { id: 'eu', name: 'Europe', code: 'EU' },
      { id: 'kr', name: 'Korea', code: 'KR' },
      { id: 'cn', name: 'China', code: 'CN' },
    ],
    endpoints: [
      ep('us.api.blizzard.com', 'us', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('eu.api.blizzard.com', 'eu', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('kr.api.blizzard.com', 'kr', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('us.actual.battle.net', 'us', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('eu.actual.battle.net', 'eu', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('kr.actual.battle.net', 'kr', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('gateway.battlenet.com.cn', 'cn', 'tcp', 'service', 'https://develop.battle.net/documentation', {
        verified: true,
        note: 'Blizzard API China gateway, documented as the CN host in the Battle.net API reference.',
      }),
      ep('oauth.battlenet.com.cn', 'cn', 'tls', 'login', 'https://develop.battle.net/documentation', {
        verified: true,
        note: 'Battle.net OAuth host for China, documented as the region-specific CN host.',
      }),
    ],
  },
  {
    id: 'fortnite',
    name: 'Fortnite',
    publisher: 'Epic Games',
    category: 'game',
    statusUrl: 'https://status.epicgames.com/',
    note: 'Epic service endpoints; match servers are dynamic (AWS-based) and not enumerated here.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('api.epicgames.dev', undefined, 'tcp', 'service', 'https://dev.epicgames.com/docs'),
      ep('www.epicgames.com', undefined, 'tls', 'service', 'https://www.epicgames.com/'),
    ],
  },
  {
    id: 'roblox',
    name: 'Roblox',
    publisher: 'Roblox Corporation',
    category: 'game',
    statusUrl: 'https://status.roblox.com/',
    note: 'Roblox game servers are allocated per place; latency reflects Roblox API/CDN front doors.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('apis.roblox.com', undefined, 'tcp', 'service', 'https://create.roblox.com/docs'),
      ep('www.roblox.com', undefined, 'tls', 'service', 'https://www.roblox.com/'),
    ],
  },
  {
    id: 'minecraft',
    name: 'Minecraft',
    publisher: 'Mojang Studios',
    category: 'game',
    statusUrl: 'https://status.mojang.com/',
    note: 'Java Edition session/API services (Mojang API reference). A specific server you own or play on can be added via the session monitor target.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('api.minecraftservices.com', undefined, 'tls', 'login', 'https://wiki.vg/Mojang_API'),
      ep('session.minecraft.net', undefined, 'tcp', 'service', 'https://wiki.vg/Mojang_API'),
      ep('api.mojang.com', undefined, 'tcp', 'service', 'https://wiki.vg/Mojang_API'),
    ],
  },
  {
    id: 'destiny-2',
    name: 'Destiny 2',
    publisher: 'Bungie',
    category: 'game',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [ep('www.bungie.net', undefined, 'tls', 'service', 'https://bungie-net.github.io/multiplayer/')],
  },
  {
    id: 'final-fantasy-xiv',
    name: 'Final Fantasy XIV',
    publisher: 'Square Enix',
    category: 'game',
    note: 'FFXIV does not publish static game-server endpoints; the official regional Lodestone/site fronts (NA/EU/JP) are measured instead. In-game RTT to a data center is not measured.',
    regions: [
      { id: 'na', name: 'North America', code: 'NA' },
      { id: 'eu', name: 'Europe', code: 'EU' },
      { id: 'jp', name: 'Japan', code: 'JP' },
    ],
    endpoints: [
      ep('na.finalfantasyxiv.com', 'na', 'tcp', 'service', 'https://na.finalfantasyxiv.com/', {
        verified: true,
        note: 'Official NA Lodestone front, live-verified on 2026-09-04.',
      }),
      ep('eu.finalfantasyxiv.com', 'eu', 'tcp', 'service', 'https://eu.finalfantasyxiv.com/', {
        verified: true,
        note: 'Official EU Lodestone front, live-verified on 2026-09-04.',
      }),
      ep('jp.finalfantasyxiv.com', 'jp', 'tcp', 'service', 'https://jp.finalfantasyxiv.com/', {
        verified: true,
        note: 'Official JP Lodestone front, live-verified on 2026-09-04.',
      }),
    ],
  },
  {
    id: 'call-of-duty',
    name: 'Call of Duty / Warzone',
    publisher: 'Activision',
    category: 'game',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [ep('www.callofduty.com', undefined, 'tls', 'service', 'https://www.callofduty.com/')],
  },
  {
    id: 'rainbow-six-siege',
    name: 'Rainbow Six Siege',
    publisher: 'Ubisoft',
    category: 'game',
    note: 'Match servers are dynamic; the Ubisoft services API front door is documented by Ubisoft.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [ep('api.ubisoft.com', undefined, 'tcp', 'service', 'https://staticctf.akamaized.net/Ubisoft-API-docs')],
  },
  {
    id: 'apex-legends',
    name: 'Apex Legends',
    publisher: 'EA / Respawn',
    category: 'game',
    note: 'EA does not publish static Apex server endpoints; EA platform front doors are measured as a reachability proxy.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('www.ea.com', undefined, 'tls', 'service', 'https://www.ea.com/'),
      ep('help.ea.com', undefined, 'tcp', 'service', 'https://help.ea.com/'),
    ],
  },
  {
    id: 'pubg',
    name: 'PUBG: Battlegrounds',
    publisher: 'Krafton',
    category: 'game',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [ep('api.pubg.com', undefined, 'tcp', 'service', 'https://developer.pubg.com/')],
  },
  {
    id: 'rocket-league',
    name: 'Rocket League',
    publisher: 'Psyonix / Epic Games',
    category: 'game',
    note: 'Rocket League matchmaking runs on Epic infrastructure; measure the Epic endpoints.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [ep('api.epicgames.dev', undefined, 'tcp', 'service', 'https://dev.epicgames.com/docs')],
  },
  /* ------------------------------ platforms ------------------------------- */
  {
    id: 'steam',
    name: 'Steam',
    publisher: 'Valve',
    category: 'platform',
    statusUrl: 'https://steamstat.us/',
    note: 'Steam content/login infrastructure.',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('api.steampowered.com', undefined, 'tcp', 'service', 'https://partner.steamgames.com/doc/webapi'),
      ep('store.steampowered.com', undefined, 'tls', 'login', 'https://store.steampowered.com/'),
    ],
  },
  {
    id: 'riot-games',
    name: 'Riot Games',
    publisher: 'Riot Games',
    category: 'platform',
    statusUrl: 'https://status.riotgames.com/',
    regions: [
      { id: 'na', name: 'North America', code: 'NA' },
      { id: 'eu', name: 'Europe', code: 'EU' },
      { id: 'asia', name: 'Asia', code: 'ASIA' },
      { id: 'sea', name: 'Southeast Asia', code: 'SEA' },
    ],
    endpoints: [
      ep('americas.api.riotgames.com', 'na', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('europe.api.riotgames.com', 'eu', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('asia.api.riotgames.com', 'asia', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('sea.api.riotgames.com', 'sea', 'tcp', 'latency', 'https://developer.riotgames.com/apis'),
      ep('pd.na.a.pvp.net', 'na', 'tcp', 'service', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host, documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
      ep('pd.eu.a.pvp.net', 'eu', 'tcp', 'service', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host, documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
      ep('pd.ap.a.pvp.net', 'asia', 'tcp', 'service', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host, documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
      ep('pd.kr.a.pvp.net', 'asia', 'tcp', 'service', 'https://github.com/techchrism/valorant-api-docs', {
        note: 'Riot client platform-data host (Korea), documented by the community VALORANT API reference; DNS-verified live on 2026-09-04.',
      }),
    ],
  },
  {
    id: 'battle-net',
    name: 'Battle.net',
    publisher: 'Blizzard Entertainment',
    category: 'platform',
    statusUrl: 'https://status.blizzard.com/',
    regions: [
      { id: 'us', name: 'Americas', code: 'US' },
      { id: 'eu', name: 'Europe', code: 'EU' },
      { id: 'kr', name: 'Korea', code: 'KR' },
      { id: 'cn', name: 'China', code: 'CN' },
    ],
    endpoints: [
      ep('us.api.blizzard.com', 'us', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('eu.api.blizzard.com', 'eu', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('kr.api.blizzard.com', 'kr', 'tcp', 'latency', 'https://develop.battle.net/documentation'),
      ep('us.actual.battle.net', 'us', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('eu.actual.battle.net', 'eu', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('kr.actual.battle.net', 'kr', 'tcp', 'login', 'https://bnetdocs.org/servers', {
        note: 'Blizzard regional login service host; DNS-verified live on 2026-09-04.',
      }),
      ep('gateway.battlenet.com.cn', 'cn', 'tcp', 'service', 'https://develop.battle.net/documentation', {
        verified: true,
        note: 'Blizzard API China gateway, documented as the CN host in the Battle.net API reference.',
      }),
      ep('oauth.battlenet.com.cn', 'cn', 'tls', 'login', 'https://develop.battle.net/documentation', {
        verified: true,
        note: 'Battle.net OAuth host for China, documented as the region-specific CN host.',
      }),
    ],
  },
  {
    id: 'epic-games',
    name: 'Epic Games Store',
    publisher: 'Epic Games',
    category: 'platform',
    statusUrl: 'https://status.epicgames.com/',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('api.epicgames.dev', undefined, 'tcp', 'service', 'https://dev.epicgames.com/docs'),
      ep('www.epicgames.com', undefined, 'tls', 'service', 'https://www.epicgames.com/'),
    ],
  },
  {
    id: 'xbox-network',
    name: 'Xbox Network',
    publisher: 'Microsoft',
    category: 'platform',
    statusUrl: 'https://support.xbox.com/en-US/xbox-live-status',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('www.xbox.com', undefined, 'tls', 'service', 'https://www.xbox.com/'),
      ep('api.xboxlive.com', undefined, 'tcp', 'service', 'https://learn.microsoft.com/en-us/gaming/gdk/_content/gc/live/overviews/live-intro'),
    ],
  },
  {
    id: 'playstation-network',
    name: 'PlayStation Network',
    publisher: 'Sony Interactive Entertainment',
    category: 'platform',
    statusUrl: 'https://status.playstation.com/',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('www.playstation.com', undefined, 'tls', 'service', 'https://www.playstation.com/'),
      ep('status.playstation.com', undefined, 'tcp', 'service', 'https://status.playstation.com/'),
    ],
  },
  {
    id: 'ea',
    name: 'EA',
    publisher: 'Electronic Arts',
    category: 'platform',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [
      ep('www.ea.com', undefined, 'tls', 'service', 'https://www.ea.com/'),
      ep('help.ea.com', undefined, 'tcp', 'service', 'https://help.ea.com/'),
    ],
  },
  {
    id: 'ubisoft-connect',
    name: 'Ubisoft Connect',
    publisher: 'Ubisoft',
    category: 'platform',
    regions: [{ id: 'global', name: 'Global' }],
    endpoints: [ep('api.ubisoft.com', undefined, 'tcp', 'service', 'https://www.ubisoft.com/')],
  },
];

function ep(
  hostname: string,
  region: string | undefined,
  protocol: 'tcp' | 'tls' | 'https' | 'icmp',
  purpose: GameEndpoint['purpose'],
  source: string,
  opts: { verified?: boolean; note?: string } = {},
): GameEndpoint {
  return {
    hostname,
    region,
    protocol,
    port: protocol === 'https' || protocol === 'tls' ? 443 : undefined,
    purpose,
    verified: opts.verified ?? false,
    verifiedAt: opts.verified ? VERIFIED_AT : undefined,
    source,
    note: opts.note,
  };
}

export function gameById(id: string): GameDefinition | null {
  return GAME_CATALOG.find((g) => g.id === id) ?? null;
}

export function listGames(): GameDefinition[] {
  return GAME_CATALOG;
}
