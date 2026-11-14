import type {
  ChildState,
  NativeChildToolExecutor,
  ParentOwner,
} from "./native-subagent-monitor-types.js";

export function releaseNativeChildTools(child: {
  childTools?: NativeChildToolExecutor;
  childToolsOwner?: ParentOwner;
}): void {
  const tools = child.childTools;
  child.childTools = undefined;
  child.childToolsOwner = undefined;
  tools?.dispose();
}

export function transferNativeChildTools(
  source: Pick<ChildState, "childTools" | "childToolsOwner" | "nativeToolOutcome">,
  target: Pick<ChildState, "childTools" | "childToolsOwner" | "nativeToolOutcome">,
): void {
  if (!source.childTools) {
    return;
  }
  releaseNativeChildTools(target);
  target.childTools = source.childTools;
  target.childToolsOwner = source.childToolsOwner;
  source.childTools = undefined;
  source.childToolsOwner = undefined;
  target.nativeToolOutcome ??= source.nativeToolOutcome;
  if (target.nativeToolOutcome) {
    try {
      target.childTools.observeToolOutcome(target.nativeToolOutcome);
    } catch {
      // A revoked outcome observer cannot keep an executable grant alive.
      releaseNativeChildTools(target);
    }
  }
}
