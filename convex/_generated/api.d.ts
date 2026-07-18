/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as approvals from "../approvals.js";
import type * as attention from "../attention.js";
import type * as audit_log from "../audit_log.js";
import type * as auth from "../auth.js";
import type * as auth_helpers from "../auth_helpers.js";
import type * as checkpoints from "../checkpoints.js";
import type * as commands from "../commands.js";
import type * as commands_inbox from "../commands/inbox.js";
import type * as conversations from "../conversations.js";
import type * as diff_comments from "../diff_comments.js";
import type * as diffs from "../diffs.js";
import type * as events from "../events.js";
import type * as git_actions from "../git_actions.js";
import type * as http from "../http.js";
import type * as machine_summaries from "../machine_summaries.js";
import type * as machines from "../machines.js";
import type * as mcp_elicitations from "../mcp_elicitations.js";
import type * as mcp_servers from "../mcp_servers.js";
import type * as migrations from "../migrations.js";
import type * as narrow from "../narrow.js";
import type * as pairing from "../pairing.js";
import type * as plans from "../plans.js";
import type * as projections_publish from "../projections/publish.js";
import type * as schema_narrow from "../schema_narrow.js";
import type * as subagents from "../subagents.js";
import type * as test_helpers from "../test_helpers.js";
import type * as usage from "../usage.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  approvals: typeof approvals;
  attention: typeof attention;
  audit_log: typeof audit_log;
  auth: typeof auth;
  auth_helpers: typeof auth_helpers;
  checkpoints: typeof checkpoints;
  commands: typeof commands;
  "commands/inbox": typeof commands_inbox;
  conversations: typeof conversations;
  diff_comments: typeof diff_comments;
  diffs: typeof diffs;
  events: typeof events;
  git_actions: typeof git_actions;
  http: typeof http;
  machine_summaries: typeof machine_summaries;
  machines: typeof machines;
  mcp_elicitations: typeof mcp_elicitations;
  mcp_servers: typeof mcp_servers;
  migrations: typeof migrations;
  narrow: typeof narrow;
  pairing: typeof pairing;
  plans: typeof plans;
  "projections/publish": typeof projections_publish;
  schema_narrow: typeof schema_narrow;
  subagents: typeof subagents;
  test_helpers: typeof test_helpers;
  usage: typeof usage;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
