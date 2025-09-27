// server.js
import 'dotenv/config';
import Fastify from 'fastify';
import { readFile } from 'fs/promises';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import ejs from 'ejs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });

// Connexion Postgres
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || 'postgres',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres'
});

// Helper format temps
const fmt = (secs) => {
  if (secs == null) return '—';
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// SQL
const SQL_PLAYER = `
  SELECT
    player_name,
    races_participated,
    first_places,
    second_places,
    third_places,
    forfeits,
    EXTRACT(EPOCH FROM best_time) AS best_time_sec
  FROM DTM.DTM_STATS_RANDO_PLAYER_STATS
  WHERE player_name = $1
  LIMIT 1;
`;

const SQL_H2H = `
  SELECT
    player_one_name, player_two_name,
    races_common_participated,
    player_one_win, player_two_win
  FROM DTM.DTM_STATS_RANDO_PLAYER_VS_STATS
  WHERE (player_one_name = $1 AND player_two_name = $2)
     OR (player_one_name = $2 AND player_two_name = $1)
  LIMIT 1;
`;

// Fetch functions
async function loadPlayer(name) {
  const { rows } = await pool.query(SQL_PLAYER, [name]);
  if (!rows[0]) {
    return { name, races: 0, firsts: 0, seconds: 0, thirds: 0, forfeits: 0, bestTimeSec: null };
  }
  const r = rows[0];
  return {
    name: r.player_name,
    races: r.races_participated,
    firsts: r.first_places,
    seconds: r.second_places,
    thirds: r.third_places,
    forfeits: r.forfeits,
    bestTimeSec: r.best_time_sec
  };
}

async function loadH2H(a, b) {
  const { rows } = await pool.query(SQL_H2H, [a, b]);
  if (!rows[0]) return { racesCommon: 0, aWins: 0, bWins: 0 };
  const r = rows[0];
  if (r.player_one_name === a) {
    return { racesCommon: r.races_common_participated, aWins: r.player_one_win, bWins: r.player_two_win };
  } else {
    return { racesCommon: r.races_common_participated, aWins: r.player_two_win, bWins: r.player_one_win };
  }
}

// --- SQL globals (durées en secondes) ---
const SQL_GLOBALS = `
  SELECT
    nb_races,
    EXTRACT(EPOCH FROM avg_best_time)  AS avg_best_time_sec,
    EXTRACT(EPOCH FROM avg_time)       AS avg_time_sec,
    EXTRACT(EPOCH FROM avg_worst_time) AS avg_worst_time_sec,
    EXTRACT(EPOCH FROM best_time)      AS best_time_sec,
    EXTRACT(EPOCH FROM worst_time)     AS worst_time_sec,
    avg_number_player,
    worst_number_player,
    best_number_player
  FROM DTM.DTM_STATS_RANDO_RACE_STATS
  LIMIT 1;
`;

const SQL_PLAYER_COUNT = `
  SELECT COUNT(DISTINCT player_name) AS players
  FROM DTM.DTM_STATS_RANDO_PLAYER_STATS;
`;

async function loadGlobals() {
  const [g, c] = await Promise.all([
    pool.query(SQL_GLOBALS),
    pool.query(SQL_PLAYER_COUNT)
  ]);
  const row = g.rows[0] || {};
  const players = c.rows[0]?.players ?? 0;
  return {
    nbRaces: row.nb_races ?? 0,
    avgBestTimeSec: row.avg_best_time_sec ?? null,
    avgTimeSec: row.avg_time_sec ?? null,
    avgWorstTimeSec: row.avg_worst_time_sec ?? null,
    bestTimeSec: row.best_time_sec ?? null,
    worstTimeSec: row.worst_time_sec ?? null,
    avgNumberPlayer: row.avg_number_player ?? 0,
    worstNumberPlayer: row.worst_number_player ?? 0,
    bestNumberPlayer: row.best_number_player ?? 0,
    players
  };
}

// Charger le template EJS
const template = await readFile(path.join(__dirname, 'views', 'render.ejs'), 'utf8');

// Route racine → redirection vers exemple
app.get('/', async (req, reply) => {
  reply.redirect('/preview?left=papy_grant&right=blueguy0014');
});

// Route HTML
app.get('/preview', async (req, reply) => {
  const left = String(req.query.left || 'papy_grant').trim();
  const right = String(req.query.right || 'blueguy0014').trim();

  const [L, R, H] = await Promise.all([loadPlayer(left), loadPlayer(right), loadH2H(left, right)]);
  const totalWins = Math.max(1, H.aWins + H.bWins);
  const leftPct = Math.round((H.aWins / totalWins) * 100);
  const rightPct = 100 - leftPct;

  const html = await ejs.render(template, {
    data: {
      left: L,
      right: R,
      racesCommon: H.racesCommon,
      leftWins: H.aWins,
      rightWins: H.bWins
    },
    metrics: {
      leftPct,
      rightPct,
      bestLeft: fmt(L.bestTimeSec),
      bestRight: fmt(R.bestTimeSec),
      now: new Date().toISOString()
    }
  });

  reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
});

// Route PNG
app.get('/render.png', async (req, reply) => {
  const left = req.query.left || 'papy_grant';
  const right = req.query.right || 'blueguy0014';
  const url = `http://localhost:${process.env.PORT || 3000}/preview?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--font-render-hinting=medium']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  const png = await page.screenshot({ type: 'png' });
  await browser.close();

  reply.header('Content-Type', 'image/png').send(png);
});

// HTML
app.get('/globals', async (req, reply) => {
  const G = await loadGlobals();
  const html = await ejs.render(
    await readFile(path.join(__dirname, 'views', 'globals.ejs'), 'utf8'),
    {
      g: G,
      fmt, // ton helper h:mm:ss
      now: new Date().toISOString()
    }
  );
  reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
});

// PNG
app.get('/globals.png', async (req, reply) => {
  const url = `http://localhost:${process.env.PORT || 3000}/globals`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--font-render-hinting=medium']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  const png = await page.screenshot({ type: 'png' });
  await browser.close();

  reply.header('Content-Type', 'image/png').send(png);
});

// Lancer le serveur
const port = Number(process.env.PORT || 3000);
app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`Preview: http://localhost:${port}/preview?left=papy_grant&right=blueguy0014`);
  app.log.info(`render: http://localhost:${port}/render.png?left=papy_grant&right=blueguy0014`);
});