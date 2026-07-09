import { hostname } from "node:os";

import { loadDaemonConfig } from "./config";
import { createConvexMachineGateway, MachineReporter } from "./relay-client";

const config = loadDaemonConfig({ env: Bun.env, hostname });
const reporter = new MachineReporter({
  gateway: createConvexMachineGateway({ deploymentUrl: config.deploymentUrl }),
  registration: config.registration,
});

await reporter.connect();
console.info(`Relay daemon connected as ${config.registration.name}`);

setInterval(() => {
  void reporter.heartbeatOnce().catch((error: unknown) => {
    console.error("Relay heartbeat failed", error);
  });
}, config.heartbeatIntervalMs);
