import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Absolute path to the user's main SSH config file (~/.ssh/config). */
export function mainSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * Ensure `~/.ssh/config` pulls in `includePath` via an `Include` directive.
 *
 * The directive is prepended so it applies globally (SSH only honours an
 * `Include` that appears before any `Host`/`Match` block it should affect).
 */
export function ensureInclude(includePath: string): void {
  const configPath = mainSshConfigPath();
  const sshDir = path.dirname(configPath);
  fs.mkdirSync(sshDir, { recursive: true });

  const includeLine = `Include ${includePath}`;
  let existing = '';
  if (fs.existsSync(configPath)) {
    existing = fs.readFileSync(configPath, 'utf8');
    // Match the same path regardless of surrounding whitespace.
    const already = existing
      .split(/\r?\n/)
      .some((l) => l.trim().toLowerCase() === includeLine.toLowerCase());
    if (already) {
      return;
    }
  }

  const banner = '# Added by the "Azure VM SSH" extension\n';
  const prefix = banner + includeLine + '\n\n';
  fs.writeFileSync(configPath, prefix + existing, 'utf8');
}

/**
 * Extract the first `Host` alias from an SSH config file, ignoring wildcard
 * patterns. `az ssh config` writes a friendly `<rg>-<vm>` block first.
 */
export function firstHostAlias(configFile: string): string | undefined {
  const text = fs.readFileSync(configFile, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^Host\s+(.+)$/i.exec(line);
    if (!m) {
      continue;
    }
    const alias = m[1]
      .split(/\s+/)
      .find((a) => a && !a.includes('*') && !a.includes('?'));
    if (alias) {
      return alias;
    }
  }
  return undefined;
}

/** Extract the first `HostName` (target address) from an SSH config file. */
export function firstHostName(configFile: string): string | undefined {
  const text = fs.readFileSync(configFile, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*HostName\s+(\S+)/i.exec(raw);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}
