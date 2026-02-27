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
 * Checks standard install locations for the current platform.
 *
 * Note: On WSL, only Linux-native browsers are auto-detected.
 * Windows browsers (via /mnt/c/) don't work reliably with Puppeteer
 * due to pipe communication issues across the WSL boundary.
 * Users on WSL should install Chromium inside WSL.
 *
 * @returns Absolute path to the browser executable
 * @throws Error with platform-specific install instructions if no browser is found
 */
export function findBrowserExecutable(): string {
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === 'linux') {
    candidates.push(...LINUX_CHROME_PATHS);
    // Note: WSL Windows paths (/mnt/c/...) are intentionally excluded
    // from auto-detection because Puppeteer cannot reliably launch
    // Windows executables from WSL (pipe/socket communication fails).
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
  const wsl = isWSL();
  const instructions = getInstallInstructions(platform, wsl);
  throw new Error(
    'No Chrome, Chromium, or Edge browser found on your system.\n'
    + 'PDF generation requires a Chromium-based browser.\n\n'
    + instructions,
  );
}

function getInstallInstructions(platform: string, wsl: boolean): string {
  if (wsl) {
    return 'You are running in WSL. Windows browsers cannot be used\n'
      + 'because Puppeteer cannot communicate with them across the\n'
      + 'WSL boundary. Install Chromium inside WSL instead:\n\n'
      + '  sudo apt update && sudo apt install -y chromium-browser\n\n'
      + 'If that package is not available, try:\n'
      + '  sudo apt install -y chromium\n\n'
      + 'Or specify a browser path with: markbind pdf --browser /path/to/chrome';
  }
  if (platform === 'linux') {
    return 'Install a browser:\n'
      + '  sudo apt install chromium-browser    # Debian/Ubuntu\n'
      + '  sudo dnf install chromium            # Fedora\n'
      + '  sudo pacman -S chromium              # Arch\n\n'
      + 'Or specify a browser path with: markbind pdf --browser /path/to/chrome';
  }
  if (platform === 'darwin') {
    return 'Install a browser:\n'
      + '  brew install --cask google-chrome\n'
      + '  # or download from https://www.google.com/chrome/\n\n'
      + 'Or specify a browser path with: markbind pdf --browser /path/to/chrome';
  }
  if (platform === 'win32') {
    return 'Install Chrome or Edge:\n'
      + '  https://www.google.com/chrome/\n'
      + '  https://www.microsoft.com/edge\n\n'
      + 'Or specify a browser path with: markbind pdf --browser /path/to/chrome';
  }
  return 'Install Chrome, Chromium, or Edge on your system.\n'
    + 'Or specify a browser path with: markbind pdf --browser /path/to/chrome';
}
