import type { Executable } from "@sincpro/client-framework/core/domain/dto";
import type {
  InterceptedRun,
  Interceptor,
} from "@sincpro/client-framework/core/domain/pipeline";

/**
 * `handler` run on `executable`, wrapped by `interceptors` — the first the outermost.
 *
 *     runAround([], service, command, run)              ->  the service's answer
 *     runAround([audit, credit], service, command, run) ->  audit(credit(service))
 *     runAround([<passes another class on>], …)         ->  TypeError, naming both classes
 *
 * 1. Each interceptor gets a `next` bound to the position after it.
 * 2. What reaches `next` must be of the class the call started with: the bus routes by class,
 *    so another class would be another use case under this one's name.
 * Final: the outermost interceptor's answer — the service's, when none answers by itself.
 */
export function runAround(
  interceptors: readonly Interceptor[],
  handler: (executable: Executable) => Promise<unknown>,
  executable: Executable,
  run: InterceptedRun,
): Promise<unknown> {
  const started = Object.getPrototypeOf(executable)?.constructor;
  const at = async (position: number, current: Executable): Promise<unknown> => {
    if (Object.getPrototypeOf(current)?.constructor !== started) {
      throw new TypeError(
        `An interceptor of ${run.useCase} passed on a ${current?.constructor?.name} where it received a ${started?.name}`,
      );
    }
    const interceptor = interceptors[position];
    if (interceptor === undefined) return handler(current);
    return interceptor(current, (next) => at(position + 1, next), run);
  };
  return at(0, executable);
}
