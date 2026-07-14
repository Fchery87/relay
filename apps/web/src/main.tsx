import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";

import { ConnectedWorkspace, UnconfiguredWorkspace } from "./app";
import "./app.css";

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : undefined;

const rootRoute = createRootRoute();
const indexRoute = createRoute({
  component: convexClient ? ConnectedWorkspace : UnconfiguredWorkspace,
  getParentRoute: () => rootRoute,
  path: "/",
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

const application = <RouterProvider router={router} />;

createRoot(document.getElementById("root")!).render(
  convexClient ? <ConvexAuthProvider client={convexClient}>{application}</ConvexAuthProvider> : application,
);
