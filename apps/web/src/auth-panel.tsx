import { useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";

type AuthMode = "signIn" | "signUp";

export function AuthForm({ onSubmit }: { onSubmit: (input: { email: string; mode: AuthMode; password: string }) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    const data = new FormData(event.currentTarget, submitter);
    const mode: AuthMode = data.get("flow") === "signUp" ? "signUp" : "signIn";
    setPending(true);
    setError(null);
    try {
      await onSubmit({ email: String(data.get("email") ?? ""), mode, password: String(data.get("password") ?? "") });
    } catch (submissionError: unknown) {
      setError(submissionError instanceof Error ? submissionError.message : "Authentication failed");
    } finally {
      setPending(false);
    }
  }

  return <main className="auth-workspace"><form className="auth-form" onSubmit={(event) => void submit(event)}>
    <h1>Relay</h1>
    <label>Email<input autoComplete="email" name="email" required type="email" /></label>
    <label>Password<input autoComplete="current-password" minLength={8} name="password" required type="password" /></label>
    {error ? <p role="alert">{error}</p> : null}
    <div className="auth-actions"><button disabled={pending} name="flow" type="submit" value="signIn">Sign in</button><button disabled={pending} name="flow" type="submit" value="signUp">Create account</button></div>
  </form></main>;
}

export function AuthPanel() {
  const { signIn } = useAuthActions();
  return <AuthForm onSubmit={({ email, mode, password }) => signIn("password", { email, flow: mode, password })} />;
}
