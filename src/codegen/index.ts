/**
 * The generator: a bounded context's DTOs, client and entities out of the client contract
 * sincpro_framework exports (PRD_01 phase B). A build step that runs in Node — nothing in
 * the runtime imports it (`make doctor`), and the package's root entry does not re-export it. `sincpro-client generate` (`cli.ts`) is the same, from a terminal.
 */
export type {
  Bindings,
  Metamodel,
  Operation,
  RestBinding,
  Schema,
} from "@sincpro/client-framework/codegen/domain/metamodel";
export {
  CheckError,
  checkImports,
  type Place,
  placeOf,
  type Violation,
  violationOf,
} from "@sincpro/client-framework/codegen/services/check";
export { clientFileOf } from "@sincpro/client-framework/codegen/services/client";
export { domainFileOf } from "@sincpro/client-framework/codegen/services/domain";
export { entitiesFileOf } from "@sincpro/client-framework/codegen/services/entities";
export type { GenerateOptions } from "@sincpro/client-framework/codegen/services/rest";
export {
  scaffoldFilesOf,
  type ScaffoldOptions,
} from "@sincpro/client-framework/codegen/services/scaffold";
