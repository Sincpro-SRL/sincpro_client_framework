/**
 * The generator: a bounded context's DTOs, client and entities out of the client contract
 * sincpro_framework exports (PRD_01 phase B). A build step that runs in Node — nothing in
 * the runtime imports it (`make doctor`), and the package's root entry does not re-export it. `sincpro-client generate` (`cli.ts`) is the same, from a terminal.
 */
export { clientFileOf } from "@sincpro/client-framework/codegen/client";
export { domainFileOf } from "@sincpro/client-framework/codegen/domain";
export { entitiesFileOf } from "@sincpro/client-framework/codegen/entities";
export type {
  Bindings,
  Metamodel,
  Operation,
  RestBinding,
  Schema,
} from "@sincpro/client-framework/codegen/metamodel";
export type { GenerateOptions } from "@sincpro/client-framework/codegen/rest";
