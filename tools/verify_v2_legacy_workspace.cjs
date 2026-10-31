/* Exercise the shipping WPF entry point against a rejected old workspace. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'var/verification/legacy-desktop-' + Date.now());
const workspace = path.join(output, 'V1-workspace');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'var/runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function snapshot(directory) {
  const files = {};
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath || entry.path, entry.name);
    const relative = path.relative(directory, full);
    files[relative] = entry.isDirectory() ? 'directory' : crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  return files;
}
(async () => {
  fs.mkdirSync(workspace, { recursive: true });
  execFileSync(runtime.python, ['-B', '-c',
    'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE jobs(id TEXT PRIMARY KEY, snapshot TEXT)"); c.execute("INSERT INTO jobs VALUES (?,?)",("old-job","old-protocol-data")); c.commit(); c.close()',
    path.join(workspace, 'jobs.sqlite3')], { windowsHide: true });
  fs.writeFileSync(path.join(workspace, 'historical-data.txt'), 'Keep this legacy data unchanged.');
  const before = snapshot(workspace);
  const child = spawn(path.join(root, 'var/build/desktop/SatelliteStudio.Desktop.exe'),
    ['--project-root', root, '--workspace', workspace, '--python', runtime.python, '--blender', runtime.blender],
    { windowsHide: true, stdio: 'ignore' });
  try {
    await pause(4000);
    if (child.exitCode === null) {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
      for (let i = 0; i < 40 && child.exitCode === null; i++) await pause(100);
    }
    if (child.exitCode === null) throw new Error('Rejection window did not close');
    const after = snapshot(workspace);
    const passed = JSON.stringify(before) === JSON.stringify(after);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed, before, after }, null, 2));
    if (!passed) throw new Error('Desktop changed rejected V1 workspace: ' + Object.keys(after).filter(k => !(k in before)).join(', '));
    console.log(JSON.stringify({ passed: true, checkedFiles: Object.keys(before).length, output }));
  } finally {
    if (child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
