// agent/server.js — SmartBlock Agent (auto-download arduino-cli + compile/upload)
// Multiplaforma: macOS (ARM/Intel) / Windows x64 / Linux x64

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');

const PORT = process.env.SMARTBLOCK_PORT || 5055;

// ⚠️ AGREGA TU DOMINIO DE VERCEL AQUÍ:
const ALLOWED = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://smartblock.vercel.app', // ← cambia por el tuyo si es distinto
];

// ------------------- Express setup -------------------
const app = express();
app.use(bodyParser.json({ limit: '8mb' }));
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl/postman
      return cb(null, ALLOWED.includes(origin));
    },
  })
);

// ------------------- Utilidades de FS/OS -------------------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function home() {
  return os.homedir() || process.cwd();
}
function cliInstallDir() {
  return path.join(home(), '.smartblock', 'arduino-cli');
}
function cliBinaryPath() {
  const dir = cliInstallDir();
  return process.platform === 'win32'
    ? path.join(dir, 'arduino-cli.exe')
    : path.join(dir, 'arduino-cli');
}

// ------------------- Resolución de URL correcta -------------------
// (Nombre CONSISTENTE con lo que usa ensureCli)
function downloadUrl() {
  const base = 'https://downloads.arduino.cc/arduino-cli';
  if (process.platform === 'darwin') {
    // macOS
    if (process.arch === 'arm64') {
      // Apple Silicon
      return `${base}/arduino-cli_latest_macOS_ARM64.tar.gz`;
    } else {
      // Intel
      return `${base}/arduino-cli_latest_macOS_64bit.tar.gz`;
    }
  }
  if (process.platform === 'win32') {
    // Windows x64
    return `${base}/arduino-cli_latest_Windows_64bit.zip`;
  }
  // Linux x64
  return `${base}/arduino-cli_latest_Linux_64bit.tar.gz`;
}

// ------------------- Descarga con manejo de redirecciones -------------------
function fetchToFile(url, outPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const visited = new Set();

    function _get(currentUrl, redirectsLeft) {
      if (redirectsLeft < 0) return reject(new Error('Demasiadas redirecciones'));
      if (visited.has(currentUrl)) return reject(new Error('Redirección cíclica'));
      visited.add(currentUrl);

      const file = fs.createWriteStream(outPath);
      https
        .get(currentUrl, (res) => {
          // 3xx → follow
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close(() => fs.unlink(outPath, () => {})); // limpiar
            const next = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, currentUrl).href;
            return _get(next, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            file.close(() => fs.unlink(outPath, () => {}));
            return reject(new Error(`Error HTTP ${res.statusCode}`));
          }
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
        })
        .on('error', (e) => {
          file.close(() => fs.unlink(outPath, () => {}));
          reject(e);
        });
    }

    _get(url, maxRedirects);
  });
}

// ------------------- Descompresión -------------------
function unzipZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const ps = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(
          /'/g,
          "''"
        )}' -Force`,
      ]);
      ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Expand-Archive falló'))));
    } else {
      const unzip = spawn('unzip', ['-o', zipPath, '-d', destDir]);
      unzip.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('unzip falló'))));
    }
  });
}

function untarGz(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', tarPath, '-C', destDir]);
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('tar xzf falló'))));
  });
}

// ------------------- ensureCli: descarga + extrae + instala -------------------
async function ensureCli() {
  const bin = cliBinaryPath();
  if (fs.existsSync(bin)) return bin;

  const installDir = cliInstallDir();
  ensureDir(installDir);
  const tmpDir = path.join(installDir, '_tmp');
  ensureDir(tmpDir);

  const url = downloadUrl(); // ← nombre consistente
  const ext = url.endsWith('.zip') ? '.zip' : '.tar.gz';
  const archive = path.join(tmpDir, 'arduino-cli' + ext);

  console.log('[Agent] Descargando arduino-cli de:', url);
  await fetchToFile(url, archive);

  console.log('[Agent] Extrayendo:', ext);
  if (ext === '.zip') await unzipZip(archive, tmpDir);
  else await untarGz(archive, tmpDir);

  // buscar ejecutable dentro del paquete
  function findCli(dir) {
    const entries = fs.readdirSync(dir);
    for (const f of entries) {
      const p = path.join(dir, f);
      const s = fs.statSync(p);
      if (s.isDirectory()) {
        const inner = findCli(p);
        if (inner) return inner;
      } else if (f === 'arduino-cli' || f === 'arduino-cli.exe') {
        if (process.platform === 'win32') {
          if (p.endsWith('.exe')) return p;
        } else {
          if (!p.endsWith('.exe')) return p;
        }
      }
    }
    return null;
  }

  const found = findCli(tmpDir);
  if (!found) throw new Error('No se encontró arduino-cli dentro del paquete');

  fs.copyFileSync(found, bin);
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);

  // limpieza best-effort
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log('[Agent] CLI instalado en:', bin);
  return bin;
}

