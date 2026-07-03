import * as vscode from 'vscode';
import { AzVm, currentAccount, isRunning, listVms } from './azcli';

/** A node in the Azure VM tree: either a resource group or a VM. */
export class VmTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: 'group' | 'vm' | 'message',
    public readonly vm?: AzVm
  ) {
    super(label, collapsibleState);
  }
}

export class VmTreeProvider implements vscode.TreeDataProvider<VmTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<VmTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private vms: AzVm[] | undefined;
  private error: string | undefined;

  refresh(): void {
    this.vms = undefined;
    this.error = undefined;
    this._onDidChange.fire();
  }

  getTreeItem(element: VmTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VmTreeItem): Promise<VmTreeItem[]> {
    if (!element) {
      return this.getRootGroups();
    }
    if (element.kind === 'group') {
      return this.getVmsForGroup(element.label as string);
    }
    return [];
  }

  private async getRootGroups(): Promise<VmTreeItem[]> {
    if (!(await currentAccount())) {
      const item = new VmTreeItem(
        'Not signed in — run "Azure VM SSH: Sign in to Azure"',
        vscode.TreeItemCollapsibleState.None,
        'message'
      );
      item.iconPath = new vscode.ThemeIcon('account');
      return [item];
    }

    if (this.vms === undefined) {
      try {
        this.vms = await listVms();
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.vms = [];
      }
    }

    if (this.error) {
      const item = new VmTreeItem(
        `Failed to load VMs: ${this.error}`,
        vscode.TreeItemCollapsibleState.None,
        'message'
      );
      item.iconPath = new vscode.ThemeIcon('error');
      return [item];
    }

    if (this.vms.length === 0) {
      const item = new VmTreeItem(
        'No VMs in this subscription',
        vscode.TreeItemCollapsibleState.None,
        'message'
      );
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    const groups = [...new Set(this.vms.map((v) => v.resourceGroup))].sort((a, b) =>
      a.localeCompare(b)
    );
    return groups.map((g) => {
      const item = new VmTreeItem(g, vscode.TreeItemCollapsibleState.Expanded, 'group');
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'group';
      return item;
    });
  }

  private getVmsForGroup(group: string): VmTreeItem[] {
    const vms = (this.vms || [])
      .filter((v) => v.resourceGroup === group)
      .sort((a, b) => a.name.localeCompare(b.name));

    return vms.map((vm) => {
      const running = isRunning(vm.powerState);
      const item = new VmTreeItem(
        vm.name,
        vscode.TreeItemCollapsibleState.None,
        'vm',
        vm
      );
      item.description = vm.powerState?.replace(/^VM\s+/, '') ?? '';
      item.tooltip = [
        `VM: ${vm.name}`,
        `Resource group: ${vm.resourceGroup}`,
        `Location: ${vm.location}`,
        vm.powerState ? `State: ${vm.powerState}` : undefined,
        vm.publicIps ? `Public IP: ${vm.publicIps}` : undefined,
        vm.privateIps ? `Private IP: ${vm.privateIps}` : undefined,
      ]
        .filter(Boolean)
        .join('\n');
      item.iconPath = running
        ? new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('vm-outline', new vscode.ThemeColor('disabledForeground'));
      // contextValue drives which inline/context actions appear (see package.json).
      item.contextValue = running ? 'vm-running' : 'vm-stopped';
      // Double-click / Enter connects.
      item.command = {
        command: 'azureVmSsh.connectVm',
        title: 'Connect',
        arguments: [item],
      };
      return item;
    });
  }
}
