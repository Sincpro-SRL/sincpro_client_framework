import type { Executable } from "@sincpro/client-framework/core/domain/dto";
import type {
  InterceptedRun,
  Interceptor,
} from "@sincpro/client-framework/core/domain/pipeline";
import { describeDto, sameDto } from "@sincpro/client-framework/core/services/dto-keys";

/**
 * `handler` run on `executable`, wrapped by `interceptors` — the first the outermost.
 *
 *     runAround([], service, command, run)              ->  the service's answer
 *     runAround([audit, credit], service, command, run) ->  audit(credit(service))
 *     runAround([<passes another class on>], …)         ->  TypeError, naming both classes
 *
 * 1. Each interceptor gets a `next` bound to the position after it.
 * 2. What reaches `next` must be the DTO the call started with — its class, or its generated
 *    identity: the bus routes by it, so another would be another use case under this one's name.
 * Final: the outermost interceptor's answer — the service's, when none answers by itself.
 */
export function runAround(
  interceptors: readonly Interceptor[],
  handler: (executable: Executable) => Promise<unknown>,
  executable: Executable,
  run: InterceptedRun,
): Promise<unknown> {
  const at = async (position: number, current: Executable): Promise<unknown> => {
    if (current !== executable && !sameDto(current, executable)) {
      throw new TypeError(
        `An interceptor of ${run.useCase} passed on a ${describeDto(current)} where it received a ${describeDto(executable)}`,
      );
    }
    const interceptor = interceptors[position];
    if (interceptor === undefined) return handler(current);
    return interceptor(current, (next) => at(position + 1, next), run);
  };
  return at(0, executable);
}