// ------------------- Run helper -------------------
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject({ err, stdout, stderr });
      else resolve({ stdout, stderr });
    });
  });
}

function tmpSketchDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'smartblock-'));
  const sketch = path.join(base, 'sketch');
  fs.mkdirSync(sketch);
  return { base, sketch };
}

// ------------------- Endpoints -------------------
app.get('/health', (req, res) => {
  res.json({ ok: true, agent: 'smartblock', port: PORT, platform: process.platform, arch: process.arch });
});

app.get('/version', async (req, res) => {
  try {
    const cli = await ensureCli();
    const v = await run(cli, ['version']);
    res.json({ ok: true, version: v.stdout.trim() });
  } catch (e) {
    const msg = e?.stderr || e?.message || String(e);
    console.error('[Agent] /version error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post('/init', async (req, res) => {
  try {
    const cli = await ensureCli();
    await run(cli, ['config', 'init']);
    await run(cli, ['core', 'update-index']);
    res.json({ ok: true });
  } catch (e) {
    const msg = e?.stderr || e?.message || String(e);
    console.error('[Agent] /init error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post('/install-core', async (req, res) => {
  const { core } = req.body || {};
  if (!core) return res.status(400).json({ ok: false, error: 'missing core (e.g., "arduino:avr")' });
  try {
    const cli = await ensureCli();
    const r = await run(cli, ['core', 'install', core]);
    res.json({ ok: true, stdout: r.stdout });
  } catch (e) {
    const msg = e?.stderr || e?.message || String(e);
    console.error('[Agent] /install-core error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get('/boards', async (req, res) => {
  try {
    const cli = await ensureCli();
    const r = await run(cli, ['board', 'list', '--format', 'json']);
    res.json({ ok: true, data: JSON.parse(r.stdout) });
  } catch (e) {
    const msg = e?.stderr || e?.message || String(e);
    console.error('[Agent] /boards error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post('/compile', async (req, res) => {
  const { ino, fqbn } = req.body || {};
  if (!ino || !fqbn) return res.status(400).json({ ok: false, error: 'missing ino/fqbn' });
  const { sketch } = tmpSketchDir();
  try {
    const cli = await ensureCli();
    fs.writeFileSync(path.join(sketch, 'sketch.ino'), ino, 'utf8');
    const comp = await run(cli, ['compile', '--fqbn', fqbn, sketch], sketch);
    res.json({ ok: true, stdout: comp.stdout });
  } catch (e) {
    const msg = e?.stderr || e?.message || String(e);
    console.error('[Agent] /compile error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.post('/compile-upload', async (req, res) => {
  const { ino, fqbn, port } = req.body || {};
  if (!ino || !fqbn || !port) return res.status(400).json({ ok: false, error: 'missing ino/fqbn/port' });
  const { sketch } = tmpSketchDir();
  try {
    const cli = await ensureCli();
    fs.writeFileSync(path.join(sketch, 'sketch.ino'), ino, 'utf8');
    await run(cli, ['compile', '--fqbn', fqbn, sketch], sketch);
    const up = await run(cli, ['upload', '-p', port, '--fqbn', fqbn, sketch], sketch);
    res.json({ ok: true, upload: up.stdout });
  } catch (e) {
    const msg = e?.stderr || e?.message || String(e);
    console.error('[Agent] /compile-upload error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

// ------------------- Arranque + auto-prepare -------------------
app.listen(PORT, () => {
  console.log(`SmartBlock Agent on http://localhost:${PORT}`);
  // Dispara la descarga del CLI al iniciar (silencioso, con logs en consola):
  (async () => {
    try {
      await ensureCli();
      console.log('[Agent] CLI listo (auto-prepare)');
    } catch (e) {
      console.error('[Agent] ensureCli falló al iniciar:', e?.message || e);
    }
  })();
});
