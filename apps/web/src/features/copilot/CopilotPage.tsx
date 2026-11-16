import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Copy, Loader2, RotateCw, Send, Sparkles, Trash2 } from 'lucide-react';

import { useToast } from '@/components/Toaster';
import { Button } from '@/components/ui/Button';
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

const INITIAL_MESSAGE: AiMessage = {
  id: crypto.randomUUID(),
  role: 'assistant',
  content:
    "I'm NetPulse Copilot, your network intelligence assistant. I can help diagnose connection issues, analyze configuration profiles, explain protocols, recommend servers, and troubleshoot errors.\n\nWhat would you like to investigate today?",
  createdAt: Date.now(),
};

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
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'rounded-tr-sm bg-accent text-accent-foreground'
            : 'rounded-tl-sm border border-line bg-surface text-text'
        }`}
      >
        <div className="whitespace-pre-wrap break-words text-sm">{message.content}</div>
        <div className="mt-1 text-micro text-faint">{formatTimestamp(message.createdAt)}</div>
      </div>
    </div>
  );
}

function AiStatusBadge({ status }: { status: AiStatus | null }) {
  const healthy = status?.available === true;
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
        healthy ? 'bg-green-500/10 text-green-500' : 'border border-line bg-surface text-faint'
      }`}
    >
      <div className={`h-2 w-2 rounded-full ${healthy ? 'bg-green-500' : 'bg-muted'}`} />
      {healthy ? 'AI Copilot Online' : 'Offline'}
    </div>
  );
}

function QuickAction({ text, onClick }: { text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-accent hover:text-accent-foreground"
      onClick={onClick}
    >
      <Sparkles className="h-3 w-3 text-faint" />
      <span>{text}</span>
    </button>
  );
}

export function CopilotPage() {
  const [messages, setMessages] = useState<AiMessage[]>([INITIAL_MESSAGE]);
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
    setMessages([{ ...INITIAL_MESSAGE, id: crypto.randomUUID(), createdAt: Date.now() }]);
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

  const hasContent = messages.length > 1;
  const canRetry = hasContent && error != null && isRetryableError(new Error(error));

  return (
    <div className="flex h-full flex-col bg-background">
      <PageHeader
        title="Copilot"
        description={
          aiStatus
            ? aiStatus.available
              ? `Local explanations — ${aiStatus.runtime} ready`
              : `Local explanations — model unavailable (${aiStatus.message})`
            : 'Local explanations — initializing…'
        }
        actions={<AiStatusBadge status={aiStatus} />}
      />

      <div className="flex-1 overflow-y-auto space-y-4 p-4 lg:p-6">
        {streaming && messages[messages.length - 1]?.content === '' && (
          <div className="flex h-64 items-center justify-center">
            <LoadingState label="Copilot is thinking" />
          </div>
        )}
        {!streaming && error && <ErrorState error={new Error(error)} retry={canRetry ? retryLast : undefined} />}
        {messages.length === 1 && messages[0]?.id === INITIAL_MESSAGE.id && (
          <div className="flex flex-col items-center justify-center gap-4 py-8 text-center text-muted">
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
        {messages.map((m) => (
          <div key={m.id}>
            <MessageBubble message={m} />
            {m.role === 'assistant' && m.content !== '' && (
              <div className="mt-1 flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void navigator.clipboard.writeText(m.content)}
                >
                  <Copy size={12} /> Copy
                </Button>
              </div>
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
            <Button type="button" size="sm" variant="ghost" onClick={clearConversation}>
              <Trash2 size={12} /> Clear
            </Button>
          )}
          {hasContent && !streaming && canRetry && (
            <Button type="button" size="sm" variant="ghost" onClick={retryLast}>
              <RotateCw size={12} /> Retry
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}

export default CopilotPage;
