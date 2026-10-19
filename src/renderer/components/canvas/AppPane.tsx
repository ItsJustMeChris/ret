import { memo } from "react";
import { appInstance } from "../../state/ui";
import { appOf } from "../../apps";

type PaneProps = {
  id: string;
  focused: boolean;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onHeaderDoubleClick: () => void;
  windowControls: React.ReactNode;
};

/**
 * One of Ret's apps (src/renderer/apps) as a window on the canvas desktop: a title bar, and the app's
 * view under it, as it is in its mode.
 */
export const AppPane = memo(function AppPane({ id, focused, onHeaderPointerDown, onHeaderDoubleClick, windowControls }: PaneProps) {
  const app = appOf(id);
  const instance = appInstance(id);
  // A window is one app for its whole life, so the app's hooks run the same way every render.
  const title = app.useTitle ? app.useTitle(instance) : app.name;
  const cwd = app.useCwd?.(instance);
  const { icon: Icon, Badge, Chips, Actions, View } = app;
  return (
    <div className={`thread-pane app-pane app-${app.kind} chrome-window ${focused ? "focused" : ""}`} data-cwd={cwd ?? undefined}>
      <div
        className="pane-header draggable"
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          onHeaderDoubleClick();
        }}
      >
        <Icon size={14} className="app-icon" />
        <div className="pane-title">{title}</div>
        {Badge && <Badge />}
        {Chips && <Chips instance={instance} />}
        <div className="pane-header-actions" onPointerDown={(e) => e.stopPropagation()}>
          {Actions && <Actions instance={instance} />}
          {windowControls}
        </div>
      </div>
      <div className="app-win-body">
        <View instance={instance} active={focused} />
      </div>
    </div>
  );
});

type TileProps = { id: string; onPointerDown: (e: React.PointerEvent) => void; onDoubleClick: () => void };

/** Zoomed out: what the app is up to, at a glance. */
export function AppTile({ id, onPointerDown, onDoubleClick }: TileProps) {
  const app = appOf(id);
  const instance = appInstance(id);
  const title = app.useTitle ? app.useTitle(instance) : app.name;
  const { icon: Icon, Card } = app;
  return (
    <div className="tcard app-tile" onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <div className="tcard-head">
        <Icon className="tcard-fork" />
        <span className="tcard-title">{title}</span>
      </div>
      <Card instance={instance} />
    </div>
  );
}
