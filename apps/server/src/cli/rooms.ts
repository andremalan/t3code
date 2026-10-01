import * as NodeOS from "node:os";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { importHqRooms } from "../rooms/Rooms.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const stateFlag = Flag.String("state").pipe(
  Flag.withDescription("HQ state directory holding hq.sqlite and config/ROOM-ORDER.json."),
  Flag.optional,
);

/** HQ fork: one-time copy of HQ's rooms into this server's database. Safe to rerun. */
const importHqCommand = Command.make("import-hq", {
  ...projectLocationFlags,
  state: stateFlag,
}).pipe(
  Command.withDescription("Import rooms and their threads from HQ."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const stateDir = Option.getOrElse(flags.state, () => `${NodeOS.homedir()}/tmp/cc`);
      const result = yield* importHqRooms(stateDir).pipe(
        Effect.provide(
          SqlitePersistenceLayerLive.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
      yield* Console.log(
        `Imported ${result.rooms} rooms and ${result.threads} memberships into ${config.dbPath}. ` +
          `Skipped ${result.skippedMembers} members with no live T3 thread.`,
      );
    }),
  ),
);

export const roomsCommand = Command.make("rooms").pipe(
  Command.withDescription("Manage rooms."),
  Command.withSubcommands([importHqCommand]),
);
