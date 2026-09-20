import { useEffect, useState } from "react";
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        onClick={() => setOpen(true)}
        aria-label="Open command bar"
      >
        <CommandIcon aria-hidden="true" />
        Command
        <CommandShortcut>⌘K</CommandShortcut>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
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
