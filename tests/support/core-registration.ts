import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import ts from "typescript";

export type RegistrationStyle = "function" | "decorator" | "legacy-decorator";
type Constructor = new (...args: never[]) => object;

/** A class of the same name as `name`, decorated as an application writes it. */
const decorated = (name: string) => `
  @register
  class ${name} extends Service {}
  exports.Service = ${name};
`;

/** The same class, lowered once with standard decorators and once with `experimentalDecorators`. */
function decoratedSubclass(style: "decorator" | "legacy-decorator", name: string): string {
  return ts.transpileModule(decorated(name), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      ...(style === "legacy-decorator" ? { experimentalDecorators: true } : {}),
    },
  }).outputText;
}

function isSubclass<S extends Constructor>(value: unknown, Base: S): value is S {
  return typeof value === "function" && Object.getPrototypeOf(value) === Base;
}

/**
 * Every style runs the same contract tests. The decorator fixtures are lowered explicitly by
 * TypeScript — standard and legacy (`experimentalDecorators`) —, not simulated with a fabricated
 * ClassDecoratorContext or enabled in Vite.
 */
export function registerClass<S extends Constructor>(
  style: RegistrationStyle,
  Service: S,
  register: (
    Service: NoInfer<S>,
    decorator?: ClassDecoratorContext<NoInfer<S>>,
  ) => NoInfer<S>,
): S {
  if (style === "function") {
    const registered = register(Service);
    assert.equal(registered, Service);
    return registered;
  }
  const exported: Record<string, unknown> = {};
  runInNewContext(decoratedSubclass(style, Service.name), {
    Service,
    exports: exported,
    register: (declared: S, decorator?: ClassDecoratorContext<S>) => {
      const registered = register(declared, decorator);
      assert.equal(registered, declared);
      exported.declared = declared;
      return registered;
    },
  });
  const registered = exported.Service;
  assert.equal(registered, exported.declared);
  if (!isSubclass(registered, Service)) {
    throw new TypeError("Decorator fixture did not preserve the service class");
  }
  return registered;
}
