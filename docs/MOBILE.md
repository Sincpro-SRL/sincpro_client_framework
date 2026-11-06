# @sincpro/mobile on @sincpro/client-framework

How @sincpro/mobile adopts this package: what it takes from here, what stays its own, and the
order to move in. The rule is the same for every platform — **what is transversal comes from
here; what needs the phone stays in mobile**: SQLite, its queues, its migrations and workers, its
screens, how a value is shown to a person.

```mermaid
flowchart LR
  subgraph cf["@sincpro/client-framework · every platform"]
    direction TB
    bc["UseBoundedContext · Feature · ApplicationService<br/>a span and a report per use case"]
    process["configureProcess · processContext<br/>Tracer · ErrorReporter · ContextStore ports"]
    wire["Transport · restTransport · clientOf<br/>valuesOf · Decimal · Money · ids · day and instant"]
  end
  subgraph mobile["@sincpro/mobile · the phone"]
    direction TB
    kernel["Kernel · DomainModule<br/>migrations · subscribers · crons"]
    sqlite["SQLite: the offline Transport, repositories"]
    telemetry["its OpenTelemetry provider,<br/>span queue and exporter"]
    logs["Loki: its logs — not a Tracer"]
    store["MMKV: the ContextStore"]
    ui["screens, formatting, pickers"]
  end
  kernel -->|"each module holds a bounded context"| bc
  telemetry -->|"handed in as a Tracer"| process
  store -->|"implements"| process
  sqlite -->|"implements"| wire
  ui -->|"runs use cases"| bc
```

## What maps to what

