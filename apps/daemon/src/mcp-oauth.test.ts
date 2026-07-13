import { expect, test } from "bun:test";

import { McpOAuthClient, type OAuthTokenStore } from "./mcp-oauth";

test("registers as a native app and validates authorization response issuer", async () => {
  const requests: Array<{ body?: string; url: string }> = [];
  const store: OAuthTokenStore = { load: async () => null, save: async () => undefined };
  const client = new McpOAuthClient({ fetcher: async (input, init) => {
    requests.push({ body: init?.body ? String(init.body) : undefined, url: input });
    if (input.includes("well-known")) return Response.json({ authorization_endpoint: "https://issuer.test/authorize", issuer: "https://issuer.test", registration_endpoint: "https://issuer.test/register", token_endpoint: "https://issuer.test/token" });
    if (input.endsWith("/register")) return Response.json({ client_id: "relay-client" });
    return Response.json({ access_token: "access", expires_in: 3600, refresh_token: "refresh", token_type: "Bearer" });
  }, issuer: "https://issuer.test", redirectUri: "http://127.0.0.1:43119/callback", store });
  const registration = await client.register();
  expect(JSON.parse(requests[1]!.body!)).toMatchObject({ application_type: "native", redirect_uris: ["http://127.0.0.1:43119/callback"] });
  await expect(client.exchangeAuthorizationCode({ clientId: registration.clientId, code: "code", codeVerifier: "verifier", responseIssuer: "https://evil.test" })).rejects.toThrow("issuer");
});

test("refreshes access tokens while retaining daemon-only refresh custody", async () => {
  let saved: unknown;
  const store: OAuthTokenStore = { load: async () => ({ accessToken: "expired", clientId: "client", expiresAt: 1, refreshToken: "refresh" }), save: async (_issuer, value) => { saved = value; } };
  const client = new McpOAuthClient({ fetcher: async (input) => input.includes("well-known") ? Response.json({ authorization_endpoint: "https://issuer.test/authorize", issuer: "https://issuer.test", registration_endpoint: "https://issuer.test/register", token_endpoint: "https://issuer.test/token" }) : Response.json({ access_token: "new-access", expires_in: 3600, token_type: "Bearer" }), issuer: "https://issuer.test", now: () => 10_000, redirectUri: "http://127.0.0.1:43119/callback", store });
  expect(await client.accessToken()).toBe("new-access");
  expect(saved).toMatchObject({ accessToken: "new-access", refreshToken: "refresh" });
});

test("rejects cleartext non-loopback issuers before discovery", () => {
  const store: OAuthTokenStore = { load: async () => null, save: async () => undefined };
  expect(() => new McpOAuthClient({ issuer: "http://internal.example.test", redirectUri: "http://127.0.0.1:43119/callback", store })).toThrow("HTTPS");
});
