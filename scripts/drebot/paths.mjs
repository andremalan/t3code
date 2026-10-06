import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const STATE = NodePath.resolve(
  process.env.DREBOT_STATE || NodePath.join(NodeOS.homedir(), "tmp", "cc"),
);
export const CONFIG = NodePath.join(STATE, "config");
