# incus-unraid — LAN-Banned Agent Dev Containers for Unraid

Run coding agents and stdio MCP servers inside Incus system-container "dev
containers" on Unraid. Each dev container gets a dedicated NAT bridge that is
**firewalled off from your LAN** (egress deny-list) while keeping **Internet
access** — so an agent, or a compromised dependency in its toolchain, can't
reach your NAS, routers, or internal services.

Modeled on the pattern from [weisser-zwerg.dev's Incus Codex Jail](https://weisser-zwerg.dev/posts/incus-codex-jail/), adapted for Unraid's plugin system and RAM-booted Slackware environment.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                     Unraid Host                      │
│                                                      │
│  incus.plg ─── installs ──→ /usr/local/incus/        │
│       │                     (binaries + bundled libs) │
│       │                                              │
│       ├── rc.incus ─────→ start/stop incusd          │
│       │                                              │
│       ├── incus-init.sh ─→ storage pool              │
│       │                    agent-block-lan ACL        │
│       │                    agentbr0 bridge            │
│       │                    devcontainer profile       │
│       │                                              │
│  IncusSettings.page ──→ "Incus" navbar tab           │
│  IncusDashboard.page ──→ Main/Dashboard box          │
│       └── include/IncusHelpers.php ──→ Incus REST API│
│                             (unix socket, no CLI)    │
│                                                      │
│  unraid-api-plugin-incus                             │
│       └── NestJS module ──→ Incus REST API           │
│                             (unix socket, no CLI)    │
│                                                      │
│  ┌─── agentbr0 (198.18.0.0/24) ───┐                │
│  │  agent1   agent2   agent3  ...  │                │
│  │  ✓ Internet  ✗ LAN  ✗ NAS      │                │
│  └─────────────────────────────────┘                │
└──────────────────────────────────────────────────────┘
```

## The Four Pieces

1. **`incus.plg` + `source/`** — Classic Unraid plugin. Lays down the
   repackaged Incus runtime (`packages/*.txz`), the daemon lifecycle
   (`rc.incus`), and array up/down hooks. Does the OS-level work the API plugin
   can't: ship the daemon, run it, persist its state.

2. **`incus-init.sh` (config-driven preseed)** — On every array start, reads
   `incus.cfg` and idempotently ensures: the ZFS/dir storage pool, the
   `agent-block-lan` ACL, the `agentbr0` bridge, and the `devcontainer` profile.
   Re-running is safe (check-then-create). **All policy lives in `incus.cfg`** —
   nothing is hardcoded.

3. **Classic webGUI (`IncusSettings.page` + `IncusDashboard.page`)** — A
   top-level **"Incus"** navbar tab (dev container list, start/stop/restart/delete,
   config form) plus an optional dev-container-status box on Main/Dashboard.
   Both talk to the Incus REST API over its unix socket directly
   (`include/IncusHelpers.php`), so they work with or without the newer API
   plugin installed. Each is independently toggleable via `WEBGUI_ENABLE` /
   `DASHBOARD_WIDGET_ENABLE` in `incus.cfg` (or the checkboxes on the Incus tab
   itself).

4. **`unraid-api-plugin-incus/`** — NestJS/GraphQL plugin for Unraid's new API
   system. Manages dev containers at runtime (launch/list/stop/delete, repoint
   workspace) by speaking the **Incus REST API over its unix socket** — no CLI
   scraping.

## Configuration (`/boot/config/plugins/incus/incus.cfg`)

Single source of truth for the shell init, the classic webGUI, and the API
plugin. Key defaults:

| Key | Default | Notes |
|---|---|---|
| `SERVICE` | `disabled` | Set to `enabled` to autostart on array start |
| `STORAGE_DRIVER` / `STORAGE_SOURCE` | `zfs` / `nvme/incus` | Dedicated ZFS dataset; created if missing |
| `DEVCONTAINER_BRIDGE` / `DEVCONTAINER_SUBNET` | `agentbr0` / `198.18.0.1/24` | RFC 2544 range, won't collide with home LAN |
| `ACL_BLOCK` | `10/8,172.16/12,192.168/16,169.254/16` | LAN ban. **Tailscale `100.64/10` NOT blocked** |
| `ACL_ALLOW` | *(empty)* | Allow-holes punched before the block list |
| `DEVCONTAINER_IMAGE` | `images:debian/trixie/cloud` | Must be a `/cloud` variant for cloud-init |
| `DEVCONTAINER_NESTING` | `false` | `true` = nested docker/incus inside the dev container |
| `DEVCONTAINER_CPU` / `DEVCONTAINER_MEMORY` | `2` / `4GiB` | Empty = no cap |
| `WEBGUI_ENABLE` | `true` | Show the top-level "Incus" navbar tab |
| `DASHBOARD_WIDGET_ENABLE` | `true` | Show the dev-container-status box on Main/Dashboard |

> Upgrading from a pre-rename install? `incus.plg` auto-migrates any existing
> `JAIL_*` keys in your `incus.cfg` to the `DEVCONTAINER_*` names above,
> preserving your values.

## Install

1. Place `packages/incus-unraid-7.0.0-5-x86_64-1.txz` at the `gitURL` location.
2. Install the `.plg` (Community Apps or direct plugin URL).
3. Edit `/boot/config/plugins/incus/incus.cfg`: set `SERVICE=enabled`, adjust
   `STORAGE_SOURCE` to your actual ZFS pool/dataset.
4. Start the array (or manually: `/etc/rc.d/rc.incus start && /usr/local/emhttp/plugins/incus/scripts/incus-init.sh`).
5. Preflight gates the daemon — check `/var/log/incusd.log` if it refuses.
6. Once the array is up, an **"Incus"** tab appears in the Unraid navbar with
   the dev container list, config form, and start/stop/restart/delete actions.

## Launch a Dev Container

```bash
# CLI (uses the private-prefixed incus binary)
/usr/local/incus/bin/incus launch images:debian/trixie/cloud agent1 \
  --profile default --profile devcontainer

# Verify the LAN ban
incus exec agent1 -- nc -vz -w2 1.1.1.1 443        # ✓ Internet
incus exec agent1 -- nc -vz -w2 192.168.1.1 22     # ✗ BLOCKED
```

Or from the **Incus** navbar tab, or via GraphQL once the API plugin is loaded:
```graphql
mutation { launchDevContainer(name: "agent1") }
```

## Safety Model

- **No system-lib pollution** — Incus runs from `/usr/local/incus/` with a
  scoped `LD_LIBRARY_PATH`; nothing else on the box sees its libraries.
- **Preflight gate** — Won't start if the host can't run it; changes nothing on failure.
- **RAM-boot escape hatch** — Reboot restores a pristine OS; only `INCUS_DIR`
  (on the array) persists.
- **Dev container egress is deny-listed** via Incus network ACLs (nftables under the hood).

## Repository Structure

```
incus-unraid/
├── incus.plg                         # Unraid plugin manifest (XML)
├── packages/
│   └── incus-unraid-*.txz            # Repackaged Incus binaries
├── source/usr/local/emhttp/plugins/incus/
│   ├── scripts/
│   │   ├── rc.incus                  # Daemon lifecycle
│   │   ├── incus-env.sh              # LD_LIBRARY_PATH scoping
│   │   ├── incus-preflight.sh        # Host capability check
│   │   └── incus-init.sh             # Config-driven preseed
│   ├── event/
│   │   ├── disks_mounted             # Array-start hook
│   │   └── unmounting_disks          # Array-stop hook
│   ├── templates/
│   │   └── dev-container-profile.yaml.tmpl
│   ├── include/
│   │   ├── IncusHelpers.php          # cfg + Incus REST API client (shared)
│   │   ├── DashboardTile.php         # dev-container-status tile fragment (shared)
│   │   ├── UpdateSettings.php        # settings form POST handler
│   │   └── DevContainerAction.php    # AJAX start/stop/restart/delete
│   ├── IncusSettings.page             # Menu="Incus" — top-level navbar tab
│   ├── IncusDashboard.page             # Menu="Dashboard" — dev-container-status box
│   └── incus.cfg                     # Default config
└── unraid-api-plugin-incus/          # NestJS/GraphQL API plugin
    ├── index.ts                      # Plugin entry point
    ├── src/
    │   ├── incus.service.ts           # Incus REST API client
    │   ├── incus.resolver.ts          # GraphQL resolvers
    │   └── config.entity.ts           # Config entity
    ├── package.json
    └── tsconfig.json
```

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with the LinuxContainers/Incus project or Unraid.
