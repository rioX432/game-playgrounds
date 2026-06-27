// Colyseus application config: register the authoritative room. Shared by the
// standalone server entry (src/index.ts) and the in-process scenario/test boot.

import type { ConfigOptions } from '@colyseus/tools';
import { ROOM_NAME } from './config.js';
import { GameRoom } from './rooms/GameRoom.js';

export const appConfig: ConfigOptions = {
  initializeGameServer: (gameServer) => {
    gameServer.define(ROOM_NAME, GameRoom);
  },
};
