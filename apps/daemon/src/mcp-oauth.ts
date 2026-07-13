import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const secureUrl = z.url().refine((value) => { const url = new URL(value); return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")); }, "MCP OAuth endpoints must use HTTPS or loopback HTTP");
const metadataSchema = z.object({ authorization_endpoint: secureUrl, issuer: secureUrl, registration_endpoint: secureUrl, token_endpoint: secureUrl });
const registrationSchema = z.object({ client_id: z.string(), client_secret: z.string().optional() });
const tokenSchema = z.object({ access_token: z.string(), expires_in: z.number().positive().default(3600), refresh_token: z.string().optional(), token_type: z.literal("Bearer") });
const storedTokenSchema = z.object({ accessToken: z.string(), clientId: z.string(), clientSecret: z.string().optional(), expiresAt: z.number(), refreshToken: z.string() });
const OAUTH_TIMEOUT_MS = 15_000;
const OAUTH_RESPONSE_LIMIT = 1_000_000;

export type StoredOAuthToken = z.infer<typeof storedTokenSchema>;
export interface OAuthTokenStore { load(issuer: string): Promise<StoredOAuthToken | null>; save(issuer: string, token: StoredOAuthToken): Promise<void> }
export class OAuthAuthorizationRequiredError extends Error { constructor() { super("MCP OAuth authorization required"); this.name = "OAuthAuthorizationRequiredError"; } }

export class McpOAuthClient {
  readonly #fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  readonly #issuer: string;
  readonly #now: () => number;
  readonly #redirectUri: string;
  readonly #store: OAuthTokenStore;

  constructor({ fetcher = (input, init) => fetch(input, init), issuer, now = Date.now, redirectUri, store }: { fetcher?: (input: string, init?: RequestInit) => Promise<Response>; issuer: string; now?: () => number; redirectUri: string; store: OAuthTokenStore }) {
    this.#fetcher = fetcher;
    this.#issuer = normalizeIssuer(issuer);
    assertSecureIssuer(this.#issuer);
    this.#now = now;
    this.#redirectUri = redirectUri;
    this.#store = store;
  }

  async register(): Promise<{ clientId: string; clientSecret?: string }> {
    const metadata = await this.#metadata();
    const { response, value } = await fetchJsonBounded(this.#fetcher, metadata.registration_endpoint, { body: JSON.stringify({ application_type: "native", client_name: "Relay", redirect_uris: [this.#redirectUri], token_endpoint_auth_method: "none" }), headers: { "content-type": "application/json" }, method: "POST" });
    if (!response.ok) throw new Error(`MCP OAuth registration failed: ${response.status}`);
    const registration = registrationSchema.parse(value);
    return { clientId: registration.client_id, clientSecret: registration.client_secret };
  }

  async authorizationUrl({ clientId, codeChallenge, state }: { clientId: string; codeChallenge: string; state: string }): Promise<string> {
    const metadata = await this.#metadata();
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({ client_id: clientId, code_challenge: codeChallenge, code_challenge_method: "S256", redirect_uri: this.#redirectUri, response_type: "code", state }).toString();
    return url.toString();
  }

  async exchangeAuthorizationCode({ clientId, clientSecret, code, codeVerifier, responseIssuer }: { clientId: string; clientSecret?: string; code: string; codeVerifier: string; responseIssuer: string }): Promise<string> {
    if (normalizeIssuer(responseIssuer) !== this.#issuer) throw new Error("MCP OAuth authorization response issuer mismatch");
    const metadata = await this.#metadata();
    return this.#exchange({ clientId, clientSecret, metadata, params: { client_id: clientId, code, code_verifier: codeVerifier, grant_type: "authorization_code", redirect_uri: this.#redirectUri } });
  }

  async accessToken(): Promise<string> {
    const stored = await this.#store.load(this.#issuer);
    if (!stored) throw new OAuthAuthorizationRequiredError();
    if (stored.expiresAt > this.#now() + 30_000) return stored.accessToken;
    const metadata = await this.#metadata();
    return this.#exchange({ clientId: stored.clientId, clientSecret: stored.clientSecret, fallbackRefreshToken: stored.refreshToken, metadata, params: { client_id: stored.clientId, grant_type: "refresh_token", refresh_token: stored.refreshToken } });
  }

  async beginAuthorization(): Promise<{ authorizationUrl: string; completion: Promise<void> }> {
    const registration = await this.register();
    const codeVerifier = randomUrlToken();
    const state = randomUrlToken();
    const codeChallenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))));
    let settle: { reject(error: Error): void; resolve(): void } | undefined;
    const completion = new Promise<void>((resolve, reject) => { settle = { reject, resolve }; });
    const callbackUrl = new URL(this.#redirectUri);
    const server = Bun.serve({ hostname: "127.0.0.1", port: Number(callbackUrl.port), fetch: async (request) => {
      const url = new URL(request.url);
      try {
        if (url.searchParams.get("state") !== state) throw new Error("MCP OAuth state mismatch");
        const code = url.searchParams.get("code");
        const responseIssuer = url.searchParams.get("iss");
        if (!code || !responseIssuer) throw new Error("MCP OAuth callback omitted code or issuer");
        await this.exchangeAuthorizationCode({ ...registration, code, codeVerifier, responseIssuer });
        settle?.resolve();
        return new Response("Relay MCP authorization complete. You can close this tab.");
      } catch (error) {
        settle?.reject(error instanceof Error ? error : new Error(String(error)));
        return new Response("Relay MCP authorization failed.", { status: 400 });
      } finally { setTimeout(() => server.stop(true), 0); }
    } });
    return { authorizationUrl: await this.authorizationUrl({ clientId: registration.clientId, codeChallenge, state }), completion };
  }

  async #exchange({ clientId, clientSecret, fallbackRefreshToken, metadata, params }: { clientId: string; clientSecret?: string; fallbackRefreshToken?: string; metadata: z.infer<typeof metadataSchema>; params: Record<string, string> }): Promise<string> {
    if (clientSecret) params.client_secret = clientSecret;
    const { response, value } = await fetchJsonBounded(this.#fetcher, metadata.token_endpoint, { body: new URLSearchParams(params), headers: { "content-type": "application/x-www-form-urlencoded" }, method: "POST" });
    if (!response.ok) throw new Error(`MCP OAuth token request failed: ${response.status}`);
    const token = tokenSchema.parse(value);
    const refreshToken = token.refresh_token ?? fallbackRefreshToken;
    if (!refreshToken) throw new Error("MCP OAuth server omitted refresh token");
    await this.#store.save(this.#issuer, { accessToken: token.access_token, clientId, clientSecret, expiresAt: this.#now() + token.expires_in * 1000, refreshToken });
    return token.access_token;
  }

  async #metadata(): Promise<z.infer<typeof metadataSchema>> {
    const { response, value } = await fetchJsonBounded(this.#fetcher, metadataUrl(this.#issuer));
    if (!response.ok) throw new Error(`MCP OAuth discovery failed: ${response.status}`);
    const metadata = metadataSchema.parse(value);
    if (normalizeIssuer(metadata.issuer) !== this.#issuer) throw new Error("MCP OAuth metadata issuer mismatch");
    return metadata;
  }
}

export class FileOAuthTokenStore implements OAuthTokenStore {
  readonly #path: string;
  constructor({ path }: { path: string }) { this.#path = path; }
  async load(issuer: string): Promise<StoredOAuthToken | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (typeof value !== "object" || value === null || !(issuer in value)) return null;
      return storedTokenSchema.parse(value[issuer as keyof typeof value]);
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async save(issuer: string, token: StoredOAuthToken): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    let current: Record<string, unknown> = {};
    try { const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8")); if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) current = Object.fromEntries(Object.entries(parsed)); }
    catch (error) { if (!isMissing(error)) throw error; }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...current, [issuer]: storedTokenSchema.parse(token) }), { mode: 0o600 });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600);
  }
}

function normalizeIssuer(value: string): string { return new URL(value).toString().replace(/\/$/, ""); }
function assertSecureIssuer(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) throw new Error("MCP OAuth issuer must use HTTPS or loopback HTTP");
}
function metadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `/.well-known/oauth-authorization-server${issuerPath}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function randomUrlToken(): string { return base64Url(crypto.getRandomValues(new Uint8Array(32))); }
function base64Url(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64url"); }

async function fetchJsonBounded(fetcher: (input: string, init?: RequestInit) => Promise<Response>, input: string, init: RequestInit = {}): Promise<{ response: Response; value: unknown }> {
  const controller = new AbortController();
  const deadline = Date.now() + OAUTH_TIMEOUT_MS;
  try {
    const response = await oauthTimeout(fetcher(input, { ...init, signal: controller.signal }), deadline, "MCP OAuth request timed out", () => controller.abort());
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > OAUTH_RESPONSE_LIMIT) throw new Error("MCP OAuth response exceeds size limit");
    if (!response.body) throw new Error("MCP OAuth response omitted body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await oauthTimeout(reader.read(), deadline, "MCP OAuth response timed out", () => { void reader.cancel(); });
        if (part.done) break;
        length += part.value.byteLength;
        if (length > OAUTH_RESPONSE_LIMIT) throw new Error("MCP OAuth response exceeds size limit");
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { response, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } finally { controller.abort(); }
}

async function oauthTimeout<T>(operation: Promise<T>, deadline: number, message: string, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { onTimeout(); reject(new Error(message)); }, Math.max(1, deadline - Date.now())); });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
