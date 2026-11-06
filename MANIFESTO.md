# Manifesto

> **@sincpro/client-framework is the client side of
> [sincpro_framework](https://github.com/Sincpro-SRL/sincpro_framework), for every platform:
> where a client's logic lives, how every use case is traced and reported, how an application is
> made of domains, and how it talks to a service through a client generated from that service's
> contract. No React, no DOM, no platform.**

This is the founding statement of the repository: what it is responsible for, what it is not,
how it is composed and where it is going. Every change is measured against it. If a change needs
something this page does not say, change this page first, and say why.

## Why it exists

Sincpro builds business software with one backend framework and several clients: the web
([@sincpro/web-framework](https://github.com/Sincpro-SRL/sincpro_web_framework)), mobile
([@sincpro/mobile](https://github.com/Sincpro-SRL/sincpro_mobile)), server-side renders, scripts,
tests. Each one was growing the same core on its own — mobile wrote `Feature` and
`ApplicationService` with interceptors; the web wrote the transport, the entities and the
generator from the contract — and a use case written for one could not run on the other.

The backend already answers how a use case is written, traced and reported. This package gives
every client the same answer, once: **a Feature written here runs in a browser, on a phone, in a
server-side render, in a script and in a test, unchanged.**

## What it is responsible for

1. **Services.** A `Feature` is a facade over one part of the domain, each public method a use
   case; an `ApplicationService` composes the Features of its own bounded context — never another
   ApplicationService. All of a client's logic lives in them, with their dependencies typed and
   injected by their bounded context (`this.client`, `this.session`).
2. **Interception.** Every public method of a use case passes through interceptors, and that is
   what makes the defaults free: the trace, the error report, the context. The author of a
   Feature writes none of it.
3. **Observability, as ports.** `Tracer` and `ErrorReporter` are the contract: one span per use
   case, named `<bounded context>/<Service>.<method>` like the backend's; the unexpected reported
   with its trace id; what the server already explained (a validation, a conflict) not reported.
   The platform plugs the implementation — OpenTelemetry, GlitchTip, a queue on the phone, memory
   in a test — once, for the process (`configureProcess`).
4. **Context.** The levels a call sees — the process, its bounded context, a scope — read once
   where a gesture starts and inherited by everything it runs, and what travels to the server with
   it (`traceparent`, `sincpro-context`). Where the values live is a port (`ContextStore`) each
   platform implements with its own technology; the execution is carried by each call, never kept
   in a global stack: two calls at once never mix their parents.
5. **Bounded contexts.** Set up like the backend's — its dependencies (`addDependency`), its
   Features and ApplicationServices, registered once — and used through one light object:
   `project.Issues.close(input)`. An application is the set of bounded contexts it loads; they
   never import each other's insides.
6. **The client.** The `Transport` port and its implementations (REST, memory), `entity()` with
   typed commands and answers, the service's client contract, model definitions read once from
   the server, client-side ids (UUID v7) and the server's `Problem`.
7. **The generator.** From a service's client contract to each domain's types, client and
   entities — generated, never edited, and as platform-neutral as everything else here.
8. **Testing.** An in-memory transport, tracer and reporter, so a use case is proven in Node with
   nothing else.

## What it is not

- **Not a UI.** No React, no components, no hooks: drawing belongs to @sincpro/web-framework on
  the web and to @sincpro/mobile on a phone.
- **Not a shell, a router or a window manager.** Where things open is the platform's.
- **Not a cache or a state manager.** Holding server state for screens is the platform's job,
  with the libraries that do it best. The context is not one either: a handful of values every
  use case runs with — the tenant, the company — kept wherever the platform says.
- **Not offline storage.** SQLite on a phone or IndexedDB in a point of sale are platform
  adapters.
- **Not a telemetry or error-tracking SDK.** It defines the ports and calls them. For the
  common vendors it offers optional adapters (`./opentelemetry`, `./sentry`) that wrap what the
  application built — its provider, its client, with its endpoint and its DSN. It initialises
  nothing and registers nothing global; an application that does not import them installs
  nothing and ships nothing, and without a tracer or a reporter everything runs the same.
- **Not where business rules live.** The server keeps them; a client reads what it publishes.
- **Not an event bus**, and not a dispatcher: a use case is executed by calling it, and the
  interceptors are what make that call traced and reported.

## What we believe

1. **Platform-neutral, or it does not go in.** It runs on Node, in a browser and on React Native.
   What it needs from a platform it asks through a port, never by reaching for it. The build
   enforces it.
2. **The backend's words.** Bounded context, Feature, ApplicationService, dependencies, context,
   process, the span name — the same as sincpro_framework, so whoever knows the backend already
   knows the client.
3. **Nothing escapes the interceptors.** Reusing a use case is calling it through its bounded
   context. A helper that wraps one skips the trace and the report — that is how an incident ends
   up with nothing to look at.
4. **Context travels with the call.** Never in a global stack: clients run many things at once.
5. **A port where there are two implementations, a class where there is one.** `Transport` has
   REST and memory; `Tracer` has a platform's and a test's; `ContextStore` has the browser's, the
   phone's and memory.
6. **Generated, never edited.** Applications extend by composition; regenerating never loses
   work.
7. **The server is the source of truth.** A client reads the model, the preview and the refusal,
   and never re-implements a rule.
8. **Small, and paid for only when used.** No side effects at import, tree-shakable, and no
   dependency it can avoid.
9. **Grow by evidence.** Nothing before its second use; every change ships with a test that fails
   without it.

## How it is composed

```text
@sincpro/criteria           the contract with the server: Criteria, Meta, Page, Problem
        ▲
@sincpro/client-framework   this package — platform-neutral
        │   UseBoundedContext · Feature · ApplicationService · interceptors
        │   the process · the context · Tracer, ErrorReporter and ContextStore ports
        │   Transport · entity() · client contract · model definitions · ids
        │   the generator · in-memory doubles for tests
        ▲
@sincpro/web-framework      the web: hooks, components on @sincpro/web-ui, the shell on
                            @sincpro/web-composer, the browser's tracing and error reporting
@sincpro/mobile             mobile: the React Native shell, SQLite, its queue, its exporter
```

Dependencies point down only. This package knows nothing above it.

## Where it stands

**The first cut is here.** The client and the generator came out of @sincpro/web-framework,
where they already ran without the DOM. `Feature` and `ApplicationService` came from
@sincpro/mobile, with each call carrying its own execution instead of a global stack. And the
ports for tracing and error reporting are in, with the trace and the context written on every
request a use case sends.

**Then the bounded context**, set up as the backend sets one up: a dependency type that types every
service's `this.client`, `addDependency`, the services registered by name and used as
`project.Issues.close(input)` and `this.feature.Issues`; the process configured once in `main`
(`configureProcess`); and the context as a port, so the browser and the phone keep it each with
their own technology behind the same door.

**Next:** @sincpro/mobile on this package, and the screens' side in @sincpro/web-framework — the
cache of reads, invalidated by the writes a use case sends.

## How we decide

This page is the yardstick. A piece that serves nothing here does not go in. A piece this page
forbids does not go in either. To change what this page says, change the page first — in the
open, with the reason.

Open source, under the [MIT license](LICENSE).
