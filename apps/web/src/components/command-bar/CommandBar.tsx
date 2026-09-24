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

interface CommandBarProps {
  readonly onNavigate: (route: WorkspaceRoute) => void;
  readonly onSyncNow: () => void;
  readonly syncAvailable: boolean;
}

export const CommandBar = ({
  onNavigate,
  onSyncNow,
  syncAvailable,
}: CommandBarProps) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
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
  }, [open]);

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
        <CommandShortcut>⌘K</CommandShortcut>
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
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
};
