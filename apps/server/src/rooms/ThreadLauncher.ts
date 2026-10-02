import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationThreadShell,
  RoomsError,
  ThreadId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { Rooms } from "./Rooms.ts";

/** How much of the replaced thread's last reply rides along in the handoff. */
const HANDOFF_REPLY_MAX = 6000;

export interface StartThreadInput {
  /** The thread whose project, checkout, model and modes the new thread inherits. */
  readonly from: ThreadId;
  readonly text: string;
  readonly title: string;
  /** Another project, by title, workspace path or folder name. Defaults to `from`'s project. */
  readonly project?: string | undefined;
  /**
   * "same" works in `from`'s checkout (another project's root when `project` is set); "new" cuts
   * a worktree off `baseBranch`.
   */
  readonly worktree: "same" | "new";
  readonly baseBranch?: string | undefined;
  readonly branch?: string | undefined;
  /** A slug, null for no room, or undefined for every open room `from` is in. */
  readonly room?: string | null | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  /** A provider instance id or display name, and a model slug or name; resolved like the picker. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

export interface StartedThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly rooms: ReadonlyArray<string>;
}

/**
 * HQ fork: starts threads on the server's own initiative, for agents (start_thread) and for
 * Replace. A lean cousin of the client bootstrap in ws.ts, which is per-connection transport code:
 * no setup progress card, and the setup script runs in the background.
 */
export class ThreadLauncher extends Context.Service<
  ThreadLauncher,
  {
    readonly start: (input: StartThreadInput) => Effect.Effect<StartedThread, RoomsError>;
    /**
     * Starts a fresh thread in `threadId`'s checkout and rooms, seeded with a handoff (the room
     * notes and the old thread's last reply), then settles the old thread.
     */
    readonly replace: (input: {
      readonly threadId: ThreadId;
      readonly modelSelection?: ModelSelection | undefined;
    }) => Effect.Effect<StartedThread, RoomsError>;
  }
>()("t3/rooms/ThreadLauncher") {}

const fail = (message: string) => (cause: unknown) => new RoomsError({ message, cause });

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner;
  const rooms = yield* Rooms;
  const providers = yield* ProviderRegistry;
  const crypto = yield* Crypto.Crypto;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    uuid.pipe(Effect.map((id) => CommandId.make(`server:${tag}:${id}`)));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const shellOf = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.mapError(fail("Could not read threads.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new RoomsError({ message: `There is no thread ${threadId}.` })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const openRoomsOf = (threadId: ThreadId) =>
    rooms.list.pipe(
      Effect.map((list) =>
        list.filter((room) => room.archivedAt === null && room.threadIds.includes(threadId)),
      ),
    );

  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  const resolveProject = (
    ref: string | undefined,
    fallback: OrchestrationThreadShell["projectId"],
  ) =>
    Effect.gen(function* () {
      const all = yield* snapshots
        .getProjectShells()
        .pipe(Effect.mapError(fail("Could not read projects.")));
      if (ref === undefined) {
        const own = all.find((project) => project.id === fallback);
        if (!own) return yield* new RoomsError({ message: "The thread's project is gone." });
        return own;
      }
      const folder = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) ?? path;
      const found =
        all.find((project) => same(project.workspaceRoot, ref)) ??
        all.find((project) => same(project.title, ref)) ??
        all.find((project) => same(folder(project.workspaceRoot), ref));
      if (!found) {
        return yield* new RoomsError({
          message: `No T3 project matches "${ref}". Projects: ${all.map((project) => `${project.title} (${project.workspaceRoot})`).join(", ")}.`,
        });
      }
      return found;
    });

  const resolveModel = (provider: string | undefined, model: string | undefined) =>
    Effect.gen(function* () {
      const usable = (yield* providers.getProviders).filter(
        (each) => each.enabled && each.installed && each.models.length > 0,
      );
      const candidates = provider
        ? usable.filter(
            (each) =>
              same(each.instanceId, provider) ||
              same(each.driver, provider) ||
              (each.displayName !== undefined && same(each.displayName, provider)),
          )
        : usable;
      const matches = candidates.flatMap((each) =>
        each.models
          .filter((option) =>
            model === undefined
              ? option.isDefault === true
              : same(option.slug, model) ||
                same(option.name, model) ||
                (option.aliases ?? []).some((alias) => same(alias, model)),
          )
          .map((option) => ({ instanceId: each.instanceId, model: option.slug })),
      );
      const chosen =
        matches[0] ??
        (model === undefined && candidates[0]
          ? { instanceId: candidates[0].instanceId, model: candidates[0].models[0]!.slug }
          : undefined);
      if (!chosen) {
        return yield* new RoomsError({
          message: `No installed provider model matches ${[provider, model].filter(Boolean).join(" / ")}. Available: ${usable.map((each) => `${each.instanceId} (${each.models.map((option) => option.slug).join(", ")})`).join("; ")}.`,
        });
      }
      return chosen as ModelSelection;
    });

  const start = (input: StartThreadInput) =>
    Effect.gen(function* () {
      const source: OrchestrationThreadShell = yield* shellOf(input.from);
      const project = yield* resolveProject(input.project, source.projectId);
      const ownProject = project.id === source.projectId;
      // Another project's "same" checkout is its root.
      let worktreePath = ownProject ? source.worktreePath : null;
      let branch = ownProject ? source.branch : null;
      if (input.worktree === "new") {
        const token = (yield* uuid).replaceAll("-", "");
        const newBranch = input.branch ?? buildTemporaryWorktreeBranchName(() => token);
        const baseBranch = input.baseBranch ?? branch ?? "HEAD";
        const created = yield* git
          .createWorktree({
            cwd: project.workspaceRoot,
            refName: baseBranch,
            newRefName: newBranch,
            baseRefName: baseBranch,
            path: null,
          })
          .pipe(Effect.mapError(fail(`Could not create a worktree off ${baseBranch}.`)));
        worktreePath = created.worktree.path;
        branch = created.worktree.refName;
      }

      const threadId = ThreadId.make(yield* uuid);
      const createdAt = yield* nowIso;
      const modelSelection =
        input.modelSelection ??
        (input.provider !== undefined || input.model !== undefined
          ? yield* resolveModel(input.provider, input.model)
          : source.modelSelection);
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId("start-thread-create"),
          threadId,
          projectId: project.id,
          title: input.title,
          modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          branch,
          worktreePath,
          createdAt,
        })
        .pipe(Effect.mapError(fail("Could not create the thread.")));

      const seated =
        input.room === undefined
          ? (yield* openRoomsOf(source.id)).map((room) => room.slug)
          : input.room === null
            ? []
            : [input.room];
      yield* Effect.forEach(seated, (slug) => rooms.setThread({ slug, threadId, member: true }), {
        discard: true,
      });

      if (input.worktree === "new" && worktreePath) {
        // The agent can start while dependencies install; the script runs in a thread terminal.
        yield* setupScripts
          .runForThread({ threadId, projectId: project.id, worktreePath })
          .pipe(Effect.ignoreCause({ log: true }));
      }

      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("start-thread-turn"),
          threadId,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: input.text,
            attachments: [],
          },
          modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError(fail("The thread exists but its first turn did not start.")));

      return { threadId, title: input.title, worktreePath, branch, rooms: seated };
    });

  const replace = (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection | undefined;
  }) =>
    Effect.gen(function* () {
      const old = yield* shellOf(input.threadId);
      const detail = yield* snapshots.getThreadDetailById(old.id, { activityKinds: [] }).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      const lastReply =
        detail?.messages.findLast((message) => message.role === "assistant")?.text.trim() ?? "";
      const held = yield* openRoomsOf(old.id);
      const notes = held.flatMap((room) =>
        room.note ? [`Room "${room.title}" note:\n${room.note.body}`] : [],
      );
      const text = [
        `[Handoff via Replace. You are taking over from thread "${old.title}" (${old.id}), which is now settled. The user started this replacement.]`,
        `Continue that thread's work${old.worktreePath ? ` in the same worktree (${old.worktreePath})` : ""}. Before acting, call room_context, then check git status and recent commits. Treat everything below as a claim to verify against the code.`,
        ...notes,
        lastReply
          ? `The previous thread's last reply:\n${lastReply.length > HANDOFF_REPLY_MAX ? `…${lastReply.slice(-HANDOFF_REPLY_MAX)}` : lastReply}`
          : "The previous thread left no reply.",
      ].join("\n\n");
      const started = yield* start({
        from: old.id,
        text,
        title: old.title,
        worktree: "same",
        modelSelection: input.modelSelection,
      });
      yield* engine
        .dispatch({
          type: "thread.settle",
          commandId: yield* commandId("replace-settle"),
          threadId: old.id,
        })
        .pipe(Effect.mapError(fail("The new thread started, but the old one was not settled.")));
      return started;
    });

  return ThreadLauncher.of({ start, replace });
});

export const layer = Layer.effect(ThreadLauncher, make);
