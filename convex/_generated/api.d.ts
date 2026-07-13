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
import type * as audit_log from "../audit_log.js";
import type * as checkpoints from "../checkpoints.js";
import type * as commands from "../commands.js";
import type * as conversations from "../conversations.js";
import type * as diff_comments from "../diff_comments.js";
import type * as diffs from "../diffs.js";
import type * as events from "../events.js";
import type * as git_actions from "../git_actions.js";
import type * as machine_summaries from "../machine_summaries.js";
import type * as machines from "../machines.js";
import type * as subagents from "../subagents.js";
import type * as usage from "../usage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  approvals: typeof approvals;
  audit_log: typeof audit_log;
  checkpoints: typeof checkpoints;
  commands: typeof commands;
  conversations: typeof conversations;
  diff_comments: typeof diff_comments;
  diffs: typeof diffs;
  events: typeof events;
  git_actions: typeof git_actions;
  machine_summaries: typeof machine_summaries;
  machines: typeof machines;
  subagents: typeof subagents;
  usage: typeof usage;
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
