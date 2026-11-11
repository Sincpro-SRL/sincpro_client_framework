import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import type { EventKey } from "@sincpro/client-framework/core/domain/consumers";
import { EVENT_NAME, type Executable } from "@sincpro/client-framework/core/domain/dto";
import type {
  Cause,
  ExecutionFailed,
  Interceptor,
} from "@sincpro/client-framework/core/domain/pipeline";
import {
  EventHandler,
  type HandledEvent,
} from "@sincpro/client-framework/core/domain/services";
import {
  type DtoIdentity,
  isEventClass,
  isEventDescriptor,
  keyIdentity,
} from "@sincpro/client-framework/core/services/dto-keys";
import {
  type Announcer,
  executeService,
  failedAt,
} from "@sincpro/client-framework/core/services/execution";
import type { Outcome } from "@sincpro/client-framework/observability/domain/tracing";
import { observabilityNow } from "@sincpro/client-framework/observability/infrastructure/registry";

/** An event handler's class, as it is registered. */
export type HandlerClass = new () => object;

/** A registered event handler: its name, its class, the events it handles. */
export type HandlerRegistration = {
  readonly name: string;
  readonly Handler: HandlerClass;
  readonly events: readonly EventKey[];
};

/**
 * What `handler(...)` answers: the function that registers an event handler — called with the
 * class, or applied as a decorator (standard or legacy).
 */
export type HandlerRegistrar<E extends HandledEvent> = <
  // A property, not a method: TypeScript then checks that `handle` takes every event listed.
  S extends new () => { handle: (event: NoInfer<E>) => unknown },
>(
  Handler: S,
  decorator?: ClassDecoratorContext<S>,
) => S;

/**
 * The events a handler is registered for — one or N —, each an event's class or a generated
 * event's entry, with a valid wire name, none twice.
 */
export function eventKeysOf(events: EventKey | readonly EventKey[]): readonly EventKey[] {
  const keys: readonly EventKey[] = Array.isArray(events) ? events : [events as EventKey];
  if (keys.length === 0) throw new TypeError("An event handler handles one event at least");
  const wires = new Set<string>();
  for (const key of keys) {
    if (!isEventClass(key) && !isEventDescriptor(key)) {
      throw new TypeError(
        "An event handler is registered for events: a DomainEvent's class, or a generated event's entry",
      );
    }
    const wire = keyIdentity(key).wire ?? "";
    if (!EVENT_NAME.test(wire)) {
      throw new Error(
        `${wire || "An event"} is not an event's name: <context>.<aggregate>.vN.<fact>`,
      );
    }
    if (wires.has(wire)) throw new Error(`The handler lists ${wire} twice`);
    wires.add(wire);
  }
  return keys;
}

/**
 * Registers `Handler` with `register`, at once or — applied as a standard decorator — once its
 * class is defined; its name is the class's as the code wrote it (a decorator's `context.name`,
 * untouched by a minifier), else its `name`.
 */
export function handlerRegistrar<E extends HandledEvent>(
  register: (Handler: HandlerClass, name: string) => void,
): HandlerRegistrar<E> {
  return (Handler, decorator) => {
    const take = () => {
      if (!(Handler.prototype instanceof EventHandler)) {
        throw new TypeError("An event handler extends EventHandler");
      }
      const name = decorator?.name ?? Handler.name;
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error(
          "An event handler is a named class: its name is said in spans and logs",
        );
      }
      register(Handler, name);
    };
    if (decorator) decorator.addInitializer(take);
    else take();
    return Handler;
  };
}

/** Whether a handler registered for `key` handles the event `known` identifies. */
export function handles(key: EventKey, known: DtoIdentity): boolean {
  if (known.type !== undefined) return key === known.type;
  return isEventDescriptor(key) && key.name === known.wire;
}

/** What a run of an event handler needs besides the handler and the event. */
export type HandlerRun = {
  readonly owner: string;
  readonly name: string;
  readonly dependencies: ReadonlyMap<string, unknown>;
  readonly context: () => ContextValues;
  readonly cause?: Cause;
  readonly boundedContextOf?: (execution: Execution) => object;
  readonly expected: (error: unknown) => boolean;
  readonly interceptors: readonly Interceptor[];
  readonly announce: Announcer;
  /** Told once when a failure escapes the handler. */
  readonly failed: (heard: ExecutionFailed) => void;
};

/**
 * Runs an event handler in the pipeline of every use case, in its own layer (`event_handler`):
 * its span `<owner>/<Handler>`, continuing the message's flow and trace; a failure is observed
 * there, told once (`failed`) and thrown — a handler has no error handlers: what it executes
 * answers in its own bounded context.
 */
export async function runHandler(
  instance: object,
  event: Executable,
  run: HandlerRun,
): Promise<unknown> {
  const wire = keyIdentityOf(event);
  try {
    return await executeService(instance, event, {
      boundedContext: run.owner,
      name: run.name,
      layer: "event_handler",
      attributes: wire ? { "sincpro.event": wire } : {},
      dependencies: run.dependencies,
      context: run.context,
      ...(run.cause ? { cause: run.cause } : {}),
      featureBus: () => ({}),
      ...(run.boundedContextOf ? { boundedContextOf: run.boundedContextOf } : {}),
      expected: run.expected,
      handlers: [],
      interceptors: run.interceptors,
      announce: run.announce,
    });
  } catch (error) {
    const at = failedAt(error);
    let outcome: Outcome = "failed";
    try {
      outcome =
        at?.outcome ??
        (run.expected(error) ? "refused" : observabilityNow().outcomeOf(error));
    } catch {
      // An outcome that cannot be told is a failure.
    }
    try {
      run.failed({
        executable: at?.executable ?? event,
        execution: at?.execution,
        layer: at?.layer,
        error,
        outcome,
      });
    } catch {
      // Telling a listener never changes the failure.
    }
    throw error;
  }
}

/** An event's wire name, for its span. */
function keyIdentityOf(event: Executable): string | undefined {
  const name = (event as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}
