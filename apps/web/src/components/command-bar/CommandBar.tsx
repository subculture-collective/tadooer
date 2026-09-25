import { useEffect, useRef, useState } from "react";
import { CommandIcon } from "lucide-react";
import { workspaceRoutes, routeLabel, type WorkspaceRoute } from "@/app/routes";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { useApplicationPreferences } from "@/application-preferences";
import { formatBinding, shortcutActionFor } from "@/shortcuts";

interface CommandBarProps {
  readonly onNavigate: (route: WorkspaceRoute) => void;
  readonly onSyncNow: () => void;
  readonly syncAvailable: boolean;
  readonly onShowShortcuts?: (() => void) | undefined;
}

export const CommandBar = ({
  onNavigate,
  onSyncNow,
  syncAvailable,
  onShowShortcuts,
}: CommandBarProps) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // ADR 0030: the binding is owner-editable; Ctrl+K by default.
  const overrides = useApplicationPreferences().snapshot.preferences.shortcuts;
  const binding = Object.hasOwn(overrides, "command_bar.open")
    ? (overrides["command_bar.open"] ?? null)
    : "Ctrl+K";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (shortcutActionFor(event, overrides) === "command_bar.open") {
        event.preventDefault();
        if (!open) {
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, overrides]);

  const navigate = (route: WorkspaceRoute): void => {
    onNavigate(route);
    setOpen(false);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        ref={triggerRef}
        onClick={() => {
          returnFocusRef.current = triggerRef.current;
          setOpen(true);
        }}
        aria-label="Open command bar"
      >
        <CommandIcon aria-hidden="true" />
        Command
        {binding !== null && (
          <CommandShortcut>{formatBinding(binding)}</CommandShortcut>
        )}
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const previous = returnFocusRef.current;
          (previous?.isConnected && previous !== document.body
            ? previous
            : triggerRef.current
          )?.focus();
        }}
      >
        <CommandInput placeholder="Search commands" />
        <CommandList>
          <CommandEmpty>No matching command.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {workspaceRoutes.map((route) => (
              <CommandItem
                key={route}
                value={`navigate ${route}`}
                onSelect={() => navigate(route)}
              >
                {routeLabel(route)}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Actions">
            <CommandItem
              value="sync now"
              disabled={!syncAvailable}
              onSelect={() => {
                onSyncNow();
                setOpen(false);
              }}
            >
              Sync now
            </CommandItem>
            {onShowShortcuts !== undefined && (
              <CommandItem
                value="keyboard shortcuts"
                onSelect={() => {
                  onShowShortcuts();
                  setOpen(false);
                }}
              >
                Keyboard shortcuts
              </CommandItem>
            )}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
};
