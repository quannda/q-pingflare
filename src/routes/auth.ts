import { Hono } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import type { Env } from '../index'
import { isAuthDisabled } from '../middleware/auth'

const auth = new Hono<{ Bindings: Env }>()

async function issueToken(sub: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key)
}

/**
 * Public: the frontend asks this before deciding whether to bounce to /login.
 * Deliberately unauthenticated -- it leaks nothing beyond the fact that the
 * origin delegates authentication to whatever sits in front of it.
 */
auth.get('/config', (c) => c.json({ authDisabled: isAuthDisabled(c.env) }))

auth.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>()

  // With AUTH_DISABLED the credential env vars are optional, so they may both be
  // empty -- which an empty form post would otherwise match.
  if (!c.env.ADMIN_USER || !c.env.ADMIN_PASS || !c.env.JWT_SECRET) {
    return c.json({ error: 'Password login is not configured' }, 400)
  }

  if (body.username !== c.env.ADMIN_USER || body.password !== c.env.ADMIN_PASS) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await issueToken(c.env.ADMIN_USER, c.env.JWT_SECRET)
  return c.json({ token })
})

auth.post('/refresh', async (c) => {
  const authorization = c.req.header('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const oldToken = authorization.slice(7)
  try {
    const key = new TextEncoder().encode(c.env.JWT_SECRET)
    await jwtVerify(oldToken, key)
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }

  const token = await issueToken(c.env.ADMIN_USER, c.env.JWT_SECRET)
  return c.json({ token })
})

export default auth
