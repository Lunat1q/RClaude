import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Single sign-on through a forward-auth proxy (e.g. authentik). The proxy passes the user's OIDC ID token in a header.
// It is only trusted when signed by the configured issuer for our client ID, and only for the configured email,
// since RClaude has a single account. A spoofed header fails the signature check.

export const ssoEnabled = Boolean(config.ssoIssuer && config.ssoClientId && config.ssoEmail);

let jwks: Promise<JWTVerifyGetKey> | undefined;

/** Signing keys from the issuer's discovery document; jose caches them and refetches on an unknown key ID. */
function getJwks(): Promise<JWTVerifyGetKey> {
  jwks ??= (async () => {
    const res = await fetch(`${config.ssoIssuer}.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const { jwks_uri } = (await res.json()) as { jwks_uri?: string };
    if (!jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
    return createRemoteJWKSet(new URL(jwks_uri));
  })().catch((err: unknown) => {
    jwks = undefined; // retry discovery on the next request
    throw err;
  });
  return jwks;
}

/** True when the request carries a valid SSO ID token for the configured user. */
export async function hasValidSsoToken(req: IncomingMessage): Promise<boolean> {
  if (!ssoEnabled) return false;
  const token = req.headers[config.ssoHeader];
  if (typeof token !== "string" || !token) return false;
  try {
    const { payload } = await jwtVerify(token, await getJwks(), {
      issuer: config.ssoIssuer,
      audience: config.ssoClientId,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (email === config.ssoEmail) return true;
    console.warn(`SSO token rejected: ${email || "(no email)"} is not the configured user`);
  } catch (err) {
    console.warn(`SSO token rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}
