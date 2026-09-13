import { createBrowserRouter } from 'react-router';

import { AppShell } from './AppShell';
import SystemHealthPage from '@/features/health/SystemHealthPage';
import CloudflarePage from '@/features/cloudflare/CloudflarePage';
import DashboardPage from '@/features/dashboard/DashboardPage';
import DiagnosticsPage from '@/features/diagnostics/DiagnosticsPage';
import DnsPage from '@/features/dns/DnsPage';
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
      { path: 'settings', element: <SettingsPage /> },
      { path: 'health', element: <SystemHealthPage /> },
    ],
  },
]);
