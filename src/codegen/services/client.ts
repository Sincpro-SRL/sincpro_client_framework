import type {
  Metamodel,
  Operation,
} from "@sincpro/client-framework/codegen/domain/metamodel";
import {
  aliasOf,
  answerOf,
  claimed,
  deprecationOf,
  docOf,
  DOMAIN_MODULE,
  FRAMEWORK,
  headerOf,
  identifierOf,
  localOf,
  methodOf,
  recordLiteral,
  sorted,
} from "@sincpro/client-framework/codegen/domain/names";
import {
  type GenerateOptions,
  type Reached,
  restOf,
} from "@sincpro/client-framework/codegen/services/rest";

/**
 * The client of a bounded context as TypeScript: every operation as data, and a method for each
 * one, called by who it is through an `OperationTransport` — so a script, a test, a Feature or a
 * hook calls the service typed, over whatever wire the application injects.
 *
 * Context: the generated client names an operation and its input, never a route, a verb or an
 * RPC method: those are the contract's bindings, in `operations`, and the adapter reads the one of
 * its wire (`restOperations`, `jsonRpcOperations`, a platform's gRPC). So the same client, and the
 * Features that use it, run over REST today and JSON-RPC or gRPC tomorrow without regenerating.
 * Each method takes the operation's input and answers its answer, as the contract types them
 * (`domain.ts`).
 */

const WIRES: readonly [keyof NonNullable<Metamodel["bindings"]>, string][] = [
  ["rest", "REST"],
  ["rpc", "JSON-RPC"],
  ["grpc", "gRPC"],
  ["mcp", "MCP"],
];

/** The wires that publish an operation, by name. */
function wiresOf(metamodel: Metamodel, identity: string): string[] {
  return WIRES.filter(([wire]) => metamodel.bindings?.[wire]?.[identity] !== undefined).map(
    ([, name]) => name,
  );
}

/** Whether an operation answers bytes as they are produced — an export —, not JSON. */
function isStreamed(operation: Operation): boolean {
  return (
    operation.output !== null &&
    (operation.output as Record<string, unknown>)["x-sincpro-streamed"] !== undefined
  );
}

/** The data of one operation: what it is, and how each wire reaches it. */
function dataOf(
  metamodel: Metamodel,
  identity: string,
  operation: Operation,
  rest: Reached | undefined,
): string {
  const lines = [
    `    identity: ${JSON.stringify(identity)},`,
    `    role: ${JSON.stringify(operation.role)},`,
    `    query: ${operation.query},`,
    `    entities: ${JSON.stringify(operation.entities)},`,
    `    targets: ${recordLiteral(operation.targets)},`,
  ];
  if (isStreamed(operation)) lines.push("    streamed: true,");
  if (rest !== undefined)
    lines.push(
      `    rest: { method: ${JSON.stringify(rest.method)}, path: ${JSON.stringify(rest.path)} },`,
    );
  const rpc = metamodel.bindings?.rpc?.[identity];
  if (rpc !== undefined) lines.push(`    rpc: { method: ${JSON.stringify(rpc.method)} },`);
  const grpc = metamodel.bindings?.grpc?.[identity];
  if (grpc !== undefined) lines.push(`    grpc: { method: ${JSON.stringify(grpc.method)} },`);
  const mcp = metamodel.bindings?.mcp?.[identity];
  if (mcp !== undefined) lines.push(`    mcp: { tool: ${JSON.stringify(mcp.tool)} },`);
  return `  ${localOf(metamodel, identity)}: {\n${lines.join("\n")}\n  },`;
}

/**
 * The TypeScript of the client of `metamodel`, as the text of one file next to its `domain.ts`.
 *
 * 1. Every operation, by its local name, as data: identity, role, `query`, entities, targets,
 *    whether it answers bytes, and the binding of each wire that publishes it.
 * 2. A method per operation, named by `methodOf`: its input — optional when nothing in it is
 *    required — and the call's options (headers, signal, idempotency key), answering its answer.
 * 3. When the contract carries them, every domain event as data, by its type's name: its wire
 *    name, and whether the bounded context records it or handles it.
 * Final: `clientOf(transport)` over an `OperationTransport`, bound to each run that uses it; two
 *    methods with one name are refused, naming both.
 */
export function clientFileOf(metamodel: Metamodel, options: GenerateOptions = {}): string {
  const claim = claimed();
  const data: string[] = [];
  const methods: string[] = [];
  for (const [identity, operation] of sorted(metamodel.operations)) {
    const local = localOf(metamodel, identity);
    data.push(dataOf(metamodel, identity, operation, restOf(metamodel, identity, options)));
    const method = methodOf(local);
    claim(method, `operation ${identity}`);
    const wires = wiresOf(metamodel, identity);
    const doc = docOf(
      [
        operation.description,
        deprecationOf(metamodel, operation),
        wires.length === 0 ? undefined : `Published over ${wires.join(", ")}.`,
      ],
      "    ",
    );
    const optional = (operation.input.required ?? []).length === 0;
    methods.push(
      [
        `${doc}    ${method}: (input${optional ? "?" : ""}: dto.${local}, options?: OperationOptions) =>`,
        `      transport.call<dto.${answerOf(metamodel, identity)}>(operations.${local}, input${optional ? " ?? {}" : ""}, options),`,
      ].join("\n"),
    );
  }

  const events = sorted(metamodel.events ?? {}).map(
    ([name, event]) =>
      `  ${identifierOf(event.title)}: { name: ${JSON.stringify(name)}, recorded: ${event.recorded}, handled: ${event.handled} },`,
  );

  const imports = [
    `import { bindable, type OperationOptions, type OperationTransport } from "${FRAMEWORK}";`,
    "",
    `import type * as dto from "${DOMAIN_MODULE}";`,
  ].join("\n");
  const client = [
    "/**",
    ` * «${aliasOf(metamodel)}» over any wire: a method per operation, called by who it is. The transport`,
    " * decides how it travels — `restOperations(restTransport(…))`, `jsonRpcOperations(…)`, a",
    " * platform's —; used by a Feature, each call carries the run's trace, context and signal.",
    " */",
  ].join("\n");

  return `${[
    headerOf("The client", metamodel),
    imports,
    `/** Every operation of «${aliasOf(metamodel)}», as data: what it is, and how each wire reaches it. */\nexport const operations = {\n${data.join("\n")}\n} as const;`,
    ...(events.length === 0
      ? []
      : [
          `/** Every domain event of «${aliasOf(metamodel)}» in the contract, as data: its wire name, and whether it records or handles it. */\nexport const events = {\n${events.join("\n")}\n} as const;`,
        ]),
    `${client}\nexport function clientOf(transport: OperationTransport) {\n  return bindable(transport, (transport) => ({\n${methods.join("\n")}\n  }));\n}`,
  ].join("\n\n")}\n`;
}
