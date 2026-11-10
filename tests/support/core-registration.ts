import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import ts from "typescript";

export type RegistrationStyle = "function" | "decorator";
type Constructor = new (...args: never[]) => object;

const decoratedSubclass = ts.transpileModule(
  `
  @register
  class Registered extends Service {
    static serviceName = Service.serviceName;
  }
  exports.Service = Registered;
`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  },
).outputText;

function isSubclass<S extends Constructor>(value: unknown, Base: S): value is S {
  return typeof value === "function" && Object.getPrototypeOf(value) === Base;
}

/**
 * Both styles run the same contract tests. The decorator fixture is lowered explicitly by
 * TypeScript, not simulated with a fabricated ClassDecoratorContext or enabled in Vite.
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
  runInNewContext(decoratedSubclass, {
    Service,
    exports: exported,
    register: (declared: S, decorator: ClassDecoratorContext<S>) => {
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
