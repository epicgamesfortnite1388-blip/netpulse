import { tauriInvoke } from '@/lib/transport';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface AiAskRequest {
  question: string;
}

export interface AiAskResponse {
  kind: 'answer' | 'error';
  text: string;
  /** The deterministic text from the Rust engine, always present on success. */
  deterministic?: string;
  source?: 'deterministic' | 'local_model';
  grounded?: boolean;
  warning?: string;
}

export interface AiStreamRequest {
  question: string;
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}

/** Local model configuration status. Contains no model path or file contents. */
export interface AiStatus {
  enabled: boolean;
  available: boolean;
  runtime: string;
  binary_configured: boolean;
  model_configured: boolean;
  model_name: string | null;
  timeout_ms: number;
  max_tokens: number;
  message: string;
}

interface RustExplanation {
  deterministic: string;
  narrative: string | null;
  source: 'deterministic' | 'local_model';
  grounded: boolean;
  warning: string | null;
}

/**
 * Ask NANI to explain its current state.
 *
 * Everything comes from the local Rust engine. The optional local model only
 * rewrites the deterministic explanation; when it is off, the deterministic
 * text is returned. There is no cloud AI request in this path.
 */
export async function askAi(req: AiAskRequest): Promise<AiAskResponse> {
  const invoke = tauriInvoke<RustExplanation>('nani_explain', { question: req.question });
  if (!invoke) {
    return {
      kind: 'error',
      text: 'NANI Copilot runs in the desktop application. Local diagnostics remain available in web mode.',
    };
  }
  try {
    const res = await invoke;
    const warning = res.warning ? `\n\nLocal model note: ${res.warning}` : '';
    return {
      kind: 'answer',
      text: `${res.narrative ?? res.deterministic}${warning}`,
      deterministic: res.deterministic,
      source: res.source,
      grounded: res.grounded,
      warning: res.warning ?? undefined,
    };
  } catch (err) {
    return {
      kind: 'error',
      text: err instanceof Error ? err.message : 'NANI could not build an explanation.',
    };
  }
}

/**
 * Deliver the answer as one delta. The local engine answers in one result;
 * the UI does not pretend to stream tokens it does not have.
 */
export async function streamAi(req: AiStreamRequest): Promise<void> {
  if (req.signal?.aborted) throw new Error('NANI request aborted by caller');
  const res = await askAi({ question: req.question });
  if (res.kind === 'error') throw new Error(res.text);
  req.onDelta(res.text);
}

/** Local LLM status, or null outside the desktop app. */
export async function getAiStatus(): Promise<AiStatus | null> {
  const invoke = tauriInvoke<AiStatus>('nani_ai_status');
  if (!invoke) return null;
  try {
    return await invoke;
  } catch {
    return null;
  }
}
