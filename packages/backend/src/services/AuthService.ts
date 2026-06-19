/**
 * AuthService — local-account auth for BRD §7.8.
 *
 * Passwords and client-app secrets are bcrypt-hashed at rest. Sessions are stateless
 * JWTs (jose, HS256) carrying { sub: userId, orgId, role }. The actor middleware
 * verifies the access token and populates req.actor from its claims.
 */
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config';
import type { UserRole } from '../api/middleware/actor';

const secret = new TextEncoder().encode(config.JWT_SECRET);

export interface TokenClaims {
  sub: string;          // userId
  orgId: string;
  role: UserRole;
  type: 'access' | 'refresh';
}

/** Hash a password or client secret (bcrypt). */
export function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/** Verify a plaintext against a bcrypt hash. */
export function verifySecret(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(plain, hash);
}

function sign(claims: Omit<TokenClaims, 'type'>, type: 'access' | 'refresh', ttl: string): Promise<string> {
  return new SignJWT({ orgId: claims.orgId, role: claims.role, type })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

export function signAccess(c: Omit<TokenClaims, 'type'>): Promise<string> {
  return sign(c, 'access', config.JWT_ACCESS_TTL);
}

export function signRefresh(c: Omit<TokenClaims, 'type'>): Promise<string> {
  return sign(c, 'refresh', config.JWT_REFRESH_TTL);
}

/** Verify a token and return its claims, or null if invalid/expired. */
export async function verifyToken(token: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const p = payload as JWTPayload & { orgId?: string; role?: string; type?: string };
    if (!p.sub || !p.orgId || !p.role) return null;
    return { sub: p.sub, orgId: p.orgId, role: p.role as UserRole, type: (p.type as 'access' | 'refresh') ?? 'access' };
  } catch {
    return null;
  }
}
