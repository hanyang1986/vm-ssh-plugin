import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AzVm,
  currentAccount,
  deallocateVm,
  getPowerState,
  getVmNsg,
  isAzInstalled,
  isRunning,
  listSubscriptions,
  listVms,
  login as azLogin,
  runAz,
  setSubscription,
  startVm,
  upsertSshRule,
} from './azcli';
import { getLocalPublicIp } from './network';
import { ensureInclude, firstHostAlias, firstHostName } from './sshConfig';
import { VmTreeItem, VmTreeProvider } from './tree';

let tree: VmTreeProvider;
let extContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  tree = new VmTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('azureVmSshVms', tree)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('azureVmSsh.connect', () =>
      connectPickCommand(false)
    ),
    vscode.commands.registerCommand('azureVmSsh.connectCurrentWindow', () =>
      connectPickCommand(true)
    ),
    vscode.commands.registerCommand('azureVmSsh.login', () => loginCommand()),
    vscode.commands.registerCommand('azureVmSsh.selectSubscription', () =>
      selectSubscriptionCommand()
    ),
    vscode.commands.registerCommand('azureVmSsh.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('azureVmSsh.connectVm', (item?: VmTreeItem) =>
      connectItemCommand(item, false)
    ),
    vscode.commands.registerCommand(
      'azureVmSsh.connectVmCurrentWindow',
      (item?: VmTreeItem) => connectItemCommand(item, true)
    ),
    vscode.commands.registerCommand('azureVmSsh.startVm', (item?: VmTreeItem) =>
      powerCommand(item, 'start')
    ),
    vscode.commands.registerCommand('azureVmSsh.stopVm', (item?: VmTreeItem) =>
      powerCommand(item, 'stop')
    ),
    vscode.commands.registerCommand('azureVmSsh.addMyIp', (item?: VmTreeItem) =>
      addMyIpCommand(item)
    )
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function loginCommand(): Promise<void> {
  if (!(await ensureAz())) {
    return;
  }
  await withProgress('Signing in to Azure…', async () => {
    await azLogin();
  });
  const acct = await currentAccount();
  if (acct) {
    tree.refresh();
    vscode.window.showInformationMessage(
      `Signed in to Azure (subscription: ${acct.name}).`
    );
  }
}

async function selectSubscriptionCommand(): Promise<void> {
  if (!(await ensureLoggedIn())) {
    return;
  }
  const subs = await withProgress('Loading subscriptions…', listSubscriptions);
  if (subs.length === 0) {
    vscode.window.showWarningMessage('No Azure subscriptions found.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    subs.map((s) => ({
      label: s.name,
      description: s.isDefault ? '(current)' : '',
      detail: s.id,
      sub: s,
    })),
    { placeHolder: 'Select the active Azure subscription' }
  );
  if (!pick) {
    return;
  }
  await setSubscription(pick.sub.id);
  tree.refresh();
  vscode.window.showInformationMessage(`Active subscription: ${pick.sub.name}`);
}

/** Palette command: pick a VM, then connect. */
async function connectPickCommand(currentWindow: boolean): Promise<void> {
  if (!(await ensureLoggedIn())) {
    return;
  }
  const vm = await pickVm();
  if (vm) {
    await connectToVm(vm, currentWindow);
  }
}

/** Tree command: connect to the selected tree item's VM. */
async function connectItemCommand(
  item: VmTreeItem | undefined,
  currentWindow: boolean
): Promise<void> {
  if (!item?.vm) {
    return connectPickCommand(currentWindow);
  }
  if (!(await ensureLoggedIn())) {
    return;
  }
  await connectToVm(item.vm, currentWindow);
}

