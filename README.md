# Azure VM SSH (az ssh)

A VS Code extension that connects to **Azure Virtual Machines** over SSH using
the Azure CLI's [`az ssh`](https://learn.microsoft.com/azure/virtual-machines/ssh-keys-azure-cli)
command and opens them with **Remote - SSH**, so you can edit and run code on the
remote VM directly from your IDE.

## How it works

1. You pick a subscription and a VM from a Quick Pick list (`az vm list`).
2. The extension runs `az ssh config` to generate a per-VM SSH config file plus a
   short-lived **Microsoft Entra** SSH certificate.
3. It adds an `Include` line to your `~/.ssh/config` pointing at the generated file.
4. It asks the **Remote - SSH** extension to open a window connected to that host.

Because the certificate is regenerated (with `--overwrite`) every time you
connect, you always start with a fresh, valid credential.

## Requirements

- [**Azure CLI**](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`)
  on your `PATH`, with the `ssh` extension (`az extension add --name ssh`).
- The [**Remote - SSH**](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)
  extension (installed automatically as a dependency).
- For Microsoft Entra login: the target VM must have the **AAD login** extension
  installed and you need the *Virtual Machine Administrator/User Login* role.

## Commands

| Command | Description |
| --- | --- |
| **Azure VM SSH: Connect to VM (new window)** | Pick a VM and open it in a new Remote-SSH window. |
| **Azure VM SSH: Connect to VM (current window)** | Same, but reuse the current window. |
| **Azure VM SSH: Sign in to Azure (az login)** | Run `az login`. |
| **Azure VM SSH: Select Azure Subscription** | Switch the active subscription. |

## Settings

| Setting | Description |
| --- | --- |
| `azureVmSsh.sshConfigDir` | Where per-VM config + certs are written (default `~/.ssh/az-ssh`). |
| `azureVmSsh.privateKeyFile` | Private key path for **local-user** VMs (not Entra). |
| `azureVmSsh.localUser` | Local user name to use with `privateKeyFile`. |

## Develop / run locally

```powershell
npm install
npm run compile
```

Then press <kbd>F5</kbd> ("Run Extension") to launch an Extension Development Host,
and run one of the commands from the Command Palette.

## Packaging

```powershell
npm install -g @vscode/vsce
vsce package
```

This produces an installable `.vsix`.

## License

MIT
