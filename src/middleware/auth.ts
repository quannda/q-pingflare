import { createMiddleware } from 'hono/factory'
import { jwtVerify } from 'jose'
import type { Env } from '../index'

/**
 * Bypass the built-in login entirely. Meant for deployments that already sit
 * behind an external identity proxy -- Cloudflare Access, an SSO reverse proxy,
 * a private network. With this on, every /api route is reachable by anyone who
 * can reach the origin, so the proxy IS the authentication.
 *
 * On Cloudflare that also means locking down the workers.dev route: Access
 * policies apply to the custom hostname, and `<worker>.<subdomain>.workers.dev`
 * would otherwise be an unprotected way in.
 */
export function isAuthDisabled(env: Env): boolean {
  const v = env.AUTH_DISABLED
  return v === 'true' || v === '1'
}

export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (isAuthDisabled(c.env)) return next()

  const authorization = c.req.header('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authorization.slice(7)
  try {
    const key = new TextEncoder().encode(c.env.JWT_SECRET)
    await jwtVerify(token, key)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})
