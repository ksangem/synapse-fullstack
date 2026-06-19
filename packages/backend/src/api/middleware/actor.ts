/**
 * Actor seam — resolves the caller's identity for every /api request.
 *
 * Primary path: verify the `Authorization: Bearer <jwt>` and populate req.actor from
 * its claims (BRD §7.8). Enforcement is gated by config.AUTH_REQUIRED:
 *   - required (production by default): no/invalid token on a protected route → 401.
 *   - not required (dev/test): fall back to the x-user-* headers / seeded default admin,
 *     so the existing test suite and dev workflows keep working while the token path is live.
 *
 * Public routes (no token needed): POST /auth/login, /auth/refresh, and the webhook
 * ingest (/ingest/:token has its own HMAC). Mounted in index.ts before the API router.
 */
import type { Request, Response, NextFunction } from 'express';
import { DEFAULT_ORG, DEFAULT_USER_ID } from '../../connectors/seed-data';
import { config } from '../../config';
import { verifyToken } from '../../services/AuthService';

export type UserRole = 'admin' | 'designer' | 'operator' | 'viewer';

export interface Actor {
  userId: string;
  orgId: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor: Actor;
    }
  }
}

const VALID_ROLES: UserRole[] = ['admin', 'designer', 'operator', 'viewer'];

function parseRole(raw: string | undefined): UserRole {
  return raw && (VALID_ROLES as string[]).includes(raw) ? (raw as UserRole) : 'admin';
}

/** Paths under /api that don't require authentication. */
function isPublic(path: string): boolean {
  return path === '/auth/login' || path === '/auth/refresh' || path.startsWith('/ingest/');
}

function fallbackActor(req: Request): Actor {
  return {
    userId: req.header('x-user-id') || DEFAULT_USER_ID,
    orgId: req.header('x-org-id') || DEFAULT_ORG,
    role: parseRole(req.header('x-user-role')),
  };
}

/** Populate req.actor from a verified JWT, else fall back / 401 per AUTH_REQUIRED. */
export async function actorMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.header('authorization');
  if (auth && auth.startsWith('Bearer ')) {
    const claims = await verifyToken(auth.slice(7));
    if (claims && claims.type === 'access') {
      req.actor = { userId: claims.sub, orgId: claims.orgId, role: claims.role };
      next();
      return;
    }
    if (config.AUTH_REQUIRED && !isPublic(req.path)) {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
      return;
    }
  } else if (config.AUTH_REQUIRED && !isPublic(req.path)) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  // Not enforced (dev/test) or a public route → header/default actor.
  req.actor = fallbackActor(req);
  next();
}

/** Guard a route to one of the given roles; 403 otherwise. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.actor || !roles.includes(req.actor.role)) {
      res.status(403).json({ success: false, error: `Forbidden — requires role: ${roles.join(' or ')}` });
      return;
    }
    next();
  };
}
