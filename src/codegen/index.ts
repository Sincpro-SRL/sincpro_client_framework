/**
 * The generator: a bounded context's types (entities and value objects, Commands and Responses,
 * domain events), client and entities out of the client contract sincpro_framework exports
 * (PRD_01 phase B), each file in its layer (`generatedFilesOf`). A build step that runs in Node — nothing in
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
export { domainFilesOf } from "@sincpro/client-framework/codegen/services/domain";
export { entitiesFileOf } from "@sincpro/client-framework/codegen/services/entities";
export { generatedFilesOf } from "@sincpro/client-framework/codegen/services/generated";
export type { GenerateOptions } from "@sincpro/client-framework/codegen/services/rest";
export {
  scaffoldFilesOf,
  type ScaffoldOptions,
} from "@sincpro/client-framework/codegen/services/scaffold";
