import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Loader2, RotateCw, Send, Sparkles, Trash2 } from 'lucide-react';

import { useToast } from '@/components/Toaster';
import { Button } from '@/components/ui/Button';
import { DetailGate, DetailLevelControl, DetailLevelProvider } from '@/components/ui/DetailLevel';
import { Field, Input } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { isRetryableError } from '@/lib/api';

import { getAiStatus, streamAi, type AiMessage, type AiStatus } from './aiApi';

/**
 * NetPulse Copilot — integrated AI assistant for the desktop app.
 *
 * Connects through the authenticated NetPulse cloud API (/api/v1/ai/ask,
 * /api/v1/ai/stream). The desktop application never holds a provider API key.
 *
 * No fake model responses: every answer comes from a real API call; when the
 * backend is unreachable the failure state is shown honestly.
 */

/**
 * No seeded assistant message.
 *
 * The page used to open with a canned "I'm NetPulse Copilot…" bubble that was
 * styled, timestamped and copyable exactly like a model answer, and it was also
 * the thing that made the empty-state hero and a message appear at once. The
 * greeting belongs to the page, not to the transcript: a fresh conversation now
 * has no messages, and the hero below is the greeting.
 */

const QUICK_QUESTIONS = [
  'Why is my connection slow?',
  'Diagnose my connection',
  'Explain my VPN configuration',
  'Compare server performance',
  'Troubleshoot connection error',
  'Recommend the best server',
  'Explain protocol differences',
  'Analyze connection stability',
];

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({ message }: { message: AiMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`mb-4 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-3 ${
          isUser
            ? 'rounded-tr-sm bg-accent text-on-accent'
            : 'rounded-tl-sm border border-line bg-surface text-text'
        }`}
      >
        <div className="whitespace-pre-wrap break-words text-sm">{message.content}</div>
        <DetailGate required={4}>
          <div className="mt-1 text-micro text-faint">{formatTimestamp(message.createdAt)}</div>
        </DetailGate>
      </div>
    </div>
  );
}

