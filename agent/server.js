// agent/server.js — Versión B (solo compilación; USB/Upload lo maneja Arduino Cloud Agent)
//
// Endpoints:
//  - GET  /health
//  - POST /compile  { ino: string, fqbn: string }  -> { ok, fqbn, outFormat, artifactBase64, artifactFile, stdout }
//
// Busca arduino-cli en:
//  1) process.env.ARDUINO_CLI (ruta explícita)
//  2) ~/.smartblock/arduino-cli/arduino-cli (si usaste el instalador anterior)
//  3) en PATH (which arduino-cli)
//
// Requisitos locales: tener 'arduino-cli' instalado y los cores adecuados.

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.SMARTBLOCK_PORT || 5055;

// Autoriza tu web (Vercel) y dev local:
const ALLOWED = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://smartblock.vercel.app' // ← cambia por tu dominio real
];

const app = express();
app.use(bodyParser.json({ limit: '8mb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/postman
    return cb(null, ALLOWED.includes(origin));
  }
}));

// ---------- Utilidades ----------
function home() { return os.homedir() || process.cwd(); }

function findArduinoCli() {
  if (process.env.ARDUINO_CLI && fs.existsSync(process.env.ARDUINO_CLI)) {
    return process.env.ARDUINO_CLI;
  }
  const fromSmartblock = path.join(home(), '.smartblock', 'arduino-cli', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
  if (fs.existsSync(fromSmartblock)) return fromSmartblock;

  // Busca en PATH
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = require('child_process').execSync(`${which} arduino-cli`, { stdio: ['ignore','pipe','ignore'] }).toString().trim();
    if (out) return out.split('\n')[0].trim();
  } catch (_) {}
  return null;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject({ err, stdout, stderr });
      else resolve({ stdout, stderr });
    });
  });
}

function makeTmpSketch() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-compile-'));
  const sketchDir = path.join(base, 'sketch');
  fs.mkdirSync(sketchDir);
  return { base, sketchDir };
}

// ---------- Endpoints ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, role: 'compiler-only', port: PORT, platform: process.platform, arch: process.arch });
});

/**
 * POST /compile
 * Body: { ino: string, fqbn: string }
 * Devuelve: { ok, fqbn, outFormat, artifactBase64, artifactFile, stdout }
 */
app.post('/compile', async (req, res) => {
  const { ino, fqbn } = req.body || {};
  if (!ino || !fqbn) return res.status(400).json({ ok:false, error: 'missing ino/fqbn' });

  const cli = findArduinoCli();
  if (!cli) {
    return res.status(500).json({
      ok:false,
      error:'arduino-cli no encontrado. Instalá Arduino IDE 2 o arduino-cli, o define ARDUINO_CLI=/ruta/arduino-cli'
    });
  }

  const { base, sketchDir } = makeTmpSketch();
  try {
    // 1) escribir sketch
    const inoPath = path.join(sketchDir, 'sketch.ino');
    fs.writeFileSync(inoPath, ino, 'utf8');

    // 2) compilar a directorio de salida
    const outDir = path.join(base, 'out');
    fs.mkdirSync(outDir);
    // --export-binaries guarda en build; --output-dir nos permite controlar dónde
    const args = ['compile', '--fqbn', fqbn, '--export-binaries', '--output-dir', outDir, sketchDir];

    const { stdout } = await run(cli, args, { cwd: sketchDir });

    // 3) localizar artifacto (.hex o .bin)
    const files = fs.readdirSync(outDir).map(f => path.join(outDir, f));
    const artifactFile = files.find(p => p.endsWith('.hex')) || files.find(p => p.endsWith('.bin'));
    if (!artifactFile) {
      throw new Error(`No se encontró .hex/.bin en ${outDir}`);
    }
    const outFormat = artifactFile.endsWith('.hex') ? 'hex' : 'bin';
    const artifactBase64 = fs.readFileSync(artifactFile).toString('base64');

    res.json({
      ok: true,
      fqbn,
      outFormat,
      artifactBase64,
      artifactFile,
      stdout
    });
  } catch (e) {
    const msg = e?.stderr || e?.message || String(e);
    res.status(500).json({ ok:false, error: msg });
  } finally {
    // limpieza best-effort
    try { fs.rmSync(base, { recursive:true, force:true }); } catch {}
  }
});

// ---------- Arranque ----------
app.listen(PORT, () => {
  console.log(`SmartBlock Compiler on http://localhost:${PORT}  (solo compilación; USB/Upload = Arduino Cloud Agent)`);
});
