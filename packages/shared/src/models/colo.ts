export interface ColoInfo {
  code: string;
  city?: string;
  country?: string;
  countryCode?: string;
  /** City-level coordinates — approximate, for map rendering only. */
  lat?: number;
  lon?: number;
}

/** Known Cloudflare datacenter codes (nearest edges for this app's users).
 *  Coordinates are city-level approximations for the map; only codes with
 *  confident city/country mappings are listed — anything else is shown plainly
 *  as its code. */
export const COLO_NAMES: Record<string, { city: string; country: string; countryCode: string; lat: number; lon: number }> = {
  AMS: { city: 'Amsterdam', country: 'Netherlands', countryCode: 'NL', lat: 52.3676, lon: 4.9041 },
  ATH: { city: 'Athens', country: 'Greece', countryCode: 'GR', lat: 37.9838, lon: 23.7275 },
  BAH: { city: 'Manama', country: 'Bahrain', countryCode: 'BH', lat: 26.2285, lon: 50.586 },
  BOM: { city: 'Mumbai', country: 'India', countryCode: 'IN', lat: 19.076, lon: 72.8777 },
  CDG: { city: 'Paris', country: 'France', countryCode: 'FR', lat: 48.8566, lon: 2.3522 },
  DXB: { city: 'Dubai', country: 'UAE', countryCode: 'AE', lat: 25.2048, lon: 55.2708 },
  FRA: { city: 'Frankfurt', country: 'Germany', countryCode: 'DE', lat: 50.1109, lon: 8.6821 },
  HEL: { city: 'Helsinki', country: 'Finland', countryCode: 'FI', lat: 60.1699, lon: 24.9384 },
  IST: { city: 'Istanbul', country: 'Türkiye', countryCode: 'TR', lat: 41.0082, lon: 28.9784 },
  KBP: { city: 'Kyiv', country: 'Ukraine', countryCode: 'UA', lat: 50.4501, lon: 30.5234 },
  KWI: { city: 'Kuwait City', country: 'Kuwait', countryCode: 'KW', lat: 29.3759, lon: 47.9774 },
  LHR: { city: 'London', country: 'United Kingdom', countryCode: 'GB', lat: 51.5074, lon: -0.1278 },
  MAD: { city: 'Madrid', country: 'Spain', countryCode: 'ES', lat: 40.4168, lon: -3.7038 },
  MCT: { city: 'Muscat', country: 'Oman', countryCode: 'OM', lat: 23.588, lon: 58.3829 },
  MIL: { city: 'Milan', country: 'Italy', countryCode: 'IT', lat: 45.4642, lon: 9.19 },
  MRS: { city: 'Marseille', country: 'France', countryCode: 'FR', lat: 43.2965, lon: 5.3698 },
  NRT: { city: 'Tokyo', country: 'Japan', countryCode: 'JP', lat: 35.6762, lon: 139.6503 },
  OSL: { city: 'Oslo', country: 'Norway', countryCode: 'NO', lat: 59.9139, lon: 10.7522 },
  RUH: { city: 'Riyadh', country: 'Saudi Arabia', countryCode: 'SA', lat: 24.7136, lon: 46.6753 },
  SOF: { city: 'Sofia', country: 'Bulgaria', countryCode: 'BG', lat: 42.6977, lon: 23.3219 },
  TLV: { city: 'Tel Aviv', country: 'Israel', countryCode: 'IL', lat: 32.0853, lon: 34.7818 },
  VIE: { city: 'Vienna', country: 'Austria', countryCode: 'AT', lat: 48.2082, lon: 16.3738 },
  WAW: { city: 'Warsaw', country: 'Poland', countryCode: 'PL', lat: 52.2297, lon: 21.0122 },
  ZRH: { city: 'Zurich', country: 'Switzerland', countryCode: 'CH', lat: 47.3769, lon: 8.5417 },
};

/** Resolve a colo code to human-readable info (null when unmapped). */
export function coloInfo(code: string | null | undefined): ColoInfo | null {
  if (!code) return null;
  const normalized = code.toUpperCase();
  const known = COLO_NAMES[normalized];
  return known ? { code: normalized, ...known } : null;
}

/** Compact display label for a colo code, e.g. "FRA · Frankfurt, DE". */
export function coloLabel(code: string | null | undefined): string | null {
  const info = coloInfo(code);
  if (!info) return code && code.length > 0 ? code.toUpperCase() : null;
  return `${info.code} · ${info.city}, ${info.countryCode}`;
}