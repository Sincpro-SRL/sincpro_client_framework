import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  DomainEvent,
  EventHandler,
  Feature,
  Subscriber,
} from "@sincpro/client-framework";
import { memoryLogger, memoryTracer } from "@sincpro/client-framework/testing";
import ts from "typescript";
import { minifySync } from "vite";
import { beforeEach, test } from "vitest";

import { registerClass, type RegistrationStyle } from "../support/core-registration";

/*
 * A service's name given at registration (`{ name }`, issue #62): a string literal, so a build
 * that renames classes — Next.js, with legacy decorators and no `keepNames` — keeps what spans,
 * logs and a stored queue say. Without it, nothing changes: those tests stay where they were.
 */

class CommandLeerCursos extends Command<string> {}

class CommandCrearCurso extends Command<string> {
  constructor(readonly title: string) {
    super();
  }
}

class CursoCreado extends DomainEvent {
  static readonly eventName = "cursos.curso.v1.creado";
  constructor(readonly title: string) {
    super();
  }
}

/** What a minifier leaves of a class's name: a letter, the same one in every scope it mangles. */
function minified<C extends abstract new (...args: never[]) => object>(Class: C): C {
  Object.defineProperty(Class, "name", { value: "l" });
  return Class;
}

const heard: string[] = [];

const LeerCursos = minified(
  class LeerCursos extends Feature<CommandLeerCursos, string> {
    execute(): string {
      return "cursos";
    }
  },
);

const CrearCurso = minified(
  class CrearCurso extends ApplicationService<CommandCrearCurso, string> {
    execute(command: CommandCrearCurso): string {
      return command.title;
    }
  },
);

const OnCursoCreado = minified(
  class OnCursoCreado extends EventHandler<CursoCreado> {
    handle(event: CursoCreado): void {
      heard.push(event.title);
    }
  },
);

beforeEach(() => {
  configureProcess({ logger: { engine: false } });
  heard.length = 0;
});

const STYLES: readonly RegistrationStyle[] = ["function", "decorator", "legacy-decorator"];

for (const style of STYLES) {
  test(`${style}: two services a minifier named alike register under the names they are given, and spans and logs say them`, async () => {
    const tracer = memoryTracer();
    const engine = memoryLogger();
    configureProcess({ tracer, logger: { engine } });
    const cursosBoundedContext = new BoundedContext("cursos");
    registerClass(
      style,
      LeerCursos,
      cursosBoundedContext.feature(CommandLeerCursos, { name: "LeerCursos" }),
    );
    registerClass(
      style,
      CrearCurso,
      cursosBoundedContext.appService(CommandCrearCurso, { name: "CrearCurso" }),
    );
    assert.equal(await cursosBoundedContext.execute(new CommandLeerCursos()), "cursos");
    assert.equal(await cursosBoundedContext.execute(new CommandCrearCurso("TS")), "TS");
    assert.deepEqual(
      tracer.spans.map((span) => [span.name, span.attributes["sincpro.use_case"]]),
      [
        ["cursos/LeerCursos", "cursos.LeerCursos"],
        ["cursos/CrearCurso", "cursos.CrearCurso"],
      ],
    );
    assert.deepEqual(
      [...new Set(engine.records.flatMap((record) => record.useCase ?? []))],
      ["cursos.LeerCursos", "cursos.CrearCurso"],
    );
  });

  test(`${style}: without a name, two services a minifier named alike still collide, as today`, () => {
    const cursosBoundedContext = new BoundedContext("cursos");
    registerClass(style, LeerCursos, cursosBoundedContext.feature(CommandLeerCursos));
    assert.throws(
      () =>
        registerClass(style, CrearCurso, cursosBoundedContext.appService(CommandCrearCurso)),
      /^Error: Service name already registered: l$/,
    );
  });

  test(`${style}: a handler a minifier renamed is the consumer it is named, on a bus and on a subscriber`, async () => {
    const cursosBoundedContext = new BoundedContext("cursos");
    registerClass(
      style,
      OnCursoCreado,
      cursosBoundedContext.handler(CursoCreado, { name: "OnCursoCreado" }),
    );
    const appSubscriber = new Subscriber("app");
    registerClass(
      style,
      OnCursoCreado,
      appSubscriber.handler([CursoCreado], { name: "AvisarCursoCreado" }),
    );
    appSubscriber.addBus(cursosBoundedContext);
    const handled = await appSubscriber.handle(new CursoCreado("TS"));
    assert.deepEqual(
      handled.map((one) => one.boundedContext),
      ["app/AvisarCursoCreado", "cursos/OnCursoCreado"],
    );
    assert.deepEqual(heard, ["TS", "TS"]);
  });
}

