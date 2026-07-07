import { registerAs } from "@nestjs/config";
import { Field, ObjectType } from "@nestjs/graphql";
import { Exclude, Expose } from "class-transformer";
import { IsBoolean, IsString } from "class-validator";

/**
 * Mirrors the shell `incus.cfg` so the daemon-side init and the API agree on
 * one policy. The persister reads/writes this; the array-start script also
 * reads incus.cfg. (v1: incus.cfg is canonical for lifecycle; this exposes the
 * same knobs over GraphQL for the UI. Reconciliation writer is a follow-up.)
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
  devContainerBridge!: string;

  @Expose()
  @Field(() => String, { description: "CIDRs the dev container may NOT reach (comma-separated)" })
  @IsString()
  aclBlock!: string;

  @Expose()
  @Field(() => String, { description: "Default image for new dev containers" })
  @IsString()
  devContainerImage!: string;

  @Expose()
  @Field(() => String, { description: "Profile applied to new dev containers" })
  @IsString()
  devContainerProfile!: string;

  @Expose()
  @Field(() => String, { description: "Host dir holding per-dev-container workspaces" })
  @IsString()
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
