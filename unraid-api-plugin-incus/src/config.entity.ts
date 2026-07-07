import { registerAs } from "@nestjs/config";
import { Field, ObjectType } from "@nestjs/graphql";
import { Exclude, Expose } from "class-transformer";
import { IsBoolean, IsString, Matches } from "class-validator";

/**
 * Mirrors the shell `incus.cfg` so the daemon-side init and the API agree on
 * one policy. The persister reads/writes this; the array-start script also
 * reads incus.cfg. (v1: incus.cfg is canonical for lifecycle; this exposes the
 * same knobs over GraphQL for the UI. Reconciliation writer is a follow-up.)
 *
 * The @Matches() patterns on the free-text fields below mirror
 * incus_cfg_field_pattern() in IncusHelpers.php — both exist because
 * incus.cfg gets `. "$CFG"`-sourced as bash by incus-init.sh on every array
 * start, so an unvalidated value is a root shell-injection vector. Keep
 * these two whitelists in sync: a pattern added to one side without the
 * other reopens that risk on whichever side was skipped. These decorators
 * are only enforced where something actually calls validateSync()/
 * validateOrReject() against an instance — see config-sync.service.ts's
 * syncJSONToCfg(), which is the one path that can write attacker-influenced
 * free text into incus.cfg from this runtime.
 */
@Exclude()
@ObjectType()
export class IncusConfig {
  @Expose()
  @Field(() => Boolean, { description: "Autostart incusd on array start" })
  @IsBoolean()
  enabled!: boolean;

  @Expose()
  @Field(() => String, { description: "Persistent daemon state dir (on the array)" })
  @IsString()
  stateDir!: string;

  @Expose()
  @Field(() => String, { description: "Dev container bridge name" })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,15}$/, { message: "devContainerBridge must be a valid Linux interface name" })
  devContainerBridge!: string;

  @Expose()
  @Field(() => String, { description: "CIDRs the dev container may NOT reach (comma-separated)" })
  @IsString()
  @Matches(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}(,\d{1,3}(\.\d{1,3}){3}\/\d{1,2})*$/, {
    message: "aclBlock must be a comma-separated list of IPv4 CIDRs",
  })
  aclBlock!: string;

  @Expose()
  @Field(() => String, { description: "Default image for new dev containers" })
  @IsString()
  @Matches(/^[A-Za-z0-9:/_.-]{1,255}$/, { message: "devContainerImage must be a shell-safe image reference" })
  devContainerImage!: string;

  @Expose()
  @Field(() => String, { description: "Profile applied to new dev containers" })
  @IsString()
  @Matches(/^[A-Za-z0-9:/_.-]{1,255}$/, { message: "devContainerProfile must be a shell-safe profile name" })
  devContainerProfile!: string;

  @Expose()
  @Field(() => String, { description: "Host dir holding per-dev-container workspaces" })
  @IsString()
  @Matches(/^\/[A-Za-z0-9_./-]*$/, { message: "devContainerWorkspaceRoot must be an absolute path" })
  devContainerWorkspaceRoot!: string;

  @Expose()
  @Field(() => Boolean, { description: "Show the top-level \"Incus\" navbar tab" })
  @IsBoolean()
  webguiEnable!: boolean;

  @Expose()
  @Field(() => Boolean, { description: "Show the dev-container-status box on Main/Dashboard" })
  @IsBoolean()
  dashboardWidgetEnable!: boolean;
}

export const configFeature = registerAs<IncusConfig>("incus", () => ({
  enabled: false,
  stateDir: "/mnt/user/appdata/incus",
  devContainerBridge: "agentbr0",
  aclBlock: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16",
  devContainerImage: "images:debian/trixie/cloud",
  devContainerProfile: "devcontainer",
  devContainerWorkspaceRoot: "/srv/agent-devcontainers",
  webguiEnable: true,
  dashboardWidgetEnable: true,
}));

@ObjectType()
export class DevContainer {
  @Field(() => String) name!: string;
  @Field(() => String) status!: string;
  @Field(() => String, { nullable: true }) ipv4?: string;
}