| mobile today                                                                                     | from client-framework                                                                                          | why it moves                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Feature<Deps>` with `this.deps`, spans named `ClassName.method`                                 | `class Feature extends BaseFeature<Dependencies>`, `this.client`, spans `<bounded context>/<Service>.<method>` | A release build minifies class names: `new.target.name` becomes `a.b`. The registered name never changes.                                                                                                                      |
| `ApplicationService<TFeatures>` with `this.features.x`                                           | `this.feature.Issues.close(…)`                                                                                 | The same rule — it composes the Features of its own bounded context — with the services registered once.                                                                                                                       |
| `ContextManager`, `StackContextManager`, `WithContext`, `PropagateContext`                       | `processContext`, `project.context`, `project.scoped({…})`, `this.context`                                     | A global stack mixes the parents of two calls running at once; here each call carries its execution. The levels are sincpro_framework's.                                                                                       |
| `DomainModule` (`key`, `repositories()`)                                                         | `new UseBoundedContext<Dependencies>(key)` with `addDependency` for each repository                            | A module's services and what they need become the bounded context; `migrations()`, `subscribers()`, `crons()` and `persistOnReset()` stay the module's.                                                                        |
| `Kernel`, `createApp(AppConfig)`                                                                 | `configureProcess({ tracer, reporter, context })`, once, before the first screen                               | What every use case runs with is the process's; the Kernel keeps the database, the migrations and the workers.                                                                                                                 |
| `init_telemetry` (OTLP client, SQLite span queue, sampler)                                       | the `Tracer` port: `openTelemetryTracer(provider.getTracer("app"))` from `./opentelemetry`                     | The span per use case, its parent and the `traceparent` on every request are the same on the web; the provider, the queue and the exporter are the phone's. Loki takes logs, not spans: it is no `Tracer`, and stays mobile's. |
| error reporting                                                                                  | the `ErrorReporter` port: `sentryReporter({ captureException: Sentry.captureException })` from `./sentry`      | Only what nobody expected is reported, once, with its trace id — a 4xx the server explained is the business answering.                                                                                                         |
| `generateUUID()` — over `newEntityId()` since mobile#23                                          | `newEntityId()`, `isEntityId()`, `momentOf()`                                                                  | Done. The backend writes 32 hex; an id minted on the phone is one the server accepts as a new record's key.                                                                                                                    |
| `monetary.ts` — computes with `Decimal`, answers a `number`                                      | `Decimal`, `Money` (`{ amount, currency }`)                                                                    | An amount answered as a `number` is a float again, the thing the backend sends text to avoid. Keep the `Decimal` until it is shown; `formatTwoDecimals` fed with text.                                                         |
| `date.ts` — `isDay`, `dayOf` since mobile#23; `dayjs`                                            | `isDay`, `dayOf`, `wallTimeOf`, `instantOf`, `installTimeZone`                                                 | Done for telling a day and the company's «today». A day is held as text, never in a `Date`; `dayjs` stays for formatting.                                                                                                      |
| `serializer.ts` over `valuesOf` since mobile#23; `JsonSerializerAdapter.cleanData` still its own | `valuesOf` / `readValues` / `pack` / `unpack`                                                                  | One set of wire rules: decimals as text, bytes tagged, a day kept a day. `canonicalize` and its SHA-256 stay mobile's, written over `valuesOf` — `cleanData` is what is left.                                                  |
| its HTTP calls                                                                                   | `restTransport` and the generated `clientOf(transport)` (`sincpro-client generate`)                            | The routes, the bodies and the answers are typed from the service's contract, and each request carries its use case's trace.                                                                                                   |
| SQLite reads and writes offline                                                                  | implement the `Transport` port over SQLite                                                                     | A use case does not know whether it is online: the same `this.client` over another transport.                                                                                                                                  |

What stays mobile's and does not come here: SQLite and its repositories, migrations, the dead
letter queue, crons and the flush worker, Loki logs, `event_driven` subscribers, screens and the
design of the phone — and the SQLite `Transport`: nothing here speaks SQLite, mobile writes it.

## Which version

Below 1.0 a caret never crosses the minor: `^0.4.0` installs 0.4.x, never 0.5 — moving to a new
minor is a change to `package.json`, made on purpose. What 0.5 adds, asked for with `^0.5.0`:

- `screensTransport(transport)` — what a screen reads and writes, traced as a use case;
- `reportError(error, where)` — what fails outside a use case (a subscriber, a worker, a screen)
  reaches the process's reporter once, only when it failed;
- `this.span` inside a use case, and `CONTEXT_HEADER`;
- a stricter `isDay` (a day the calendar does not have, `2026-02-30`, is no longer a day) and a
  bare day never read as an instant by `wallTimeOf` / `dayOf`.

`Decimal`, `Money`, `valuesOf` and the ids are there since 0.4.

`sincpro-client check` (the layers of an application, in its `make doctor`) is for an application
built on mobile — Distribution, Tickets —, whose `src/domains/` keeps the layers; @sincpro/mobile
itself is the platform, not an application.

## The setup, on a phone

```ts
// index.js — before anything imports @sincpro/client-framework
import "react-native-get-random-values"; // or expo-crypto's getRandomValues polyfill
import "react-native-url-polyfill/auto";
```

```ts
// entrypoints/main.ts — the process, once
import { configureProcess, processContext } from "@sincpro/client-framework";
import { openTelemetryTracer } from "@sincpro/client-framework/opentelemetry";
import { sentryReporter } from "@sincpro/client-framework/sentry";
import * as Sentry from "@sentry/react-native";

configureProcess({
  tracer: openTelemetryTracer(provider.getTracer("pos-mobile")), // mobile's provider and queue
  reporter: sentryReporter({ captureException: Sentry.captureException }),
  context: mmkvContexts(),
});
processContext.set({ tenant_id: session.tenant, company_id: session.company });
```

The bounded contexts are set up exactly as on the web (`infrastructure/dependencies.ts`,
`infrastructure/bounded_context.ts`, `services/`, `index.ts` — see the README), with mobile's
repositories as dependencies:

```ts
export interface SalesDependencies {
  client: SalesClient; // generated, over restTransport or the SQLite transport
  orders: OrderRepository; // mobile's SQLite repository
}
```

A `DomainModule` keeps what is the phone's and hands its services to the bounded context:

```ts
export class SalesModule extends DomainModule {
  readonly key = "sales";
  readonly name = "Sales";
  readonly boundedContext = sales; // export const sales = configSalesBoundedContext("sales").register(…)
  migrations() {
    return salesMigrations;
  }
  subscribers() {
    return [new OrderPaidSubscriber(sales)];
  }
}
```

## The context store over MMKV

The context lives in a `ContextStore`; on a phone, MMKV is synchronous, which is what the port
asks (a use case reads its context where a gesture starts and never waits for it).

```ts
import { type ContextStore, plainCodec } from "@sincpro/client-framework";
import { MMKV } from "react-native-mmkv";

