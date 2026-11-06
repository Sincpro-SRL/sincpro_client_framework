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

1. **Use cases.** `Feature` is one use case, with its dependencies injected; `ApplicationService`
   is a Feature that also executes the Features of its own domain — never another
   ApplicationService. All of a client's logic lives in them.
2. **Interception.** Every public method of a use case passes through interceptors, and that is
   what makes the defaults free: the trace, the error report, the context. The author of a
   Feature writes none of it.
3. **Observability, as ports.** `Tracer` and `ErrorReporter` are the contract: one span per use
   case, named `<domain>/<Feature>` like the backend's; the unexpected reported with its trace id;
   what the server already explained (a validation, a conflict) not reported. The platform plugs
   the implementation — OpenTelemetry, GlitchTip, a queue on the phone, memory in a test.
4. **Context.** The levels a call sees — the application, its domain, the call itself — and what
   travels to the server with it (`traceparent`, `sincpro-context`). Carried by each call, never
   kept in a global: two calls at once never mix their parents.
5. **Domains and the application.** A bounded context is declared once — its client, its use
   cases, what they depend on — and an application is the set of domains it loads. Domains never
   import each other; they talk by reference.
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
  with the libraries that do it best.
- **Not offline storage.** SQLite on a phone or IndexedDB in a point of sale are platform
  adapters.
- **Not a telemetry or error-tracking SDK.** It defines the ports and calls them; it bundles no
  vendor.
- **Not where business rules live.** The server keeps them; a client reads what it publishes.
- **Not an event bus**, and not a dispatcher: a use case is executed by calling it, and the
  interceptors are what make that call traced and reported.

## What we believe

1. **Platform-neutral, or it does not go in.** It runs on Node, in a browser and on React Native.
   What it needs from a platform it asks through a port, never by reaching for it. The build
   enforces it.
2. **The backend's words.** Feature, ApplicationService, domain, context, the span name — the
   same as sincpro_framework, so whoever knows the backend already knows the client.
3. **Nothing escapes the interceptors.** Reusing a use case is executing its Feature. A helper
   that wraps one skips the trace and the report — that is how an incident ends up with nothing
   to look at.
4. **Context travels with the call.** Never in a global stack: clients run many things at once.
5. **A port where there are two implementations, a class where there is one.** `Transport` has
   REST and memory; `Tracer` has a platform's and a test's.
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
        │   Feature · ApplicationService · interceptors · context per call
        │   Domain · application · Tracer and ErrorReporter ports
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

**Next:** the domains and the application. The plan is written in @sincpro/web-framework
(`docs/prd/PRD_02_marco-de-trabajo.md`, in Spanish like the rest of Sincpro's design records).

## How we decide

This page is the yardstick. A piece that serves nothing here does not go in. A piece this page
forbids does not go in either. To change what this page says, change the page first — in the
open, with the reason.

Open source, under the [MIT license](LICENSE).
