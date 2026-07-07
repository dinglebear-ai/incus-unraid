import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync, renameSync, watch, FSWatcher } from "node:fs";
import { join } from "node:path";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { IncusConfig } from "./config.entity.js";

const CFG_LOCK_STALE_MS = 15_000;
const CFG_LOCK_RETRY_MS = 250;
const CFG_LOCK_MAX_RETRIES = 5;

@Injectable()
export class IncusConfigSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IncusConfigSyncService.name);
  private cfgWatcher?: FSWatcher;
  private jsonWatcher?: FSWatcher;
  private isSyncing = false;

  // Primary paths on Unraid, with fallbacks for development/testing
  private readonly cfgPath = existsSync("/boot/config/plugins/incus/incus.cfg")
    ? "/boot/config/plugins/incus/incus.cfg"
    : join(process.cwd(), "incus.cfg");

  private readonly jsonPath = existsSync("/boot/config/plugins/incus/incus.json")
    ? "/boot/config/plugins/incus/incus.json"
    : join(process.cwd(), "incus.json");

  private readonly cfgLockPath = `${this.cfgPath}.lock`;

  onModuleInit() {
    this.logger.log(`Initializing config sync (cfg: ${this.cfgPath}, json: ${this.jsonPath})`);
    
    // 1. Perform initial sync (shell incus.cfg is the ultimate system source of truth)
    this.syncCfgToJSON();

    // 2. Start watching both files
    this.setupWatchers();
  }

  onModuleDestroy() {
    this.cfgWatcher?.close();
    this.jsonWatcher?.close();
  }

  /**
   * Reads incus.cfg, parses it, and updates incus.json if values differ.
   */
  private syncCfgToJSON() {
    if (this.isSyncing) return;
    if (!existsSync(this.cfgPath)) {
      this.logger.warn(`incus.cfg not found at ${this.cfgPath}, skipping initial sync`);
      return;
    }

    try {
      this.isSyncing = true;
      const cfgContent = readFileSync(this.cfgPath, "utf-8");
      const parsedCfg = this.parseShellConfig(cfgContent);
      const mappedConfig = this.mapShellToTS(parsedCfg);

      let currentJson: Partial<IncusConfig> = {};
      if (existsSync(this.jsonPath)) {
        try {
          currentJson = JSON.parse(readFileSync(this.jsonPath, "utf-8"));
        } catch {
          this.logger.warn(`Failed to parse existing incus.json, overwriting`);
        }
      }

      // Check if sync is actually needed to avoid redundant writes
      if (this.isConfigDifferent(currentJson, mappedConfig)) {
        this.logger.log(`Syncing changes from incus.cfg to incus.json`);
        const newJson = { ...currentJson, ...mappedConfig };
        this.writeFileAtomic(this.jsonPath, JSON.stringify(newJson, null, 2));
      }
    } catch (err) {
      this.logger.error(`Error syncing incus.cfg to incus.json: ${(err as Error).message}`);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Reads incus.json, and updates incus.cfg line-by-line while preserving comments and other settings.
   */
  private syncJSONToCfg(retriesLeft = CFG_LOCK_MAX_RETRIES) {
    if (this.isSyncing) return;
    if (!existsSync(this.jsonPath)) return;

    // incus.cfg is also written by the PHP webGUI (UpdateSettings.php) and
    // the .plg installer's migration step (bash). This lock is shared with
    // both — see acquireCfgLockNonBlocking() below for why it can't block.
    // A bounded retry (rather than giving up after one attempt) matters here:
    // unlike syncCfgToJSON (which just re-reads the same source of truth on
    // the next fs event), the JSON change we're trying to sync right now has
    // already happened — if we give up permanently and nothing touches
    // incus.json again, that change would silently never reach incus.cfg.
    const lockToken = this.acquireCfgLockNonBlocking();
    if (!lockToken) {
      if (retriesLeft > 0) {
        this.logger.debug(
          `incus.cfg is locked by another writer; retrying in ${CFG_LOCK_RETRY_MS}ms (${retriesLeft} attempts left)`
        );
        setTimeout(() => this.syncJSONToCfg(retriesLeft - 1), CFG_LOCK_RETRY_MS);
      } else {
        this.logger.warn(`incus.cfg stayed locked after repeated retries; giving up on this sync cycle`);
      }
      return;
    }

    try {
      this.isSyncing = true;
      const jsonContent = readFileSync(this.jsonPath, "utf-8");
      let parsedJson: Partial<IncusConfig> = JSON.parse(jsonContent);

      if (!existsSync(this.cfgPath)) {
        this.logger.warn(`incus.cfg not found at ${this.cfgPath}, cannot sync from JSON`);
        return;
      }

      parsedJson = this.rejectInvalidFields(parsedJson);

      const cfgContent = readFileSync(this.cfgPath, "utf-8");
      const parsedCfg = this.parseShellConfig(cfgContent);
      const mappedConfig = this.mapShellToTS(parsedCfg);

      // Check if sync is actually needed to avoid redundant writes
      if (this.isConfigDifferent(mappedConfig, parsedJson)) {
        this.logger.log(`Syncing changes from incus.json to incus.cfg`);
        const updatedCfgContent = this.updateShellConfig(cfgContent, parsedJson);
        this.writeFileAtomic(this.cfgPath, updatedCfgContent);
      }
    } catch (err) {
      this.logger.error(`Error syncing incus.json to incus.cfg: ${(err as Error).message}`);
    } finally {
      this.isSyncing = false;
      this.releaseCfgLock(lockToken);
    }
  }

  /**
   * Whitelist-validate free-text fields before they can reach incus.cfg from
   * this direction — mirrors incus_validate_cfg_field()'s role in
   * UpdateSettings.php. Without this, incus.json (writable by anything that
   * calls the future config-persistence/mutation path this class's own
   * class-level doc comment calls out as a follow-up) could carry an
   * unvalidated value straight into a file incus-init.sh sources as root.
   * Invalid fields are dropped (logged), not just silently written.
   */
  private rejectInvalidFields(config: Partial<IncusConfig>): Partial<IncusConfig> {
    const instance = plainToInstance(IncusConfig, config);
    const errors = validateSync(instance, { skipMissingProperties: true });
    if (errors.length === 0) return config;

    const result = { ...config };
    const badKeys = errors.map((e) => e.property as keyof IncusConfig);
    this.logger.warn(`Rejecting invalid incus.json field(s) before writing to incus.cfg: ${badKeys.join(", ")}`);
    for (const key of badKeys) {
      delete result[key];
    }
    return result;
  }

  /**
   * Single-attempt, non-blocking acquire of the same sentinel-lockfile mutex
   * used by the PHP webGUI (UpdateSettings.php, via incus_cfg_lock_acquire())
   * and the .plg installer's migration step (bash) — atomic exclusive create,
   * a stale timeout so a crashed holder can't wedge things forever. Unlike
   * those two this runs inside a live NestJS event loop, so it must never
   * block: one try, then give up immediately. The debounced file watcher
   * will simply retry on the next change event if this attempt loses the race.
   */
  private acquireCfgLockNonBlocking(): string | null {
    const token = `${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      writeFileSync(this.cfgLockPath, token, { flag: "wx" });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        const age = Date.now() - statSync(this.cfgLockPath).mtimeMs;
        if (age > CFG_LOCK_STALE_MS) {
          unlinkSync(this.cfgLockPath); // holder likely crashed; steal it
          writeFileSync(this.cfgLockPath, token, { flag: "wx" });
          return token;
        }
      } catch (stealErr) {
        // Usually benign (lock vanished, or a competitor grabbed it between our
        // stat and unlink) — but also the only place an unexpected filesystem
        // error (EACCES/EROFS on /boot) would surface, so log it rather than
        // swallowing silently; both cases fall through to "give up this round".
        this.logger.debug(`incus.cfg lock steal attempt failed: ${(stealErr as Error).message}`);
      }
      return null;
    }
  }

  private releaseCfgLock(token: string | null): void {
    if (!token) return;
    try {
      if (readFileSync(this.cfgLockPath, "utf-8") === token) {
        unlinkSync(this.cfgLockPath);
      }
    } catch (err) {
      // Usually just "already gone" (fine, release is best-effort) — logged at
      // debug rather than swallowed so an unexpected permissions error isn't
      // indistinguishable from the benign case.
      this.logger.debug(`incus.cfg lock release no-op: ${(err as Error).message}`);
    }
  }

  /** Write-to-temp-then-rename so a concurrent reader never sees a torn file. */
  private writeFileAtomic(path: string, content: string): void {
    const tmpPath = `${path}.tmp-${process.pid}`;
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, path);
  }

  /**
   * Set up watches on both files to propagate live edits.
   */
  private setupWatchers() {
    try {
      if (existsSync(this.cfgPath)) {
        this.cfgWatcher = watch(this.cfgPath, (event) => {
          if (event === "change") {
            // Debounce slightly to allow writes to finish
            setTimeout(() => this.syncCfgToJSON(), 100);
          }
        });
      }

      if (existsSync(this.jsonPath)) {
        this.jsonWatcher = watch(this.jsonPath, (event) => {
          if (event === "change") {
            // Debounce slightly to allow writes to finish
            setTimeout(() => this.syncJSONToCfg(), 100);
          }
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to set up config file watchers: ${(err as Error).message}`);
    }
  }

  /**
   * Helper to check if two configuration subsets differ.
   */
  private isConfigDifferent(a: Partial<IncusConfig>, b: Partial<IncusConfig>): boolean {
    const keys: Array<keyof IncusConfig> = [
      "enabled",
      "stateDir",
      "devContainerBridge",
      "aclBlock",
      "devContainerImage",
      "devContainerProfile",
      "devContainerWorkspaceRoot",
      "webguiEnable",
      "dashboardWidgetEnable",
    ];
    for (const key of keys) {
      if (a[key] !== b[key] && b[key] !== undefined) {
        return true;
      }
    }
    return false;
  }

  /**
   * Parse simple shell config (KEY="VALUE") into record.
   */
  private parseShellConfig(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        // Remove trailing comment if any (e.g. KEY="VAL" # comment)
        const hashIdx = val.indexOf("#");
        if (hashIdx >= 0) {
          val = val.substring(0, hashIdx).trim();
        }
        // Remove surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        result[key] = val;
      }
    }
    return result;
  }

  /**
   * Map parsed shell keys to the TypeScript IncusConfig entity properties.
   */
  private mapShellToTS(shell: Record<string, string>): Partial<IncusConfig> {
    const config: Partial<IncusConfig> = {};
    if (shell.SERVICE !== undefined) {
      config.enabled = shell.SERVICE === "enabled";
    }
    if (shell.INCUS_DIR !== undefined) {
      config.stateDir = shell.INCUS_DIR;
    }
    if (shell.DEVCONTAINER_BRIDGE !== undefined) {
      config.devContainerBridge = shell.DEVCONTAINER_BRIDGE;
    }
    if (shell.ACL_BLOCK !== undefined) {
      config.aclBlock = shell.ACL_BLOCK;
    }
    if (shell.DEVCONTAINER_IMAGE !== undefined) {
      config.devContainerImage = shell.DEVCONTAINER_IMAGE;
    }
    if (shell.DEVCONTAINER_PROFILE !== undefined) {
      config.devContainerProfile = shell.DEVCONTAINER_PROFILE;
    }
    if (shell.DEVCONTAINER_WORKSPACE_ROOT !== undefined) {
      config.devContainerWorkspaceRoot = shell.DEVCONTAINER_WORKSPACE_ROOT;
    }
    if (shell.WEBGUI_ENABLE !== undefined) {
      config.webguiEnable = shell.WEBGUI_ENABLE.toLowerCase() === "true";
    }
    if (shell.DASHBOARD_WIDGET_ENABLE !== undefined) {
      config.dashboardWidgetEnable = shell.DASHBOARD_WIDGET_ENABLE.toLowerCase() === "true";
    }
    return config;
  }

  /**
   * Updates matching shell variables in shell config file line-by-line to preserve comments.
   */
  private updateShellConfig(content: string, updates: Partial<IncusConfig>): string {
    const lines = content.split(/\r?\n/);
    const keyMap: Record<keyof IncusConfig, string> = {
      enabled: "SERVICE",
      stateDir: "INCUS_DIR",
      devContainerBridge: "DEVCONTAINER_BRIDGE",
      aclBlock: "ACL_BLOCK",
      devContainerImage: "DEVCONTAINER_IMAGE",
      devContainerProfile: "DEVCONTAINER_PROFILE",
      devContainerWorkspaceRoot: "DEVCONTAINER_WORKSPACE_ROOT",
      webguiEnable: "WEBGUI_ENABLE",
      dashboardWidgetEnable: "DASHBOARD_WIDGET_ENABLE",
    };

    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        // Check if we have an update mapping for this shell variable key
        const tsKey = Object.keys(keyMap).find(
          (k) => keyMap[k as keyof IncusConfig] === key
        ) as keyof IncusConfig | undefined;

        if (tsKey && updates[tsKey] !== undefined) {
          const val = updates[tsKey];
          let strVal = "";
          if (tsKey === "enabled") {
            strVal = val ? "enabled" : "disabled";
          } else {
            strVal = String(val);
          }

          const originalRightHand = trimmed.substring(eqIdx + 1).trim();
          // Retain comments if they were on the same line
          const hashIdx = originalRightHand.indexOf("#");
          const comment = hashIdx >= 0 ? originalRightHand.substring(hashIdx) : "";

          // Preserve quotes if original had them
          if (originalRightHand.startsWith("'")) {
            return `${key}='${strVal}'${comment ? " " + comment : ""}`;
          } else {
            return `${key}="${strVal}"${comment ? " " + comment : ""}`;
          }
        }
      }
      return line;
    });

    return newLines.join("\n");
  }
}
