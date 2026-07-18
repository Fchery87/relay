import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { RouterProvider } from "@tanstack/react-router";

import { ConnectedSettings, ConnectedWorkspace, UnconfiguredWorkspace } from "./app";
import { createRelayRouter } from "./router";
import "./app.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : undefined;
const router = convexClient ? createRelayRouter(ConnectedWorkspace, ConnectedSettings) : createRelayRouter(UnconfiguredWorkspace);
const application = <RouterProvider router={router} />;

createRoot(document.getElementById("root")!).render(
  convexClient ? <ConvexAuthProvider client={convexClient}>{application}</ConvexAuthProvider> : application,
);
