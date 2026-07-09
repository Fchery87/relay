import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import type { MachineRegistration } from "@relay/shared";

const heartbeatMutation = makeFunctionReference<"mutation", { deviceToken: string }>(
  "machines:heartbeat",
);
const registerMachineMutation = makeFunctionReference<"mutation", MachineRegistration>(
  "machines:registerMachine",
);

export interface MachineGateway {
  heartbeat(input: { deviceToken: string }): Promise<unknown>;
  registerMachine(registration: MachineRegistration): Promise<unknown>;
}

export class MachineReporter {
  readonly #gateway: MachineGateway;
  readonly #registration: MachineRegistration;

  constructor({ gateway, registration }: { gateway: MachineGateway; registration: MachineRegistration }) {
    this.#gateway = gateway;
    this.#registration = registration;
  }

  connect(): Promise<unknown> {
    return this.#gateway.registerMachine(this.#registration);
  }

  heartbeatOnce(): Promise<unknown> {
    return this.#gateway.heartbeat({ deviceToken: this.#registration.deviceToken });
  }
}

export function createConvexMachineGateway({ deploymentUrl }: { deploymentUrl: string }): MachineGateway {
  const client = new ConvexHttpClient(deploymentUrl);

  return {
    heartbeat: ({ deviceToken }) => client.mutation(heartbeatMutation, { deviceToken }),
    registerMachine: (registration) => client.mutation(registerMachineMutation, registration),
  };
}