test("the name given wins over the one a standard decorator hands over", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  class Leer extends Feature<CommandLeerCursos, string> {
    execute(): string {
      return "cursos";
    }
  }
  const cursosBoundedContext = new BoundedContext("cursos");
  // The fixture writes `@register class Leer`: its `context.name` is "Leer".
  registerClass(
    "decorator",
    Leer,
    cursosBoundedContext.feature(CommandLeerCursos, { name: "LeerCursos" }),
  );
  await cursosBoundedContext.execute(new CommandLeerCursos());
  assert.equal(tracer.spans[0]?.name, "cursos/LeerCursos");
});

test("a name that is not one a class could have is refused where the registration is written", () => {
  const cursosBoundedContext = new BoundedContext("cursos");
  const appSubscriber = new Subscriber("app");
  for (const name of ["", " ", "cursos/leer", "Leer.Cursos", "leer cursos", "1Leer", 42]) {
    const options = { name } as { name: string };
    for (const register of [
      () => cursosBoundedContext.feature(CommandLeerCursos, options),
      () => cursosBoundedContext.appService(CommandCrearCurso, options),
      () => cursosBoundedContext.handler(CursoCreado, options),
      () => appSubscriber.handler(CursoCreado, options),
    ]) {
      assert.throws(register, (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /is not a service's name: an identifier/);
        return true;
      });
    }
  }
  // A class's name in any script is one.
  cursosBoundedContext.feature(CommandLeerCursos, { name: "AñadirCurso_2$" })(LeerCursos);
});

test("a name given is unique in its bounded context, among services and handlers, as a class's", () => {
  const cursosBoundedContext = new BoundedContext("cursos");
  cursosBoundedContext.feature(CommandLeerCursos, { name: "Cursos" })(LeerCursos);
  assert.throws(
    () => cursosBoundedContext.appService(CommandCrearCurso, { name: "Cursos" })(CrearCurso),
    /^Error: Service name already registered: Cursos$/,
  );
  assert.throws(
    () => cursosBoundedContext.handler(CursoCreado, { name: "Cursos" })(OnCursoCreado),
    /^Error: Service name already registered: Cursos$/,
  );
  class Named extends ApplicationService<CommandCrearCurso, string> {
    execute(): string {
      return "";
    }
  }
  cursosBoundedContext.appService(CommandCrearCurso)(Named);
  assert.throws(
    () => cursosBoundedContext.handler(CursoCreado, { name: "Named" })(OnCursoCreado),
    /^Error: Service name already registered: Named$/,
  );
  const appSubscriber = new Subscriber("app");
  appSubscriber.handler(CursoCreado, { name: "Avisar" })(OnCursoCreado);
  const Other = minified(
    class extends EventHandler<CursoCreado> {
      handle(): void {}
    },
  );
  assert.throws(
    () => appSubscriber.handler(CursoCreado, { name: "Avisar" })(Other),
    /^Error: Event handler name already registered: Avisar$/,
  );
});

test("a replacement may be named too: its spans say which name it replaced", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const cursosBoundedContext = new BoundedContext("cursos");
  cursosBoundedContext.feature(CommandLeerCursos, { name: "LeerCursos" })(LeerCursos);
  const Cached = minified(
    class extends Feature<CommandLeerCursos, string> {
      execute(): string {
        return "cached";
      }
    },
  );
  cursosBoundedContext.feature(CommandLeerCursos, {
    replaces: LeerCursos,
    name: "LeerCursosEnCache",
  })(Cached);
  assert.equal(await cursosBoundedContext.execute(new CommandLeerCursos()), "cached");
  assert.equal(tracer.spans[0]?.name, "cursos/LeerCursosEnCache");
  assert.equal(tracer.spans[0]?.attributes["sincpro.replaces"], "LeerCursos");
  // A fresh generation keeps the registration, and its name with it.
  await cursosBoundedContext.fresh().execute(new CommandLeerCursos());
  assert.equal(tracer.spans[1]?.name, "cursos/LeerCursosEnCache");
});