export function mmkvContexts(storage = new MMKV({ id: "sincpro-context" })): ContextStore {
  const versions = new Map<string, number>();
  const moved = (key: string) => versions.set(key, (versions.get(key) ?? 0) + 1);
  // A change made anywhere moves the key's version, so a level reads it again.
  storage.addOnValueChangedListener(moved);
  return {
    load(key) {
      const text = storage.getString(key);
      return text === undefined ? undefined : plainCodec.loads(text);
    },
    save(key, values) {
      storage.set(key, plainCodec.dumps(values));
      moved(key);
    },
    delete(key) {
      storage.delete(key);
      moved(key);
    },
    version: (key) => versions.get(key) ?? 0,
    watch(key, listener) {
      const listening = storage.addOnValueChangedListener((changed) => {
        if (changed === key) listener();
      });
      return () => listening.remove();
    },
  };
}
```

AsyncStorage is asynchronous: hold the context in memory (`memoryContexts()`), load it from
AsyncStorage before the first screen, and write it through on each change.

When the context changes — another company chosen —, a screen reads again and keeps what is on
it. On the web `FrameworkProvider` does it; on a phone it is a hook of mobile's over
`processContext.watch`:

```ts
import { processContext } from "@sincpro/client-framework";
import { useSyncExternalStore } from "react";

/** The context's values — one object per change: a reading lists it as a dependency and re-reads. */
export function useProcessContext() {
  const values = () => processContext.values;
  return useSyncExternalStore(processContext.watch, values, values);
}
```

## What the phone must give

| Asked of the platform                      | Hermes (React Native)                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.getRandomValues` (ids, retry keys) | a polyfill: `react-native-get-random-values` or expo-crypto's                                                                                               |
| `URL`, `URLSearchParams`                   | `react-native-url-polyfill/auto` — RN's own resolves relative paths poorly                                                                                  |
| `BigInt` (`Decimal`, `Money`)              | yes                                                                                                                                                         |
| `Intl.DateTimeFormat` with `timeZone`      | check `wallTimeOf("2026-03-12T14:30:00Z", "America/La_Paz") === "2026-03-12T10:30"` on the devices; else `@formatjs/intl-datetimeformat` with its zone data |
| `fetch`, `AbortSignal`                     | yes                                                                                                                                                         |
| `@opentelemetry/api`                       | from 1.9, the version mobile runs                                                                                                                           |

## The order to move in

1. **The wire values** — `newEntityId`, `Decimal`/`Money`, `valuesOf`, the day and the instant.
   They fix real bugs (a float amount, a day that moves, ids the backend does not accept) and
   touch no architecture. Mostly done (mobile#23): ids, `serializer.ts`, `isDay` and `dayOf` are this
   package's; an amount answered as a `number` and `cleanData` are what is left.
2. **The process** — `configureProcess` with mobile's tracer and reporter, and `mmkvContexts`.
3. **One bounded context at a time** — its Features on `BaseFeature<Dependencies>`, registered,
   used as `sales.Orders.place(…)`; the old `Feature` and the context stack go when the last one
   moved.
4. **The generated client** for each service with a contract, over `restTransport` online and the
   SQLite transport offline — mobile's to write, over the `Transport` port.

The words are the shared ones ([`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md)): a module that
holds a bounded context is still called a bounded context in code and docs.
