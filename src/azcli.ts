import * as cp from 'child_process';

/**
 * Thin wrapper around the Azure CLI (`az`).
 *
 * On Windows `az` is a batch file (`az.cmd`), which cannot be launched with
 * `execFile('az', ...)` on modern Node. We therefore run everything through the
 * platform shell and quote arguments ourselves.
 */

export interface AzResult {
  stdout: string;
  stderr: string;
}

/** Quote a single argument for the platform shell. */
function quoteArg(a: string): string {
  if (a.length === 0) {
    return '""';
  }
  if (!/[\s"'^&|<>()%!]/.test(a)) {
    return a;
  }
  // Wrap in double quotes and escape embedded double quotes.
  return '"' + a.replace(/"/g, '\\"') + '"';
}

/**
 * Run an `az` command. Rejects with an Error whose message contains stderr
 * when the CLI exits non-zero.
 */
export interface RunAzOptions {
  /** Milliseconds before the command is killed. 0 disables the timeout. */
  timeoutMs?: number;
}

export function runAz(args: string[], opts: RunAzOptions = {}): Promise<AzResult> {
  const line = ['az', ...args.map(quoteArg)].join(' ');
  const timeout = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = cp.exec(
      line,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.killed || e.signal) {
            reject(
              new Error(
                'The Azure CLI command timed out. If sign-in is required, run ' +
                  '"Azure VM SSH: Sign in to Azure" and try again.'
              )
            );
            return;
          }
          const detail = (stderr || stdout || err.message).trim();
          reject(new Error(detail || 'az exited with an error'));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
    // We never run az in an interactive terminal, so any prompt (e.g.
    // "Overwrite (y/n)?") would hang forever. Answer "yes" and close stdin.
    child.stdin?.on('error', () => {
      /* ignore EPIPE when az isn't reading stdin */
    });
    child.stdin?.end('y\n');
  });
}

/** Run an `az` command and parse stdout as JSON. */
export async function runAzJson<T>(args: string[]): Promise<T> {
  const { stdout } = await runAz([...args, '-o', 'json']);
  return JSON.parse(stdout) as T;
}

export interface AzAccount {
  id: string;
  name: string;
  isDefault: boolean;
  state: string;
  user?: { name?: string };
}

export interface AzVm {
  name: string;
  resourceGroup: string;
  location: string;
  powerState?: string;
  publicIps?: string;
  privateIps?: string;
}

/** Whether the `az` CLI is installed and callable. */
export async function isAzInstalled(): Promise<boolean> {
  try {
    await runAz(['version', '-o', 'none']);
    return true;
  } catch {
    return false;
  }
}

/** The currently signed-in account, or undefined if not logged in. */
export async function currentAccount(): Promise<AzAccount | undefined> {
  try {
    return await runAzJson<AzAccount>(['account', 'show']);
  } catch {
    return undefined;
  }
}

export function listSubscriptions(): Promise<AzAccount[]> {
  return runAzJson<AzAccount[]>(['account', 'list', '--all']);
}

export function setSubscription(subscriptionId: string): Promise<AzResult> {
  return runAz(['account', 'set', '--subscription', subscriptionId]);
}

export function login(): Promise<AzResult> {
  // Browser / device-code sign-in can take a while; don't time it out.
  return runAz(['login'], { timeoutMs: 0 });
}

/** List VMs in the current subscription, including power state and IPs. */
export function listVms(): Promise<AzVm[]> {
  return runAzJson<AzVm[]>(['vm', 'list', '-d']);
}

/** Fetch the instance power state of a single VM, e.g. "VM running". */
export async function getPowerState(
  resourceGroup: string,
  name: string
): Promise<string | undefined> {
  const view = await runAzJson<{ statuses?: { code?: string; displayStatus?: string }[] }>([
    'vm',
    'get-instance-view',
    '--resource-group',
    resourceGroup,
    '--name',
    name,
  ]);
  const status = (view.statuses || []).find((s) =>
    (s.code || '').startsWith('PowerState/')
  );
  return status?.displayStatus;
}

/** Whether a power-state string means the VM is running. */
export function isRunning(powerState?: string): boolean {
  return (powerState || '').toLowerCase().includes('running');
}

export function startVm(resourceGroup: string, name: string): Promise<AzResult> {
  return runAz(['vm', 'start', '--resource-group', resourceGroup, '--name', name]);
}

/** Deallocate a VM (portal "Stop" — releases compute so billing stops). */
export function deallocateVm(resourceGroup: string, name: string): Promise<AzResult> {
  return runAz(['vm', 'deallocate', '--resource-group', resourceGroup, '--name', name]);
}
