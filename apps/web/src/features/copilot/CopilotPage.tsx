import { useCallback, useEffect, useRef, useState } from 'react';

import { ArrowRight, Bot, Copy, Loader2, RotateCw, Send, Trash2 } from 'lucide-react';
import { useToast } from '@/components/Toaster';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { askAi, streamAi, type AiAskResponse, type AiMessage } from './aiApi';

/**
 * NetPulse Copilot — premium integrated AI assistant for the desktop app.
 *
 * Connects through the authenticated NetPulse cloud API (/api/v1/ai/ask,
 * /api/v1/ai/stream). The desktop application never holds a provider API key;
 * all model calls are mediated by the cloud backend which runs the centralized
 * AI service.
 *
 * Features:
 *   - Streaming chat responses (SSE) with non-streaming fallback
 *   - Conversation history (session-scoped, in-memory)
 *   - Loading, failure and retry states
 *   - Copy and clear actions
 *
 * UI contract: no fake model responses. Every answer comes from a real API
 * call; when the backend is unreachable the failure state is shown honestly.
 */

const EMPTY: AiMessage[] = [];

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    return m.includes('failed') || m.includes('aborted') || m.includes('network') || m.includes('fetch');
  }
  return true;
}

export function CopilotPage() {
  const [messages, setMessages] = useState<AiMessage[]>(EMPTY);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const toast = useToast();

  const abortRef = useRef<AbortController | null>(null);

  const addMessage = useCallback((msg: AiMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const clearConversation = useCallback(() => {
    setMessages(EMPTY);
    setError(null);
    setStreamError(null);
  }, []);

  const sendQuestion = useCallback(
    async (question: string) => {
      if (!question.trim() || streaming) return;
      const trimmed = question.trim();
      setInput('');
      setError(null);
      setStreamError(null);

      const assistantId = crypto.randomUUID();
      const userMsg: AiMessage = { id: crypto.randomUUID(), role: 'user', content: trimmed, createdAt: Date.now() };
      addMessage(userMsg);

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() },
      ]);

      let completed = false;
      try {
        await streamAi({
          question: trimmed,
          role: 'admin',
          onDelta: (delta: string) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + delta } : m)),
            );
          },
          signal: controller.signal,
        });
        completed = true;
      } catch (err) {
        // Stream failed (e.g. backend without SSE support) — fall back to
        // non-streaming ask.
        try {
          const res: AiAskResponse = await askAi({ question: trimmed, role: 'admin' });
          completed = true;
          if (res.kind === 'error') {
            setError(res.text);
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: res.text } : m)),
            );
          } else if (res.kind === 'needs_confirmation') {
            const text = `⚠️ ${res.preview ?? res.tool ?? 'action'} requires admin confirmation.\n\n${res.text}`;
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: text } : m)),
            );
            setError('A write action was proposed and awaits your confirmation in the admin console.');
          } else {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: res.text } : m)),
            );
          }
        } catch (fallbackErr) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : 'AI request failed';
          setError(msg);
          setStreamError(msg);
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: msg } : m)),
          );
          toast('error', 'Copilot request failed', msg);
        }
      } finally {
        if (abortRef.current === controller) {
          setStreaming(false);
          abortRef.current = null;
        }
      }
    },
    [streaming, addMessage, toast, askAi, streamAi],
  );

  const retryLast = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    void sendQuestion(lastUser.content);
  }, [messages, sendQuestion]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void sendQuestion(input);
    },
    [input, sendQuestion],
  );

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      setStreaming(false);
      abortRef.current = null;
    }
  }, []);

  const hasContent = messages.length > 0;
  const canRetry = hasContent && (error != null || streamError != null) && isRetryable(error ?? streamError ?? '');

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Copilot" description="AI-powered network intelligence and troubleshooting" />
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">
          {streaming && <LoadingState label="Copilot is thinking" />}
          {(!streaming) && error && <ErrorState error={error} retry={retryLast} />}
          {(!streaming) && streamError && <ErrorState error={streamError} retry={retryLast} />}
          {messages.length === 0 && !streaming && !error && !streamError && (
            <div className="flex flex-col items-center justify-center h-64 text-center text-muted">
              <Bot size={32} className="mb-2 opacity-50" />
              <p className="text-sm">Ask Copilot about your network — connection issues, profile analysis, performance recommendations.</p>
            </div>
          )}
          {messages.map((m) => (
            <Card key={m.id} className={`p-4 ${m.role === 'user' ? 'bg-surface-2 border-border/60' : 'bg-surface border-border'}`}>
              <div className="flex items-start gap-2.5 mb-2">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full shrink-0 ${
                    m.role === 'user' ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {m.role === 'user' ? <ArrowRight size={14} /> : <Bot size={14} />}
                </div>
                <span className="text-micro font-semibold uppercase tracking-wider text-faint">
                  {m.role === 'user' ? 'You' : 'Copilot'}
                </span>
              </div>
              <div className="whitespace-pre-wrap break-whitespace text-text">{m.content}</div>
              {m.role === 'assistant' && (
                <div className="mt-3 flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(m.content)}>
                    <Copy size={12} className="mr-1" /> Copy
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
        <div className="border-t border-line bg-surface/50 backdrop-blur p-4">
          <form onSubmit={handleSubmit} className="flex gap-2">
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
            <Button type="submit" disabled={streaming || !input.trim()} className="px-4">
              {streaming ? (
                <>
                  <Loader2 size={14} className="mr-2 animate-spin" /> Stop
                </>
              ) : (
                <>
                  <Send size={14} className="mr-2" /> Send
                </>
              )}
            </Button>
            {!streaming && hasContent && (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={clearConversation}>
                  <Trash2 size={12} className="mr-1" /> Clear
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={!canRetry} onClick={retryLast}>
                  <RotateCw size={12} className="mr-1" /> Retry
                </Button>
              </>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export default CopilotPage;
