import { isOperationTransport } from "@sincpro/client-framework/client/domain/operation";
import {
  bindOperations,
  bindTransport,
  isTransport,
} from "@sincpro/client-framework/client/services/propagation";
import {
  BIND,
  type Execution,
  isBindable,
} from "@sincpro/client-framework/context/domain/execution";

/**
 * A dependency as the execution should see it: bound when it can be (`BIND`, a `Transport`, an
 * `OperationTransport`), as it is otherwise.
 */
export function bindDependency<T>(value: T, execution: Execution): T {
  if (isBindable(value)) return value[BIND](execution);
  if (isTransport(value)) return bindTransport(value, execution) as T;
  if (isOperationTransport(value)) return bindOperations(value, execution) as T;
  return value;
}
