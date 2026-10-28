import { lazy } from 'react';
import { createBrowserRouter } from 'react-router';

import { AppShell } from './AppShell';
import NotFoundPage from './NotFoundPage';

/**
 * Every page is its own chunk.
 *
 * This router used to import all 22 pages eagerly, which put the entire
 * application — the 3D globe, `three`, the chart library, every engine surface
 * — into one 3.1 MB entry chunk that the WebView had to parse before the
 * sidebar could paint. Lazy routes mean the shell boots from the small chunk
 * and each page arrives only when it is opened.
 *
 * The Suspense boundary that catches these lives in `AppShell`, around the
 * `Outlet`, so the sidebar stays interactive while a page loads; a boundary
 * here would have replaced the whole application with a spinner.
 *
 * `NotFoundPage` stays eager: it is tiny, and it is what renders when a URL
 * matches nothing — including a URL opened before any page chunk was fetched.
 */
const DashboardPage = lazy(() => import('@/features/dashboard/DashboardPage'));
const LiveMapPage = lazy(() => import('@/features/map/LiveMapPage'));
const DiagnosticsPage = lazy(() => import('@/features/diagnostics/DiagnosticsPage'));
const SpeedTestPage = lazy(() => import('@/features/speed-test/SpeedTestPage'));
const DnsPage = lazy(() => import('@/features/dns/DnsPage'));
const GamingPage = lazy(() => import('@/features/gaming/GamingPage'));
const IranConnectivityPage = lazy(() => import('@/features/iran/IranConnectivityPage'));
const IpPage = lazy(() => import('@/features/ip/IpPage'));
const RoutesPage = lazy(() => import('@/features/routes/RoutesPage'));
const CloudflarePage = lazy(() => import('@/features/cloudflare/CloudflarePage'));
const NodeExplorerPage = lazy(() => import('@/features/nodes/NodeExplorerPage'));
const NodeDetailPage = lazy(() => import('@/features/nodes/NodeDetailPage'));
const NodeSourcesPage = lazy(() => import('@/features/nodes/NodeSourcesPage'));
const ServersPage = lazy(() => import('@/features/servers/ServersPage'));
const VpnPage = lazy(() => import('@/features/vpn/VpnPage'));
const OptimizerPage = lazy(() => import('@/features/optimizer/OptimizerPage'));
const HistoryPage = lazy(() => import('@/features/history/HistoryPage'));
const EventsPage = lazy(() => import('@/features/events/EventsPage'));
const AccountPage = lazy(() => import('@/features/account/AccountPage'));
const EngineManagerPage = lazy(() => import('@/features/engines/EngineManagerPage'));
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'));
const SystemHealthPage = lazy(() => import('@/features/health/SystemHealthPage'));

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'map', element: <LiveMapPage /> },
      { path: 'diagnostics', element: <DiagnosticsPage /> },
      { path: 'speed-test', element: <SpeedTestPage /> },
      { path: 'dns', element: <DnsPage /> },
      { path: 'gaming', element: <GamingPage /> },
      { path: 'iran', element: <IranConnectivityPage /> },
      { path: 'ip', element: <IpPage /> },
      { path: 'routes', element: <RoutesPage /> },
      { path: 'cloudflare', element: <CloudflarePage /> },
      { path: 'nodes', element: <NodeExplorerPage /> },
      { path: 'nodes/:id', element: <NodeDetailPage /> },
      { path: 'nodes-sources', element: <NodeSourcesPage /> },
      { path: 'servers', element: <ServersPage /> },
      { path: 'vpn', element: <VpnPage /> },
      { path: 'optimizer', element: <OptimizerPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'events', element: <EventsPage /> },
      { path: 'account', element: <AccountPage /> },
      { path: 'engines', element: <EngineManagerPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'health', element: <SystemHealthPage /> },
      // Last child, so it only matches what nothing above claimed. Without it
      // an unmatched URL escapes to React Router's own boundary and replaces
      // the whole shell with a developer-facing error screen.
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
