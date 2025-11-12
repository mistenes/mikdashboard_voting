import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3001;
const TOTAL_VOTERS = Number.parseInt(process.env.TOTAL_VOTERS || '', 10) || 10;
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

const defaultResults = () => ({ igen: 0, nem: 0, tartozkodott: 0 });

let sessionState = {
  status: 'WAITING',
  results: defaultResults(),
  totalVoters: TOTAL_VOTERS,
  voteStartTime: null,
};

const clients = new Set();

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
  app.use(cors({ origin: true }));
}

app.get('/api/session', (_req, res) => {
  res.json(sessionState);
});

app.post('/api/session/start', (req, res) => {
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

app.post('/api/session/finish', (_req, res) => {
  if (sessionState.status !== 'IN_PROGRESS') {
    return res.status(400).send('A szavazás nincs folyamatban.');
  }

  setState({ status: 'FINISHED' });
  return res.json(sessionState);
});

app.post('/api/session/reset', (_req, res) => {
  setState({
    status: 'WAITING',
    results: defaultResults(),
    voteStartTime: null,
  });

  return res.json(sessionState);
});

app.post('/api/session/vote', (req, res) => {
  if (sessionState.status !== 'IN_PROGRESS') {
    return res.status(400).send('A szavazás nem aktív.');
  }

  const voteType = req.body?.voteType;
  if (!['igen', 'nem', 'tartozkodott'].includes(voteType)) {
    return res.status(400).send('Érvénytelen szavazat típus.');
  }

  setState({
    results: {
      ...sessionState.results,
      [voteType]: sessionState.results[voteType] + 1,
    },
  });

  return res.json(sessionState);
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
