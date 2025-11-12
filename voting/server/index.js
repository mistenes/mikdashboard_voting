import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3001;
const TOTAL_VOTERS = Number.parseInt(process.env.TOTAL_VOTERS || '', 10) || 10;
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

const SSO_SECRET = process.env.VOTING_SSO_SECRET || 'development-secret';
const SSO_TTL_SECONDS = Number.parseInt(process.env.VOTING_SSO_TTL_SECONDS || '300', 10) || 300;
const SESSION_TTL_SECONDS = Number.parseInt(
  process.env.VOTING_SESSION_TTL_SECONDS || '3600',
  10,
) || 3600;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim();

const defaultResults = () => ({ igen: 0, nem: 0, tartozkodott: 0 });

let sessionState = {
  status: 'WAITING',
  results: defaultResults(),
  totalVoters: TOTAL_VOTERS,
  voteStartTime: null,
};

const clients = new Set();
const sessions = new Map();

const broadcast = () => {
  const payload = `data: ${JSON.stringify(sessionState)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
};

const setState = (nextState) => {
  sessionState = { ...sessionState, ...nextState };
  broadcast();
};

app.use(express.json());

if (!isProduction) {
  app.use(cors({ origin: true, credentials: true }));
}

function base64UrlDecode(value) {
  try {
    return Buffer.from(value, 'base64url');
  } catch (_error) {
    return null;
  }
}

function verifySsoToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }
  const payloadBuffer = base64UrlDecode(encodedPayload);
  if (!payloadBuffer) {
    return null;
  }
  const expectedSignature = crypto
    .createHmac('sha256', SSO_SECRET)
    .update(payloadBuffer)
    .digest('hex');
  if (signature.length !== expectedSignature.length) {
    return null;
  }
  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(payloadBuffer.toString('utf8'));
  } catch (_error) {
    return null;
  }
  if (payload.exp && Date.now() >= payload.exp * 1000) {
    return null;
  }
  return payload;
}

function parseCookies(header = '') {
  return header.split(';').reduce((acc, entry) => {
    const [key, value] = entry.split('=');
    if (!key) {
      return acc;
    }
    acc[key.trim()] = decodeURIComponent((value || '').trim());
    return acc;
  }, {});
}

function setSessionCookie(res, sessionId) {
  const cookieParts = [
    `voting_session=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isProduction) {
    cookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearSessionCookie(res) {
  const cookieParts = ['voting_session=;', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isProduction) {
    cookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function createSession(user) {
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  sessions.set(sessionId, { user, expiresAt });
  return { id: sessionId, user };
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = cookies.voting_session;
  if (!sessionId) {
    return null;
  }
  const record = sessions.get(sessionId);
  if (!record) {
    return null;
  }
  if (record.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return { id: sessionId, user: record.user };
}

function refreshSession(res, sessionId, user) {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  sessions.set(sessionId, { user, expiresAt });
  setSessionCookie(res, sessionId);
}

function ensureSession(req, res) {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ detail: 'Nincs bejelentkezett felhasználó.' });
    return null;
  }
  refreshSession(res, session.id, session.user);
  req.sessionUser = session.user;
  req.sessionId = session.id;
  return session;
}

function requireRoles(roles) {
  return (req, res, next) => {
    const session = ensureSession(req, res);
    if (!session) {
      return;
    }
    if (!roles.includes(session.user.role)) {
      res.status(403).json({ detail: 'Nincs jogosultság a művelethez.' });
      return;
    }
    next();
  };
}

app.get('/api/auth/session', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ detail: 'Nincs bejelentkezett felhasználó.' });
    return;
  }
  refreshSession(res, session.id, session.user);
  res.json({ user: session.user });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ detail: 'A felhasználónév és jelszó megadása kötelező.' });
    return;
  }
  if (!ADMIN_PASSWORD) {
    res.status(503).json({ detail: 'Az adminisztrátori bejelentkezés nincs konfigurálva.' });
    return;
  }
  if (username.toLowerCase() !== ADMIN_USERNAME.toLowerCase() || password !== ADMIN_PASSWORD) {
    res.status(401).json({ detail: 'Hibás felhasználónév vagy jelszó.' });
    return;
  }
  const session = createSession({ role: 'admin', username: ADMIN_USERNAME, email: ADMIN_EMAIL || undefined });
  setSessionCookie(res, session.id);
  res.json({ user: session.user });
});

app.post('/api/auth/logout', (req, res) => {
  const session = getSessionFromRequest(req);
  if (session) {
    sessions.delete(session.id);
  }
  clearSessionCookie(res);
  res.json({ user: null });
});

app.get('/sso', (req, res) => {
  const token = req.query.token;
  const payload = verifySsoToken(token);
  if (!payload) {
    res.status(400).send('Érvénytelen vagy lejárt SSO token.');
    return;
  }
  const role = payload.role === 'admin' ? 'admin' : 'voter';
  const session = createSession({
    role,
    id: payload.uid,
    email: payload.email,
    firstName: payload.first_name,
    lastName: payload.last_name,
    organizationId: payload.org,
  });
  setSessionCookie(res, session.id);
  res.redirect('/');
});

app.get('/api/session', (_req, res) => {
  res.json(sessionState);
});

app.post('/api/session/start', requireRoles(['admin']), (req, res) => {
  const totalVoters = Number.parseInt(req.body?.totalVoters, 10);
  const safeTotalVoters = Number.isFinite(totalVoters) && totalVoters > 0 ? totalVoters : sessionState.totalVoters;

  setState({
    status: 'IN_PROGRESS',
    results: defaultResults(),
    totalVoters: safeTotalVoters,
    voteStartTime: new Date().toISOString(),
  });

  res.json(sessionState);
});

app.post('/api/session/finish', requireRoles(['admin']), (_req, res) => {
  if (sessionState.status !== 'IN_PROGRESS') {
    res.status(400).json({ detail: 'A szavazás nincs folyamatban.' });
    return;
  }

  setState({ status: 'FINISHED' });
  res.json(sessionState);
});

app.post('/api/session/reset', requireRoles(['admin']), (_req, res) => {
  setState({
    status: 'WAITING',
    results: defaultResults(),
    voteStartTime: null,
  });

  res.json(sessionState);
});

app.post('/api/session/vote', requireRoles(['voter', 'admin']), (req, res) => {
  if (sessionState.status !== 'IN_PROGRESS') {
    res.status(400).json({ detail: 'A szavazás nem aktív.' });
    return;
  }

  const voteType = req.body?.voteType;
  if (!['igen', 'nem', 'tartozkodott'].includes(voteType)) {
    res.status(400).json({ detail: 'Érvénytelen szavazat típus.' });
    return;
  }

  setState({
    results: {
      ...sessionState.results,
      [voteType]: sessionState.results[voteType] + 1,
    },
  });

  res.json(sessionState);
});

app.get('/api/session/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify(sessionState)}\n\n`);

  clients.add(res);

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
    res.end();
  });
});

if (isProduction) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const distPath = path.resolve(__dirname, '../dist');

  app.use(express.static(distPath));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Voting service listening on port ${PORT}`);
});
