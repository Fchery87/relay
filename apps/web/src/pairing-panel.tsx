import { useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

const claimPairing = makeFunctionReference<"mutation", { code: string }, null>("pairing:claim");

export function PairingForm({ onSubmit }: { onSubmit: (code: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(String(new FormData(event.currentTarget).get("code") ?? ""));
    } catch (claimError: unknown) {
      setError(claimError instanceof Error ? claimError.message : "Unable to pair daemon");
    } finally {
      setPending(false);
    }
  }
  return <section className="pairing-panel"><h2>Pair daemon</h2><form onSubmit={(event) => void submit(event)}><label>Pairing code<input autoComplete="one-time-code" name="code" required /></label>{error ? <p role="alert">{error}</p> : null}<button disabled={pending} type="submit">Pair device</button></form></section>;
}

export function PairingPanel() {
  const claim = useMutation(claimPairing);
  return <PairingForm onSubmit={(code) => claim({ code })} />;
}
