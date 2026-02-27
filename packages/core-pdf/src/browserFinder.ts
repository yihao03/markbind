import fs from 'fs';
import { execSync } from 'child_process';

const LINUX_CHROME_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/microsoft-edge',
];

const MACOS_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const WINDOWS_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

// Windows paths accessible from WSL via /mnt/c/
const WSL_WINDOWS_PATHS = [
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function isWSL(): boolean {
  try {
    const version = fs.readFileSync('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

function tryWhich(name: string): string | null {
  try {
    const result = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function tryWhere(name: string): string | null {
  try {
    const result = execSync(`where ${name} 2>nul`, { encoding: 'utf-8' }).trim();
    // 'where' may return multiple lines; take the first
    return result.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Find a Chrome, Chromium, or Edge executable on the system.
 * Checks standard install locations for the current platform,
 * including Windows browsers accessible from WSL via /mnt/c/.
 *
 * @returns Absolute path to the browser executable
 * @throws Error with platform-specific install instructions if no browser is found
 */
export function findBrowserExecutable(): string {
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === 'linux') {
    candidates.push(...LINUX_CHROME_PATHS);
    if (isWSL()) {
      candidates.push(...WSL_WINDOWS_PATHS);
    }
  } else if (platform === 'darwin') {
    candidates.push(...MACOS_CHROME_PATHS);
  } else if (platform === 'win32') {
    candidates.push(...WINDOWS_CHROME_PATHS);
  }

  // Check known paths
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: try which/where for non-standard installs
  if (platform !== 'win32') {
    for (const name of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'microsoft-edge']) {
      const found = tryWhich(name);
      if (found) return found;
    }
  } else {
    for (const name of ['chrome', 'msedge']) {
      const found = tryWhere(name);
      if (found) return found;
    }
  }

  // Nothing found — throw with helpful instructions
  const instructions = getInstallInstructions(platform, isWSL());
  throw new Error(
    'No Chrome, Chromium, or Edge browser found on your system.\n'
    + 'PDF generation requires a Chromium-based browser.\n\n'
    + instructions + '\n\n'
    + 'Alternatively, specify a browser path:\n'
    + '  markbind pdf --browser /path/to/chrome\n'
    + '  # or set PUPPETEER_EXECUTABLE_PATH=/path/to/chrome',
  );
}

function getInstallInstructions(platform: string, wsl: boolean): string {
  if (wsl) {
    return 'You are running in WSL. Install Chrome or Edge on Windows,\n'
      + 'or install Chromium inside WSL:\n'
      + '  sudo apt install chromium-browser';
  }
  if (platform === 'linux') {
    return 'Install a browser:\n'
      + '  sudo apt install chromium-browser    # Debian/Ubuntu\n'
      + '  sudo dnf install chromium            # Fedora\n'
      + '  sudo pacman -S chromium              # Arch';
  }
  if (platform === 'darwin') {
    return 'Install a browser:\n'
      + '  brew install --cask google-chrome\n'
      + '  # or download from https://www.google.com/chrome/';
  }
  if (platform === 'win32') {
    return 'Install Chrome or Edge:\n'
      + '  https://www.google.com/chrome/\n'
      + '  https://www.microsoft.com/edge';
  }
  return 'Install Chrome, Chromium, or Edge on your system.';
}
