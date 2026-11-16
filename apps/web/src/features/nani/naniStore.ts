/**
 * Durable NANI conversations + investigations.
 *
 * Uses `localStorage` (not `sessionStorage`) so history survives an
 * application restart, matching the requirement that reopening NANI after a
 * restart still shows past investigations. The Rust `PersistenceStore` keeps
 * the learned model journal; this store keeps the *user-visible* record.
 *
 * Records are bounded (retention) and corrupt entries are dropped rather than
 * crashing the page. Nothing here stores credentials or network secrets.
 */
import type { NaniActivityState } from './naniEvents';

const CONVERSATIONS_KEY = 'np.nani.conversations.v1';
const INVESTIGATIONS_KEY = 'np.nani.investigations.v1';
const MAX_CONVERSATIONS = 50;
const MAX_INVESTIGATIONS = 50;
const MAX_MESSAGES = 200;

export interface NaniChatMessage {
  id: string;
  role: 'user' | 'nani' | 'system';
  content: string;
  at: number;
  /** Honest provenance of the text: deterministic engine vs local model. */
  source?: string;
  warning?: string | null;
  error?: boolean;
}

export interface NaniConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: NaniChatMessage[];
}

export interface NaniInvestigationRecord {
  id: string;
  query: string;
  status: NaniActivityState;
  startedAt: number;
  updatedAt: number;
  summary: string | null;
  error: string | null;
  eventCount: number;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota/blocked: keep working in memory; callers surface the real action.
  }
}

function bounded<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

export function loadConversations(): NaniConversation[] {
  return read<NaniConversation[]>(CONVERSATIONS_KEY, []).filter(
    (c) => c && typeof c.id === 'string' && Array.isArray(c.messages),
  );
}

export function saveConversations(list: NaniConversation[]): void {
  const normalized = bounded(list, MAX_CONVERSATIONS).map((c) => ({
    ...c,
    messages: bounded(c.messages, MAX_MESSAGES),
  }));
  write(CONVERSATIONS_KEY, normalized);
}

export function loadInvestigations(): NaniInvestigationRecord[] {
  return read<NaniInvestigationRecord[]>(INVESTIGATIONS_KEY, []).filter(
    (i) => i && typeof i.id === 'string' && typeof i.query === 'string',
  );
}

export function saveInvestigations(list: NaniInvestigationRecord[]): void {
  write(INVESTIGATIONS_KEY, bounded(list, MAX_INVESTIGATIONS));
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Remove one conversation; returns the remaining list. */
export function deleteConversation(id: string): NaniConversation[] {
  const next = loadConversations().filter((c) => c.id !== id);
  saveConversations(next);
  return next;
}

export function clearNaniHistory(): void {
  try {
    localStorage.removeItem(CONVERSATIONS_KEY);
    localStorage.removeItem(INVESTIGATIONS_KEY);
  } catch {
    // ignore
  }
}
