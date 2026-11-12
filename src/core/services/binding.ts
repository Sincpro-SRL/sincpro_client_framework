import {
  BIND,
  type Execution,
  isBindable,
} from "@sincpro/client-framework/context/domain/execution";

/**
 * A dependency as the execution should see it: bound when it says it can be (`BIND` — a
 * generated client, `restOperations`, `jsonRpcOperations`, `restTransport`, `memoryTransport`,
 * `guardedTransport`, `bindableOperations(…)`, `bindableTransport(…)`); as it is otherwise.
 * Never guessed from a method's name: an application's object — an Odoo client with a `call`,
 * a repository with a `list` — is the application's, untouched.
 */
export function bindDependency<T>(value: T, execution: Execution): T {
  if (isBindable(value)) return value[BIND](execution);
  return value;
}
