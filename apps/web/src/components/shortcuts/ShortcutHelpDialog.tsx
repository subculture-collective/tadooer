import {
  resolveShortcutBindings,
  type ShortcutOverrides,
} from "@suite/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import { formatBinding, shortcutGroups } from "../../shortcuts.ts";

interface ShortcutHelpDialogProps {
  readonly open: boolean;
  readonly overrides: ShortcutOverrides;
  readonly onOpenChange: (open: boolean) => void;
}

/** Lists every action with its effective binding (ADR 0030). Opens with `?`. */
export const ShortcutHelpDialog = ({
  open,
  overrides,
  onOpenChange,
}: ShortcutHelpDialogProps) => {
  const effective = resolveShortcutBindings(overrides);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="shortcut-help-description">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription id="shortcut-help-description">
            Shortcuts without a modifier are ignored while typing in a field.
            Change bindings under Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="shortcut-help grid gap-3">
          {shortcutGroups().map(({ group, actions }) => (
            <section key={group} aria-label={group}>
              <h4>{group}</h4>
              <dl className="shortcut-list">
                {actions.map((action) => (
                  <div key={action.id}>
                    <dt>{action.label}</dt>
                    <dd>
                      <kbd>
                        {formatBinding(effective.get(action.id) ?? null)}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
