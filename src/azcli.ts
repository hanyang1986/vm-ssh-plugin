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

// ---------------------------------------------------------------------------
// Network security group (NSG) helpers — used to allow SSH from the caller's
// public IP without touching the Azure portal.
// ---------------------------------------------------------------------------

export interface NsgRef {
  /** Resource group that contains the NSG (may differ from the VM's). */
  resourceGroup: string;
  name: string;
}

export interface UpsertRuleResult {
  created: boolean;
  ip: string;
  priority: number;
  nsg: string;
}

/** Fixed name of the inbound rule this extension manages. */
const SSH_RULE_NAME = 'AzureVmSsh-AllowMyIP';

/** Split an ARM resource id into its resource group and (last-segment) name. */
function parseResourceId(id: string): NsgRef {
  const parts = id.split('/');
  const idx = parts.findIndex((p) => p.toLowerCase() === 'resourcegroups');
  return {
    resourceGroup: idx >= 0 ? parts[idx + 1] : '',
    name: parts[parts.length - 1],
  };
}

/**
 * Resolve the NSG that governs inbound traffic to a VM: first the NSG on the
 * VM's primary NIC, falling back to the NSG on the NIC's subnet. Returns
 * undefined when neither the NIC nor its subnet has an NSG attached.
 */
export async function getVmNsg(
  resourceGroup: string,
  name: string
): Promise<NsgRef | undefined> {
  const vm = await runAzJson<{
    networkProfile?: { networkInterfaces?: { id: string }[] };
  }>(['vm', 'show', '--resource-group', resourceGroup, '--name', name]);

  const nicId = vm.networkProfile?.networkInterfaces?.[0]?.id;
  if (!nicId) {
    return undefined;
  }

  const nic = await runAzJson<{
    networkSecurityGroup?: { id?: string };
    ipConfigurations?: { subnet?: { id?: string } }[];
  }>(['network', 'nic', 'show', '--ids', nicId]);

  if (nic.networkSecurityGroup?.id) {
    return parseResourceId(nic.networkSecurityGroup.id);
  }

  const subnetId = nic.ipConfigurations?.[0]?.subnet?.id;
  if (!subnetId) {
    return undefined;
  }
  const subnet = await runAzJson<{ networkSecurityGroup?: { id?: string } }>([
    'network',
    'vnet',
    'subnet',
    'show',
    '--ids',
    subnetId,
  ]);
  return subnet.networkSecurityGroup?.id
    ? parseResourceId(subnet.networkSecurityGroup.id)
    : undefined;
}

/**
 * Create or update the managed inbound rule so that TCP/22 is allowed from
 * `ip` (a single address). Reuses a stable rule name so repeated calls just
 * move the allowed IP rather than piling up rules.
 */
export async function upsertSshRule(
  nsg: NsgRef,
  ip: string
): Promise<UpsertRuleResult> {
  const cidr = `${ip}/32`;
  const details = await runAzJson<{
    securityRules?: { name: string; priority: number }[];
  }>(['network', 'nsg', 'show', '--resource-group', nsg.resourceGroup, '--name', nsg.name]);

  const rules = details.securityRules || [];
  const existing = rules.find((r) => r.name === SSH_RULE_NAME);

  if (existing) {
    await runAz([
      'network', 'nsg', 'rule', 'update',
      '--resource-group', nsg.resourceGroup,
      '--nsg-name', nsg.name,
      '--name', SSH_RULE_NAME,
      '--source-address-prefixes', cidr,
      '--destination-port-ranges', '22',
      '--protocol', 'Tcp',
      '--access', 'Allow',
      '--direction', 'Inbound',
    ]);
    return { created: false, ip, priority: existing.priority, nsg: nsg.name };
  }

  // Pick the lowest unused priority in a low band so the allow rule wins.
  const used = new Set(rules.map((r) => r.priority));
  let priority = 300;
  while (used.has(priority)) {
    priority += 10;
  }
  await runAz([
    'network', 'nsg', 'rule', 'create',
    '--resource-group', nsg.resourceGroup,
    '--nsg-name', nsg.name,
    '--name', SSH_RULE_NAME,
    '--priority', String(priority),
    '--source-address-prefixes', cidr,
    '--destination-port-ranges', '22',
    '--protocol', 'Tcp',
    '--access', 'Allow',
    '--direction', 'Inbound',
    '--description', 'Added by the Azure VM SSH extension',
  ]);
  return { created: true, ip, priority, nsg: nsg.name };
}
