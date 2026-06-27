// Standalone headless server entry — boots Colyseus + WebSocket transport so a
// real three/babylon client can connect. No rendering. Measurement runs go
// through `src/scenario.ts` instead.

import { listen } from '@colyseus/tools';
import { appConfig } from './app.js';

const DEFAULT_PORT = 2567;
const port = Number(process.env.PORT ?? DEFAULT_PORT);

void listen(appConfig, port);
