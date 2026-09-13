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
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className="animate-fade-up pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-line-strong bg-elevated px-4 py-3 text-left shadow-2xl transition-opacity hover:opacity-90"
        >
          <span className="mt-0.5">{ICONS[t.tone]}</span>
          <span>
            <span className="block text-sm font-medium">{t.title}</span>
            {t.body && <span className="mt-0.5 block text-xs text-muted">{t.body}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