function AiStatusBadge({ status }: { status: AiStatus | null }) {
  // F-31: the Rust engine works with the local LLM disabled (it falls back to
  // deterministic explanations). Tying the badge to `available` called a
  // working assistant "Offline" and overstated deterministic rewrites as a
  // model answer when it was on. Report what is actually true:
  //   - status === null → not in the desktop app / status command unavailable
  //   - available      → model answers available
  //   - otherwise      → deterministic answers, no local model
  const label =
    status === null
      ? 'Unavailable here'
      : status.available
        ? 'Local model ready'
        : 'Deterministic answers';
  const ok = status !== null && status.available;
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
        ok ? 'bg-ok/10 text-ok border border-ok/30' : 'border border-line bg-surface text-faint'
      }`}
    >
      <div className={`h-2 w-2 rounded-full ${ok ? 'bg-ok' : 'bg-muted'}`} />
      {label}
    </div>
  );
}

function QuickAction({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text"
      onClick={onClick}
    >
      <Sparkles className="h-3 w-3 text-faint" />
      <span>{text}</span>
    </button>
  );
}

export function CopilotPage() {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const toast = useToast();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAiStatus().then((status) => {
      if (!cancelled) setAiStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearConversation = useCallback(() => {
    setMessages([]);
    setError(null);
    setStreaming(false);
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const sendQuestion = useCallback(
    async (question: string) => {
      if (!question.trim() || streaming) return;
      const trimmed = question.trim();
      setInput('');
      setError(null);

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: trimmed, createdAt: Date.now() },
      ]);

      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      try {
        await streamAi({
          question: trimmed,
          onDelta: (delta: string) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
            );
          },
          signal: controller.signal,
        });
      } catch (err) {
        // A user pressing Stop is not a request failure: drop the empty
        // assistant bubble and stay quiet rather than rendering an error.
        if (controller.signal.aborted) {
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
          return;
        }
        const msg = err instanceof Error ? err.message : 'AI request failed';
        setError(msg);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: msg } : m)));
        toast('error', 'Copilot request failed', msg);
      } finally {
        if (abortRef.current === controller) {
          setStreaming(false);
          abortRef.current = null;
        }
      }
    },
    [streaming, toast],
  );

  const retryLast = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) void sendQuestion(lastUser.content);
  }, [messages, sendQuestion]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void sendQuestion(input);
    },
    [input, sendQuestion],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    abortRef.current = null;
  }, []);

  const hasContent = messages.length > 0;
  // An empty conversation is exactly that: no messages. Comparing against a
  // seeded id broke the moment the conversation was cleared, which is how the
  // hero and a greeting bubble ended up on screen together.
  const emptyConversation = messages.length === 0;
  const canRetry = hasContent && error != null && isRetryableError(new Error(error));

  return (
    // The composer belongs at the bottom of the window, not under the last
    // message. `h-full` did nothing because the content column's height is auto,
    // so the page collapsed to its content and left the composer floating
    // mid-screen with dead space beneath it.
    <DetailLevelProvider scope="copilot" defaultLevel={2} depth={4}>
    <div className="flex min-h-[calc(100dvh-var(--np-topbar-h)-76px)] flex-col bg-bg">
      <PageHeader
        title="Copilot"
        description={
          aiStatus
            ? aiStatus.available
              ? `Local explanations — ${aiStatus.runtime} ready`
              : // The backend types `message` as a string but omits it on some
                // failure paths; without the fallback the header would read
                // "model unavailable (undefined)".
                `Deterministic explanations — no local model (${aiStatus.message || 'not configured'})`
            : // Same word as the badge. "Initializing…" beside a badge that
              // already says the model is unavailable is two answers to one
              // question, and the reader has no way to tell which is current.
              'Local explanations — availability not reported in this build'
        }
        actions={<AiStatusBadge status={aiStatus} />}
      />

      <div className="-mt-3 mb-2"><DetailLevelControl /></div>

      <div
        className={`flex-1 overflow-y-auto p-4 lg:p-6 ${emptyConversation ? 'flex items-center justify-center' : 'space-y-4'}`}
        role="log"
        aria-live="polite"
      >
        {streaming && messages[messages.length - 1]?.content === '' && (
          <div className="flex h-64 items-center justify-center">
            <LoadingState label="Copilot is thinking" />
          </div>
        )}
        {!streaming && error && <ErrorState error={new Error(error)} retry={canRetry ? retryLast : undefined} />}
        {emptyConversation && (
          <div className="flex max-w-2xl flex-col items-center justify-center gap-4 text-center text-muted">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
              <Sparkles className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-text">Ask Copilot anything</p>
            <p className="max-w-md text-sm text-muted">
              I can diagnose connections, analyze profiles, explain protocols, recommend servers, and
              troubleshoot errors.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {QUICK_QUESTIONS.map((q) => (
                <QuickAction key={q} text={q} onClick={() => void sendQuestion(q)} />
              ))}
            </div>
          </div>
        )}
        {!emptyConversation && messages.map((m) => (
          <div key={m.id}>
            <MessageBubble message={m} />
            {m.role === 'assistant' && m.content !== '' && (
              <DetailGate required={3}>
                <div className="mt-1 flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void navigator.clipboard.writeText(m.content)}
                  >
                    <Copy size={12} /> Copy
                  </Button>
                </div>
              </DetailGate>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-line bg-surface p-4">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Message">
              <Input
                placeholder="Ask about your connection, a profile, or diagnostics…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={streaming}
                autoFocus
              />
            </Field>
          </div>
          {streaming ? (
            <Button type="button" variant="secondary" onClick={handleStop}>
              <Loader2 size={14} className="animate-spin" /> Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>
              <Send size={14} /> Send
            </Button>
          )}
          {hasContent && !streaming && (
            <DetailGate required={3}>
              <Button type="button" size="sm" variant="ghost" onClick={clearConversation}>
                <Trash2 size={12} /> Clear
              </Button>
            </DetailGate>
          )}
          {hasContent && !streaming && canRetry && (
            <DetailGate required={3}>
              <Button type="button" size="sm" variant="ghost" onClick={retryLast}>
                <RotateCw size={12} /> Retry
              </Button>
            </DetailGate>
          )}
        </form>
      </div>
    </div>
    </DetailLevelProvider>
  );
}

export default CopilotPage;
