import type {
  FactoryCreatePrototypeRequest,
  FactoryPrototypeOperation,
} from "./protocol";

export interface FactoryPrototypeRuntime {
  createPrototype(
    request: FactoryCreatePrototypeRequest,
  ): Promise<FactoryPrototypeOperation>;

  getOperation(operationId: string): Promise<FactoryPrototypeOperation | null>;
}