/**
 * Two modules and an event handler of an application as a production build leaves them: each
 * module in a scope of its own (as a bundler wraps them), registered with legacy decorators
 * (`experimentalDecorators`, what an application on Next.js uses), lowered by TypeScript and
 * minified by Vite's minifier — every class renamed, with the same letters in each scope.
 */
function productionBuild(given: { names: boolean; commandNames: boolean }): string {
  const named = (name: string) => (given.names ? `, { name: "${name}" }` : "");
  const module = (command: string, service: string, answer: string) => `
    exports.${service} = (() => {
      class ${command} extends Command {
        ${given.commandNames ? `static commandName = "cursos.${command}";` : ""}
      }
      @cursosBoundedContext.feature(${command}${named(service)})
      class ${service} extends Feature {
        execute() { return "${answer}"; }
      }
      return { Command: ${command}, Service: ${service} };
    })();`;
  const source = `
    ${module("CommandLeerCursos", "LeerCursos", "cursos")}
    ${module("CommandCrearCurso", "CrearCurso", "creado")}
    exports.OnCursoCreado = (() => {
      @cursosBoundedContext.handler(CursoCreado${named("OnCursoCreado")})
      class OnCursoCreado extends EventHandler {
        handle(event) { heard.push(event.title); }
      }
      return OnCursoCreado;
    })();`;
  const lowered = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
    },
  }).outputText;
  return minifySync("cursos.js", lowered, { compress: true, mangle: true }).code;
}

type Built = {
  readonly Command: new () => Command<string>;
  readonly Service: abstract new () => object;
};

/** Runs the build in a realm of its own, as a page or a server evaluates its chunk. */
function load(code: string, cursosBoundedContext: BoundedContext) {
  const exported: Record<string, unknown> = {};
  runInNewContext(code, {
    Command,
    Feature,
    EventHandler,
    CursoCreado,
    cursosBoundedContext,
    heard,
    exports: exported,
  });
  return exported as {
    LeerCursos: Built;
    CrearCurso: Built;
    OnCursoCreado: abstract new () => object;
  };
}

test("in a minified build, the names given survive and the classes' do not", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const cursosBoundedContext = new BoundedContext("cursos");
  const built = load(
    productionBuild({ names: true, commandNames: true }),
    cursosBoundedContext,
  );
  // The minifier renamed every class: what they would be called is gone.
  for (const Class of [
    built.LeerCursos.Command,
    built.LeerCursos.Service,
    built.CrearCurso.Command,
    built.CrearCurso.Service,
    built.OnCursoCreado,
  ]) {
    assert.ok(Class.name.length <= 2, `${Class.name} was not minified`);
  }
  assert.equal(await cursosBoundedContext.execute(new built.LeerCursos.Command()), "cursos");
  assert.equal(await cursosBoundedContext.execute(new built.CrearCurso.Command()), "creado");
  const appSubscriber = new Subscriber("app").addBus(cursosBoundedContext);
  const handled = await appSubscriber.handle(new CursoCreado("TS"));
  assert.deepEqual(
    tracer.spans.map((span) => [span.name, span.attributes["sincpro.command"]]),
    [
      ["cursos/LeerCursos", "cursos.CommandLeerCursos"],
      ["cursos/CrearCurso", "cursos.CommandCrearCurso"],
      ["cursos/OnCursoCreado", undefined],
    ],
  );
  assert.deepEqual(
    handled.map((one) => one.boundedContext),
    ["cursos/OnCursoCreado"],
  );
  assert.deepEqual(heard, ["TS"]);
});

test("in a minified build without names, the services collide as they always did", () => {
  assert.throws(
    () =>
      load(
        productionBuild({ names: false, commandNames: true }),
        new BoundedContext("cursos"),
      ),
    /^Error: Service name already registered: [\w$]{1,2}$/,
  );
});

test("in a minified build, a Command's identity is its class's too: `static commandName` keeps it", () => {
  assert.throws(
    () =>
      load(
        productionBuild({ names: true, commandNames: false }),
        new BoundedContext("cursos"),
      ),
    /^Error: Command identity already registered: cursos\.[\w$]{1,2}$/,
  );
});
