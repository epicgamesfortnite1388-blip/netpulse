import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RouterProvider } from 'react-router';

import { installExternalNavigationGuard } from '@/lib/externalNavigation';
import { initTransport } from '@/lib/transport';
import { router } from './app/router';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { Toaster } from '@/components/Toaster';
import { TooltipProvider } from '@/components/ui/Tooltip';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Every external exit from the webview (left/middle/keyboard clicks on any
// anchor, plus a link dragged onto the page) goes through the OS opener. The
// guard is installed before the first render so a link in the very first frame
// cannot navigate the app away from itself.
installExternalNavigationGuard();

// Resolve the transport (desktop sidecar via Tauri IPC, or same-origin web)
// BEFORE the first render so no component fires a request against an unknown
// base URL. Desktop failure here means the Rust core is unhealthy — surface it.
initTransport()
  .then((t) => {
    if (t.mode === 'desktop') console.info('[netpulse] desktop transport ready:', t.apiBase);
  })
  .catch((err) => console.error('[netpulse] transport init failed:', err))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AppErrorBoundary>
              <RouterProvider router={router} />
            </AppErrorBoundary>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
  });
