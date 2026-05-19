const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function getPythonCommand() {
  const venvPython = path.join(PROJECT_ROOT, '.venv-cma', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) return { cmd: venvPython, argsPrefix: [] };

  if (process.env.PYTHON_PATH && process.env.PYTHON_PATH.trim()) {
    return { cmd: process.env.PYTHON_PATH.trim(), argsPrefix: [] };
  }
  if (process.env.PYTHON && process.env.PYTHON.trim()) {
    return { cmd: process.env.PYTHON.trim(), argsPrefix: [] };
  }
  if (process.platform === 'win32') return { cmd: 'py', argsPrefix: ['-3.11'] };
  return { cmd: 'python3', argsPrefix: [] };
}

function friendlyPythonCarrierError(carrier, stderr, stdout) {
  const text = `${stderr || ''}\n${stdout || ''}`.trim();
  if (!text) return `${carrier} Python UC flow failed with no output.`;

  if (/No module named ['\"]undetected_chromedriver['\"]/i.test(text)) {
    return `${carrier} env missing undetected-chromedriver. Run setup-python-carriers.bat first.`;
  }
  if (/No module named ['\"]selenium['\"]/i.test(text)) {
    return `${carrier} env missing selenium. Run setup-python-carriers.bat first.`;
  }
  if (/No module named ['\"]distutils['\"]/i.test(text)) {
    return `${carrier} requires Python 3.11. Current Python is too new for this UC flow.`;
  }
  if (/No suitable Python runtime found|Requested Python version|Python 3\.11 is not installed/i.test(text)) {
    return 'Python 3.11 is not installed. Install Python 3.11, then run setup-python-carriers.bat.';
  }
  if (/Chrome executable not found/i.test(text)) {
    return `Google Chrome was not found for ${carrier}. Install Chrome or set CHROME_BINARY.`;
  }
  if (/ChromeDriver\/Chrome version mismatch|only supports Chrome version|Current browser version/i.test(text)) {
    return `${carrier} ChromeDriver/Chrome version mismatch. Set UC_VERSION_MAIN to your Chrome major version, e.g. set UC_VERSION_MAIN=147.`;
  }
  if (/unrecognized Chrome version: Edg\//i.test(text)) {
    return `${carrier} UC flow requires Google Chrome. Install Chrome or set CHROME_BINARY.`;
  }

  return text;
}

function createPythonCarrier({ carrier, scriptName, defaultTrackingNumber }) {
  return function trackWithPython(trackingNumber = defaultTrackingNumber) {
    return new Promise((resolve) => {
      const script = path.resolve(PROJECT_ROOT, 'app', 'carriers', scriptName);
      const python = getPythonCommand();
      const child = spawn(python.cmd, [...python.argsPrefix, script, trackingNumber], {
        cwd: PROJECT_ROOT,
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: false,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('error', (err) => {
        resolve({
          status: 'error',
          carrier,
          trackingNumber,
          pod: '',
          eta: '',
          error: `Failed to start ${carrier} Python UC flow: ${err.message}`,
        });
      });

      child.on('close', () => {
        const lines = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        let parsed = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i]);
            break;
          } catch (_) {}
        }

        if (parsed) {
          resolve({
            status: parsed.status || (parsed.pod || parsed.eta ? 'success' : 'error'),
            carrier,
            trackingNumber,
            pod: parsed.pod || '',
            eta: parsed.eta || '',
            error: parsed.error || '',
          });
          return;
        }

        resolve({
          status: 'error',
          carrier,
          trackingNumber,
          pod: '',
          eta: '',
          error: friendlyPythonCarrierError(carrier, stderr, stdout),
        });
      });
    });
  };
}

module.exports = { createPythonCarrier };
