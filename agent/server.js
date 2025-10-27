const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const os = require('os');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');

const PORT = process.env.SMARTBLOCK_PORT || 5055;

// AGREGA tu dominio real de Vercel aquí 👇
const ALLOWED = [
  'http://localhost:5173',
  'https://TU-PROYECTO.vercel.app'
];

const app = express();
app.use(bodyParser.json({ limit: '8mb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    return cb(null, ALLOWED.includes(origin));
  }
}));

/* ========== Descarga automática ========== */

function platformTag() {
  if (process.platform === 'darwin')
    return process.arch === 'arm64' ? 'macOS_arm64' : 'macOS_amd64';
  if (process.platform === 'win32') return 'Windows_64bit';
  if (process.platform === 'linux') return 'Linux_64bit';
  throw new Error('Plataforma no soportada');
}

function downloadUrlForPlatform() {
  const base = 'https://downloads.arduino.cc/arduino-cli';
  if (process.platform === 'darwin') {
    // macOS
    if (process.arch === 'arm64') {
      // Mac M1, M2, M3
      return `${base}/arduino-cli_latest_macOS_ARM64.tar.gz`;
    } else {
      // Mac Intel
      return `${base}/arduino-cli_latest_macOS_64bit.tar.gz`;
    }
  }
  if (process.platform === 'win32') {
    // Windows 64-bit
    return `${base}/arduino-cli_latest_Windows_64bit.zip`;
  }
  // Linux (64-bit)
  return `${base}/arduino-cli_latest_Linux_64bit.tar.gz`;
}

function installDir() {
  return path.join(os.homedir(), '.smartblock', 'arduino-cli');
}
function cliPath() {
  const dir = installDir();
  return path.join(dir, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
}
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function download(url, dest) {
  return new Promise((res, rej) => {
    const file = fs.createWriteStream(dest);
    https.get(url, response => {
      if (response.statusCode !== 200) return rej(`Error HTTP ${response.statusCode}`);
      response.pipe(file);
      file.on('finish', () => file.close(res));
    }).on('error', rej);
  });
}

function unzip(file, dest) {
  return new Promise((res, rej) => {
    if (process.platform === 'win32') {
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${file}' -DestinationPath '${dest}' -Force`]);
      ps.on('exit', code => code === 0 ? res() : rej('Expand-Archive falló'));
    } else {
      const u = spawn('unzip', ['-o', file, '-d', dest]);
      u.on('exit', code => code === 0 ? res() : rej('unzip falló'));
    }
  });
}
function untar(file, dest) {
  return new Promise((res, rej) => {
    const t = spawn('tar', ['-xzf', file, '-C', dest]);
    t.on('exit', code => code === 0 ? res() : rej('tar falló'));
  });
}

async function ensureCli() {
  const cli = cliPath();
  if (fs.existsSync(cli)) return cli;

  const url = downloadUrlForPlatform();
  const tmp = path.join(os.tmpdir(), 'smartblock-cli');
  ensureDir(tmp);
  const archive = path.join(tmp, 'cli.zip');
  await download(url, archive);
  if (url.endsWith('.zip')) await unzip(archive, tmp);
  else await untar(archive, tmp);

  const found = findCli(tmp);
  if (!found) throw new Error('No se encontró arduino-cli');
  ensureDir(installDir());
  fs.copyFileSync(found, cli);
  if (process.platform !== 'win32') fs.chmodSync(cli, 0o755);
  return cli;
}

function findCli(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      const r = findCli(p);
      if (r) return r;
    } else if (f === 'arduino-cli' || f === 'arduino-cli.exe') {
      return p;
    }
  }
  return null;
}

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
  return { sketch };
}

/* ========== Endpoints ========== */

app.get('/health', (req,res)=> res.json({ ok:true, agent:'smartblock', port:PORT, platform:process.platform, arch:process.arch }) );

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

app.post('/init', async (req,res)=>{
  try {
    const cli = await ensureCli();
    await run(cli, ['config','init']);
    await run(cli, ['core','update-index']);
    res.json({ ok:true });
  } catch(e){ res.status(500).json({ ok:false, stdout:e.stdout, stderr:e.stderr }); }
});

app.post('/install-core', async (req,res)=>{
  const { core } = req.body || {};
  if (!core) return res.status(400).json({ ok:false, error:'missing core' });
  try {
    const cli = await ensureCli();
    const out = await run(cli, ['core','install', core]);
    res.json({ ok:true, stdout: out.stdout });
  } catch(e){ res.status(500).json({ ok:false, stdout:e.stdout, stderr:e.stderr }); }
});

app.get('/boards', async (req,res)=>{
  try {
    const cli = await ensureCli();
    const out = await run(cli, ['board','list','--format','json']);
    res.json({ ok:true, data: JSON.parse(out.stdout) });
  } catch(e){ res.status(500).json({ ok:false, error:e.stderr||String(e.err) }); }
});

app.post('/compile-upload', async (req,res)=>{
  const { ino, fqbn, port } = req.body || {};
  if (!ino || !fqbn || !port) return res.status(400).json({ ok:false, error:'missing ino/fqbn/port' });
  const { sketch } = tmpSketchDir();
  try {
    const cli = await ensureCli();
    fs.writeFileSync(path.join(sketch, 'sketch.ino'), ino, 'utf8');
    await run(cli, ['compile','--fqbn', fqbn, sketch], sketch);
    const up = await run(cli, ['upload','-p', port, '--fqbn', fqbn, sketch], sketch);
    res.json({ ok:true, upload: up.stdout });
  } catch(e){ res.status(500).json({ ok:false, stdout:e.stdout, stderr:e.stderr }); }
});

app.listen(PORT, () => {
  console.log(`SmartBlock Agent on http://localhost:${PORT}`);
  (async () => {
    try {
      await ensureCli();
      console.log('[Agent] CLI listo (auto-prepare)');
    } catch (e) {
      console.error('[Agent] ensureCli falló al iniciar:', e?.message || e);
    }
  })();
});
