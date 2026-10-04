import { createBrowserRouter } from 'react-router';

import { AppShell } from './AppShell';
import NotFoundPage from './NotFoundPage';
import AccountPage from '@/features/account/AccountPage';
import SystemHealthPage from '@/features/health/SystemHealthPage';
import CloudflarePage from '@/features/cloudflare/CloudflarePage';
import DashboardPage from '@/features/dashboard/DashboardPage';
import DiagnosticsPage from '@/features/diagnostics/DiagnosticsPage';
import DnsPage from '@/features/dns/DnsPage';
import EngineManagerPage from '@/features/engines/EngineManagerPage';
import EventsPage from '@/features/events/EventsPage';
import GamingPage from '@/features/gaming/GamingPage';
import HistoryPage from '@/features/history/HistoryPage';
import IranConnectivityPage from '@/features/iran/IranConnectivityPage';
import IpPage from '@/features/ip/IpPage';
import LiveMapPage from '@/features/map/LiveMapPage';
import NodeExplorerPage from '@/features/nodes/NodeExplorerPage';
import NodeDetailPage from '@/features/nodes/NodeDetailPage';
import NodeSourcesPage from '@/features/nodes/NodeSourcesPage';
import OptimizerPage from '@/features/optimizer/OptimizerPage';
import RoutesPage from '@/features/routes/RoutesPage';
import ServersPage from '@/features/servers/ServersPage';
import SettingsPage from '@/features/settings/SettingsPage';
import SpeedTestPage from '@/features/speed-test/SpeedTestPage';
import VpnPage from '@/features/vpn/VpnPage';

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
