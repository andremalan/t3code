import { createRoomsEnvironmentAtoms } from "@t3tools/client-runtime/state/rooms";

import { connectionAtomRuntime } from "../connection/runtime";

export const roomsEnvironment = createRoomsEnvironmentAtoms(connectionAtomRuntime);
