import { useEffect } from 'react';

import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

import { api } from '@/lib/api';

import type { AppSettings } from '@shared/models/settings';
import type { ReactNode } from 'react';

type ToastTone = 'ok' | 'warn' | 'error';

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: ReactNode;
}

interface ToastStore {
  toasts: Toast[];
  /** Mirrors `general.notifications` from settings; hydrated by <Toaster>. */
  notificationsEnabled: boolean;
  push: (tone: ToastTone, title: string, body?: ReactNode) => void;
  dismiss: (id: number) => void;
}

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  notificationsEnabled: true,
  push: (tone, title, body) => {
    if (!useToastStore.getState().notificationsEnabled) return;
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, tone, title, body }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function useToast() {
  return useToastStore((s) => s.push);
}

const ICONS: Record<ToastTone, ReactNode> = {
  ok: <CheckCircle2 size={16} className="text-ok" />,
  warn: <AlertTriangle size={16} className="text-warn" />,
  error: <XCircle size={16} className="text-danger" />,
};

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  // Hydrate the notification preference from the shared settings cache
  // (same queryKey as useThemeApplier — one fetch, no duplicates).
  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: AppSettings }>('/settings'),
    staleTime: 30_000,
    retry: 1,
  });
  const enabled = data?.settings?.general?.notifications ?? true;
  useEffect(() => {
    useToastStore.setState({ notificationsEnabled: enabled });
  }, [enabled]);
  return (
    // A live region, so a toast is actually announced. The container is ALWAYS
    // rendered, even with zero toasts: assistive tech only watches a region that
    // was already in the document when the content appeared, so mounting it
    // only when something arrives would leave the notification silent — which is
    // what this gap was. `polite`, not `assertive`: a finished test is worth
    // saying but never worth interrupting for. The icons are decorative because
    // the tone is already carried by the title text.
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-80 flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          // The visible text IS the notification, so it must not double as the
          // button's name — "Import profile, button" reads as a duplicate.
          aria-label={`Dismiss notification: ${t.title}`}
          className="animate-fade-up pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-line-strong bg-elevated px-4 py-3 text-left shadow-overlay transition-opacity hover:opacity-90"
        >
          <span className="mt-0.5" aria-hidden="true">
            {ICONS[t.tone]}
          </span>
          <span>
            <span className="block text-sm font-medium">{t.title}</span>
            {t.body && <span className="mt-0.5 block text-xs text-muted">{t.body}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
