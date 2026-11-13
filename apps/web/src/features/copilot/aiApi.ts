import { api } from '@/lib/api';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface AiAskRequest {
  question: string;
  role?: 'support' | 'admin' | 'diagnostics' | 'developer';
}

export interface AiAskResponse {
  kind: 'answer' | 'needs_confirmation' | 'error';
  text: string;
  tool?: string;
  requestId?: string;
  nonce?: string;
  preview?: string;
  html?: boolean;
  undoId?: string;
  undoImpact?: string;
}

export interface AiStreamRequest {
  question: string;
  role?: 'support' | 'admin' | 'diagnostics' | 'developer';
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AiUsage {
  totalRequests: number;
  failedRequests: number;
  failureRatePct: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgLatencyMs: number | null;
}

/**
 * Ask the AI a question through the authenticated NetPulse cloud API.
 * The desktop never holds a provider API key — it calls the cloud endpoint
 * which forwards to the centralized AI service (Abystral).
 */
export async function askAi(req: AiAskRequest): Promise<AiAskResponse> {
  return api.post<AiAskResponse>('/ai/ask', {
    question: req.question,
    role: req.role ?? 'admin',
  });
}

/**
 * Stream an AI answer as SSE text deltas through the cloud API.
 */
export async function streamAi(req: AiStreamRequest): Promise<void> {
  const t = (await import('@/lib/transport')).transport();
  const url = `${t.apiBase}/ai/stream`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      ...t.authHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ question: req.question, role: req.role ?? 'admin' }),
    signal: req.signal,
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI stream failed (${res.status}): ${text}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('AI stream returned no body');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    if (req.signal?.aborted) {
      reader.releaseLock();
      throw new Error('AI stream aborted by caller');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const data = JSON.parse(payload);
          if (typeof data.delta === 'string') req.onDelta(data.delta);
        } catch {
          // tolerate partial/malformed SSE chunks
        }
      }
    }
  }
}

/**
 * Fetch AI usage stats for the current admin (usage tracking / observability).
 */
export async function getAiUsage(): Promise<AiUsage> {
  return api.get<AiUsage>('/ai/usage');
}
