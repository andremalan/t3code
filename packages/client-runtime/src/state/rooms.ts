import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** HQ fork: rooms group an environment's threads. The server pushes the full list on every change. */
export function createRoomsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Mutations run one at a time per environment so a drag cannot land before the create it follows.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    rooms: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:rooms",
      tag: WS_METHODS.subscribeRooms,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:rooms:create",
      tag: WS_METHODS.roomsCreate,
      scheduler,
      concurrency,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:rooms:update",
      tag: WS_METHODS.roomsUpdate,
      scheduler,
      concurrency,
    }),
    reorder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:rooms:reorder",
      tag: WS_METHODS.roomsReorder,
      scheduler,
      concurrency,
    }),
    setThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:rooms:set-thread",
      tag: WS_METHODS.roomsSetThread,
      scheduler,
      concurrency,
    }),
  };
}
