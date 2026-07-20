export type ConnectionState = Readonly<{ connectivity: "online" | "offline" | "reconnecting"; freshness: "fresh" | "stale" | "gap"; lastSequence: number; error?: string }>;
export const INITIAL_CONNECTION_STATE: ConnectionState = { connectivity: "offline", freshness: "stale", lastSequence: 0 };
