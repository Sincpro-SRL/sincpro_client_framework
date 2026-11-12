import {
  bindTransport,
  isTransport,
} from "@sincpro/client-framework/client/services/propagation";
import {
  BIND,
  type Execution,
  isBindable,
} from "@sincpro/client-framework/context/domain/execution";

/**
 * A dependency as the execution should see it: bound when it says it can be (`BIND` — a
 * generated client, `restOperations`, `jsonRpcOperations`, `bindableOperations(…)`) or is a REST
 * `Transport`; as it is otherwise. Never guessed from a method's name: an app's object with a
 * `call` (an Odoo client) is the app's, untouched.
 */
export function bindDependency<T>(value: T, execution: Execution): T {
  if (isBindable(value)) return value[BIND](execution);
  if (isTransport(value)) return bindTransport(value, execution) as T;
  return value;
}
