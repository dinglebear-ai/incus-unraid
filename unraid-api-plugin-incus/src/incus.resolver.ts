import { Resolver, Query, Mutation, Args, registerEnumType } from "@nestjs/graphql";
import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { IncusService } from "./incus.service.js";
import { DevContainer } from "./config.entity.js";

enum DevContainerAction {
  start = "start",
  stop = "stop",
  restart = "restart",
  freeze = "freeze",
  unfreeze = "unfreeze",
}
registerEnumType(DevContainerAction, { name: "DevContainerAction", description: "Dev container lifecycle actions" });

@Resolver()
export class IncusResolver {
  constructor(
    private readonly incus: IncusService,
    private readonly config: ConfigService,
  ) {}

  @Query(() => Boolean, { description: "Is incusd reachable over its unix socket?" })
  async incusHealthy(): Promise<boolean> {
    return this.incus.ping();
  }

  @Query(() => [DevContainer], { description: "List all agent dev containers" })
  async devContainers(): Promise<DevContainer[]> {
    return this.incus.listDevContainers();
  }

  @Mutation(() => Boolean, { description: "Launch a new LAN-banned agent dev container" })
  async launchDevContainer(
    @Args("name") name: string,
    @Args("image", { nullable: true }) image?: string
  ): Promise<boolean> {
    await this.incus.launchDevContainer(name, { image });
    return true;
  }

  @Mutation(() => Boolean)
  async setDevContainerState(
    @Args("name") name: string,
    @Args("action", { type: () => DevContainerAction }) action: DevContainerAction
  ): Promise<boolean> {
    await this.incus.setDevContainerState(name, action);
    return true;
  }

  @Mutation(() => Boolean, { description: "Repoint a dev container's /workspace to a host dir" })
  async setDevContainerWorkspace(
    @Args("name") name: string,
    @Args("hostPath") hostPath: string
  ): Promise<boolean> {
    // H5 fix: validate hostPath is under the configured workspace root.
    // Both sides are resolved (collapses `..`/`.`/repeated slashes) and compared
    // by path boundary, not raw string prefix — a bare startsWith() would let
    // `/srv/agent-devcontainers-evil` or a `..`-laden path slip through.
    const wsRoot = this.config.get<string>("incus.devContainerWorkspaceRoot", "/srv/agent-devcontainers");
    const normalizedRoot = resolvePath(wsRoot);
    const normalizedHostPath = resolvePath(hostPath);
    if (normalizedHostPath !== normalizedRoot && !normalizedHostPath.startsWith(normalizedRoot + pathSep)) {
      throw new ForbiddenException(`hostPath must be under the workspace root (${wsRoot})`);
    }
    await this.incus.setDevContainerWorkspace(name, normalizedHostPath);
    return true;
  }

  @Mutation(() => Boolean)
  async deleteDevContainer(@Args("name") name: string): Promise<boolean> {
    await this.incus.deleteDevContainer(name);
    return true;
  }
}
