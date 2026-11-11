/**
 * Circuit breaker: stop calling a dependency that fails repeatedly, and try it again once it may
 * be back — as sincpro_framework's `circuit_breaker`.
 *
 *   domain/      CircuitState, CircuitOpen, what counts as the dependency not answering
 *   entrypoint/  CircuitBreaker
 */
export {
  CircuitOpen,
  type CircuitState,
  COUNTED_KINDS,
  countedByDefault,
} from "@sincpro/client-framework/circuit_breaker/domain/circuit";
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
} from "@sincpro/client-framework/circuit_breaker/entrypoint/circuit-breaker";
