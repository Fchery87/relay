import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

// The provider's default hash is lucia's pure-JS scrypt, which exceeds
// Convex's hard 1s mutation limit on low-end hardware. PBKDF2 through the
// runtime's native WebCrypto stays well inside the budget.
const PBKDF2_ITERATIONS = 120_000;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function deriveKey(secret: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ hash: "SHA-256", iterations, name: "PBKDF2", salt: salt as BufferSource }, key, 256);
  return toHex(new Uint8Array(bits));
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      crypto: {
        async hashSecret(secret) {
          const salt = crypto.getRandomValues(new Uint8Array(16));
          return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${await deriveKey(secret, salt, PBKDF2_ITERATIONS)}`;
        },
        async verifySecret(secret, hash) {
          const [scheme, iterations, saltHex, digestHex] = hash.split(":");
          if (scheme !== "pbkdf2" || !iterations || !saltHex || !digestHex) return false;
          const derived = await deriveKey(secret, fromHex(saltHex), Number(iterations));
          if (derived.length !== digestHex.length) return false;
          let mismatch = 0;
          for (let i = 0; i < derived.length; i++) mismatch |= derived.charCodeAt(i) ^ digestHex.charCodeAt(i);
          return mismatch === 0;
        },
      },
    }),
  ],
});