/** Tree command: start or stop the selected VM. */
async function powerCommand(
  item: VmTreeItem | undefined,
  action: 'start' | 'stop'
): Promise<void> {
  if (!item?.vm || !(await ensureLoggedIn())) {
    return;
  }
  const { resourceGroup, name } = item.vm;
  const verb = action === 'start' ? 'Starting' : 'Stopping';
  try {
    await withProgress(`${verb} ${name}…`, () =>
      action === 'start' ? startVm(resourceGroup, name) : deallocateVm(resourceGroup, name)
    );
    tree.refresh();
    vscode.window.showInformationMessage(
      `${name} ${action === 'start' ? 'started' : 'stopped'}.`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to ${action} ${name}: ${errMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Ensure the VM is running, prepare SSH access, and open a Remote-SSH window. */
async function connectToVm(vm: AzVm, currentWindow: boolean): Promise<void> {
  if (!(await ensureVmRunning(vm))) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('azureVmSsh');
  if (cfg.get<boolean>('autoAddLocalIp')) {
    // Best-effort: opening SSH from the current IP shouldn't block a connect
    // attempt (the rule may already exist, or the user may lack permission).
    try {
      await withProgress('Allowing SSH from your IP…', () => ensureLocalIpAllowed(vm));
    } catch (err) {
      vscode.window.showWarningMessage(
        `Could not add your IP to ${vm.name}'s network security group: ${errMessage(err)}`
      );
    }
  }

  let alias: string;
  try {
    alias = await withProgress(
      `Preparing SSH access to ${vm.name}…`,
      () => prepareVm(vm)
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to prepare SSH config for ${vm.name}: ${errMessage(err)}`
    );
    return;
  }

  await openRemote(alias, currentWindow);
}

/**
 * Make sure the VM is running before connecting. If it is stopped/deallocated,
 * offer to start it (and wait for the start to complete).
 */
async function ensureVmRunning(vm: AzVm): Promise<boolean> {
  // Fast path: if the tree's cached state already says running, trust it and
  // skip the extra `vm get-instance-view` round trip (the user just saw it as
  // running). Only pay for a live check when the cached state looks stopped.
  if (isRunning(vm.powerState)) {
    return true;
  }
  let state = vm.powerState;
  try {
    state = (await getPowerState(vm.resourceGroup, vm.name)) ?? state;
  } catch {
    /* fall back to the cached list state */
  }
  if (isRunning(state)) {
    return true;
  }

  const choice = await vscode.window.showInformationMessage(
    `${vm.name} is ${state ? state.replace(/^VM\s+/, '') : 'not running'}. Start it before connecting?`,
    { modal: true },
    'Start and connect'
  );
  if (choice !== 'Start and connect') {
    return false;
  }

  try {
    await withProgress(`Starting ${vm.name}…`, () =>
      startVm(vm.resourceGroup, vm.name)
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to start ${vm.name}: ${errMessage(err)}`);
    return false;
  }
  tree.refresh();
  return true;
}

/**
 * Generate (or refresh) the SSH config + short-lived certificate for a VM and
 * return the Host alias that Remote-SSH should connect to.
 */
async function prepareVm(vm: AzVm): Promise<string> {
  const dir = configDirFor(vm);
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config');

  const cfg = vscode.workspace.getConfiguration('azureVmSsh');
  const privateKey = (cfg.get<string>('privateKeyFile') || '').trim();
  const localUser = (cfg.get<string>('localUser') || '').trim();

  // Reuse a recently generated config/certificate to avoid the slow
  // `az ssh config` round trip (and Entra token exchange) on quick reconnects.
  const reuseMinutes = cfg.get<number>('reuseSshConfigMinutes') ?? 50;
  if (reuseMinutes > 0 && canReuseConfig(dir, configFile, vm, !privateKey, reuseMinutes)) {
    ensureInclude(configFile);
    const cached = firstHostAlias(configFile);
    if (cached) {
      return cached;
    }
  }

  // az prompts before overwriting an existing key pair. These files are
  // ephemeral (regenerated every connect), so remove any leftovers first to
  // keep `az ssh config` fully non-interactive.
  for (const f of ['id_rsa', 'id_rsa.pub', 'id_rsa.pub-aadcert.pub']) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* ignore */
    }
  }

  const args = [
    'ssh',
    'config',
    '--resource-group',
    vm.resourceGroup,
    '--name',
    vm.name,
    '--file',
    configFile,
    '--keys-destination-folder',
    dir,
    '--overwrite',
  ];

  if (privateKey) {
    args.push('--private-key-file', expandHome(privateKey));
    if (localUser) {
      args.push('--local-user', localUser);
    }
  }

  await runAz(args);

  ensureInclude(configFile);

  const alias = firstHostAlias(configFile);
  if (!alias) {
    throw new Error('Could not determine the SSH host alias from the generated config.');
  }
  return alias;
}

/**
 * Whether the previously generated SSH config in `dir` is still safe to reuse:
 * it must be recent enough, its Entra certificate (when applicable) must still
 * be present, and its target address must still match the VM's current public
 * IP (guards against a dynamic IP changing after a stop/start).
 */
function canReuseConfig(
  dir: string,
  configFile: string,
  vm: AzVm,
  needsCert: boolean,
  reuseMinutes: number
): boolean {
  try {
    if (!fs.existsSync(configFile)) {
      return false;
    }
    const ageMs = Date.now() - fs.statSync(configFile).mtimeMs;
    if (ageMs >= reuseMinutes * 60_000) {
      return false;
    }
    if (needsCert && !fs.existsSync(path.join(dir, 'id_rsa.pub-aadcert.pub'))) {
      return false;
    }
    // If we know the VM's public IPs, make sure the cached config still points
    // at one of them. Skip the check when no public IP is reported.
    if (vm.publicIps) {
      const host = firstHostName(configFile);
      const ips = vm.publicIps.split(/[,\s]+/).filter(Boolean);
      if (host && ips.length > 0 && !ips.includes(host)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Add (or move) an inbound NSG rule that allows SSH from the caller's current
 * public IP. No-op when the IP hasn't changed since the last successful add
 * for this VM, keeping repeat connects fast.
 */
async function ensureLocalIpAllowed(vm: AzVm): Promise<void> {
  const ip = await getLocalPublicIp();
  const stateKey = `allowedIp:${vm.resourceGroup}/${vm.name}`;
  if (extContext.globalState.get<string>(stateKey) === ip) {
    return;
  }
  const nsg = await getVmNsg(vm.resourceGroup, vm.name);
  if (!nsg) {
    throw new Error('no network security group is attached to this VM or its subnet');
  }
  await upsertSshRule(nsg, ip);
  await extContext.globalState.update(stateKey, ip);
}

/** Palette/tree command: allow SSH from the current public IP for a VM. */
async function addMyIpCommand(item: VmTreeItem | undefined): Promise<void> {
  if (!(await ensureLoggedIn())) {
    return;
  }
  const vm = item?.vm ?? (await pickVm());
  if (!vm) {
    return;
  }
  try {
    const ip = await withProgress('Detecting your public IP…', getLocalPublicIp);
    const nsg = await withProgress(`Finding ${vm.name}'s security group…`, () =>
      getVmNsg(vm.resourceGroup, vm.name)
    );
    if (!nsg) {
      vscode.window.showWarningMessage(
        `No network security group is attached to ${vm.name} or its subnet; nothing to update.`
      );
      return;
    }
    const result = await withProgress(`Allowing SSH from ${ip}…`, () =>
      upsertSshRule(nsg, ip)
    );
    await extContext.globalState.update(`allowedIp:${vm.resourceGroup}/${vm.name}`, ip);
    vscode.window.showInformationMessage(
      `${result.created ? 'Added' : 'Updated'} SSH allow rule on "${result.nsg}" for ${ip} ` +
        `(priority ${result.priority}).`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to allow your IP for ${vm.name}: ${errMessage(err)}`);
  }
}

/** Open a Remote-SSH window for the given host alias. */
async function openRemote(alias: string, currentWindow: boolean): Promise<void> {
  const command = currentWindow
    ? 'opensshremotes.openEmptyWindowInCurrentWindow'
    : 'opensshremotes.openEmptyWindow';
  try {
    await vscode.commands.executeCommand(command, { host: alias });
  } catch (err) {
    // Fall back to the remote URI scheme if the Remote-SSH command is missing.
    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${alias}/`);
    const opened = await vscode.commands.executeCommand(
      'vscode.openFolder',
      uri,
      { forceNewWindow: !currentWindow }
    );
    if (!opened) {
      vscode.window.showErrorMessage(
        `Could not open a Remote-SSH window for "${alias}": ${errMessage(err)}. ` +
          'Make sure the Remote - SSH extension is installed.'
      );
    }
  }
}

async function pickVm(): Promise<AzVm | undefined> {
  const vms = await withProgress('Loading Azure VMs…', listVms);
  if (vms.length === 0) {
    vscode.window.showWarningMessage(
      'No VMs found in the current subscription. Use "Azure VM SSH: Select Azure Subscription" to switch.'
    );
    return undefined;
  }
  const sorted = [...vms].sort((a, b) => a.name.localeCompare(b.name));
  const pick = await vscode.window.showQuickPick(
    sorted.map((vm) => ({
      label: vm.name,
      description: vm.resourceGroup,
      detail: [
        vm.powerState ? `● ${vm.powerState}` : undefined,
        vm.publicIps ? `public ${vm.publicIps}` : undefined,
        vm.privateIps ? `private ${vm.privateIps}` : undefined,
        vm.location,
      ]
        .filter(Boolean)
        .join('   '),
      vm,
    })),
    {
      placeHolder: 'Select an Azure VM to connect to',
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  return pick?.vm;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base directory for generated per-VM SSH config + certificates. */
function configDirFor(vm: AzVm): string {
  const cfg = vscode.workspace.getConfiguration('azureVmSsh');
  const base = (cfg.get<string>('sshConfigDir') || '').trim();
  const root = base ? expandHome(base) : path.join(os.homedir(), '.ssh', 'az-ssh');
  return path.join(root, `${vm.resourceGroup}-${vm.name}`);
}

function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

async function ensureAz(): Promise<boolean> {
  if (await isAzInstalled()) {
    return true;
  }
  const choice = await vscode.window.showErrorMessage(
    'The Azure CLI (`az`) was not found on your PATH. It is required to connect to Azure VMs.',
    'Install instructions'
  );
  if (choice) {
    vscode.env.openExternal(
      vscode.Uri.parse('https://learn.microsoft.com/cli/azure/install-azure-cli')
    );
  }
  return false;
}

async function ensureLoggedIn(): Promise<boolean> {
  if (!(await ensureAz())) {
    return false;
  }
  if (await currentAccount()) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    'You are not signed in to Azure.',
    'Sign in'
  );
  if (choice !== 'Sign in') {
    return false;
  }
  await withProgress('Signing in to Azure…', async () => {
    await azLogin();
  });
  const ok = (await currentAccount()) !== undefined;
  if (ok) {
    tree.refresh();
  }
  return ok;
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () => task()
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
