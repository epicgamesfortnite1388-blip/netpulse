import { UnixNetworkController } from './unix';
import { WindowsNetworkController } from './windows';

import type { PlatformNetworkController } from './types';

export function createPlatformController(): PlatformNetworkController {
  switch (process.platform) {
    case 'win32':
      return new WindowsNetworkController();
    default:
      return new UnixNetworkController();
  }
}

export type { PlatformNetworkController, IcmpPingOptions, TracerouteOptions } from './types';
