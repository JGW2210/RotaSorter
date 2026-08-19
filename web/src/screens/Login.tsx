import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

/* Email and password, one screen, no self-registration. Accounts are created
 * deliberately in the Supabase dashboard. */
export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  }

  return (
    <main className="login">
      <form className="login__card" onSubmit={onSubmit}>
        <div className="login__brand">
          <span className="rail__mark" aria-hidden="true" />
          RotaSorter
        </div>

        <label className="field">
          <span className="field__label">Email</span>
          <input
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Password</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="login__note">
          Accounts are created in the Supabase dashboard. There is no self-registration.
        </p>
      </form>
    </main>
  );
}
