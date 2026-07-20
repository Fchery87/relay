import type { ServerRequest } from "./generated/ServerRequest";
export type NormalizedProviderRequest =
  | Readonly<{ kind: "approval"; id: string; capability: "exec" | "edit" | "permissions"; details: unknown }>
  | Readonly<{ kind: "user-input"; id: string; details: unknown }>
  | Readonly<{ kind: "mcp-elicitation"; id: string; details: unknown }>
  | Readonly<{ kind: "tool-call"; id: string; details: unknown }>
  | Readonly<{ kind: "credential-refresh" | "attestation"; id: string; details: unknown }>;
export function normalizeCodexRequest(request: ServerRequest): NormalizedProviderRequest {
  const id = String(request.id); const details = request.params;
  switch (request.method) {
    case "item/commandExecution/requestApproval": case "execCommandApproval": return { kind: "approval", id, capability: "exec", details };
    case "item/fileChange/requestApproval": case "applyPatchApproval": return { kind: "approval", id, capability: "edit", details };
    case "item/permissions/requestApproval": return { kind: "approval", id, capability: "permissions", details };
    case "item/tool/requestUserInput": return { kind: "user-input", id, details };
    case "mcpServer/elicitation/request": return { kind: "mcp-elicitation", id, details };
    case "item/tool/call": return { kind: "tool-call", id, details };
    case "account/chatgptAuthTokens/refresh": return { kind: "credential-refresh", id, details };
    case "attestation/generate": return { kind: "attestation", id, details };
    default: { const exhaustive: never = request; throw new Error(`Unsupported Codex request: ${JSON.stringify(exhaustive)}`); }
  }
}
