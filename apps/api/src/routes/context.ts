import type { AppConfig } from '../config';
import type { AuthHooks } from '../auth';
import type { DbHandle } from '../db/client';
import type {
  BufferbloatRepository,
  DnsBenchmarksRepository,
  EventsRepository,
  GamingRepository,
  IranMeasurementsRepository,
  IranSessionsRepository,
  MapObservationsRepository,
  NodeEventsRepository,
  NodeHealthRepository,
  NodeAddressesRepository,
  NodeSourcesRepository,
  NodeTestsRepository,
  PublicNodesRepository,
  PublicSourcesRepository,
  RawDocumentsRepository,
  RouteComparisonRepository,
  ScanJobsRepository,
  ScanRepository,
  ServerHealthRepository,
  ServersRepository,
  SettingsRepository,
  SourceFetchesRepository,
  StabilityRepository,
  TestsRepository,
  TestEndpointsRepository,
  VpnConnectionRepository,
  VpnProfileRepository,
} from '../db/repositories';
import type { RealtimeBus } from '../realtime/bus';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { ProviderRegistry } from '../providers/registry';
import type { ReputationProvider } from '../providers/reputation/types';
import type { DiagnosticsService } from '../services/diagnosticsService';
import type { DnsService } from '../services/dnsService';
import type { EndpointService } from '../services/endpointService';
import type { EventService } from '../services/eventService';
import type { GamingService } from '../services/gamingService';
import type { HealthMonitorService } from '../services/healthMonitor';
import type { IpInfoService } from '../services/ipInfoService';
import type { IranService } from '../services/iranService';
import type { MapService } from '../services/mapService';
import type { OptimizerService } from '../services/optimizerService';
import type { PingService } from '../services/pingService';
import type { SelectionService } from '../services/selectionService';
import type { RouteService } from '../services/routeService';
import type { ScheduleService } from '../services/scheduleService';
import type { SettingsService } from '../services/settingsService';
import type { VpnSelfTestService } from '../services/vpnSelfTestService';
import type { SpeedService } from '../services/speedService';
import type { StabilityService } from '../services/stabilityService';
import type { VpnRegistry } from '../vpn/vpnService';
import type { ElevationBroker } from '../vpn/elevationBroker';
import type { ProxyTunnelService } from '../services/proxyTunnel';
import type { KillSwitchService } from '../services/killSwitch';
import type { GatewayMemoryService } from '../services/gatewayMemory';
import type { VpnHistoryService } from '../services/vpnHistory';
import type { NodeDiscoveryService } from '../services/nodeDiscovery';
import type { NodeSecretVault } from '../services/nodeSecretVault';
import type { NodesService } from '../services/nodesService';
import type { SourceRefreshScheduler } from '../services/nodeSourceRegistry';
import type { Logger } from '../logger';

export interface AppContext {
  config: AppConfig;
  auth: AuthHooks;
  db: DbHandle;
  repos: {
    settings: SettingsRepository;
    events: EventsRepository;
    tests: TestsRepository;
    servers: ServersRepository;
    serverHealth: ServerHealthRepository;
    scans: ScanRepository;
    stability: StabilityRepository;
    bufferbloat: BufferbloatRepository;
    dnsBenchmarks: DnsBenchmarksRepository;
    gaming: GamingRepository;
    iranSessions: IranSessionsRepository;
    iranMeasurements: IranMeasurementsRepository;
    mapObservations: MapObservationsRepository;
    routeComparisons: RouteComparisonRepository;
    vpnConnections: VpnConnectionRepository;
    vpnProfiles: VpnProfileRepository;
    publicSources: PublicSourcesRepository;
    sourceFetches: SourceFetchesRepository;
    rawDocuments: RawDocumentsRepository;
    publicNodes: PublicNodesRepository;
    nodeAddresses: NodeAddressesRepository;
    nodeSources: NodeSourcesRepository;
    nodeTests: NodeTestsRepository;
    nodeHealth: NodeHealthRepository;
    scanJobs: ScanJobsRepository;
    testEndpoints: TestEndpointsRepository;
    nodeEvents: NodeEventsRepository;
  };
  bus: RealtimeBus;
  controller: PlatformNetworkController;
  reputationProviders: ProviderRegistry<ReputationProvider>;
  vpn: VpnRegistry;
  elevationBroker: ElevationBroker;
  services: {
    events: EventService;
    settings: SettingsService;
    ipInfo: IpInfoService;
    ping: PingService;
    route: RouteService;
    dns: DnsService;
    speed: SpeedService;
    endpoint: EndpointService;
    gaming: GamingService;
    diagnostics: DiagnosticsService;
    stability: StabilityService;
    optimizer: OptimizerService;
    selection: SelectionService;
    healthMonitor: HealthMonitorService;
    schedule: ScheduleService;
    vpnSelfTest: VpnSelfTestService;
    tunnel: ProxyTunnelService;
    killSwitch: KillSwitchService;
    gatewayMemory: GatewayMemoryService;
    discovery: NodeDiscoveryService;
    vpnHistory: VpnHistoryService;
    map: MapService;
    iran: IranService;
    nodes: NodesService;
    /** Encrypted at-rest vault for node credentials (uuid / password). */
    nodeVault?: NodeSecretVault;
    sourceScheduler?: SourceRefreshScheduler;
  };
  log: Logger;
}
