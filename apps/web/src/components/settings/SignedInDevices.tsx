import { useCallback, useEffect, useState } from "react";
import {
  trustedDeviceSessionDays,
  type SignedInDevice,
  type SignedInDevicesResponse,
} from "@suite/contracts";
import {
  listSignedInDevices,
  renameSignedInDevice,
  signOutDevice,
  signOutOtherDevices,
} from "../../api.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";

/**
 * Trusted devices (ADR 0048): every device that chose "Keep me signed in",
 * with rename, sign out per device and sign out of all other devices. A
 * device that was signed out because an old sign-in token was presented
 * again is reported for 30 days.
 */

const dateTime = (value: string): string =>
  new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });

const addressFamilyLabel = (
  family: SignedInDevice["lastAddressFamily"],
): string =>
  family === "ipv4" ? "IPv4" : family === "ipv6" ? "IPv6" : "unknown network";

export interface SignedInDevicesViewProps {
  readonly state: SignedInDevicesResponse | null;
  readonly busy: boolean;
  readonly online: boolean;
  readonly error: string | null;
  readonly renaming: { readonly id: string; readonly label: string } | null;
  readonly onStartRename: (device: SignedInDevice) => void;
  readonly onRenameInput: (label: string) => void;
  readonly onSaveRename: () => void;
  readonly onCancelRename: () => void;
  readonly onSignOut: (device: SignedInDevice) => void;
  readonly onSignOutOthers: () => void;
}

export const SignedInDevicesView = ({
  state,
  busy,
  online,
  error,
  renaming,
  onStartRename,
  onRenameInput,
  onSaveRename,
  onCancelRename,
  onSignOut,
  onSignOutOthers,
}: SignedInDevicesViewProps) => {
  const disabled = busy || !online;
  return (
    <Card aria-labelledby="signed-in-devices-title">
      <CardHeader>
        <SectionHeading
          as="h3"
          id="signed-in-devices-title"
          title="Signed-in devices"
        />
      </CardHeader>
      <CardContent className="grid gap-3">
        <p>
          Devices where you chose to stay signed in. Each is signed out after{" "}
          {String(trustedDeviceSessionDays)} days without use. A browser where
          you did not choose this is signed out after 30 idle minutes and is not
          listed.
        </p>
        {state?.securityEvents.map((event) => (
          <Alert key={event.deviceId} variant="warning">
            <AlertTitle>{event.label} was signed out</AlertTitle>
            <AlertDescription>
              On {dateTime(event.occurredAt)} a sign-in token that had already
              been replaced was used again. That happens when a copy of the
              device&apos;s sign-in is used somewhere else. If you did not
              expect this, sign out all other devices and check your connections
              and assistant access.
            </AlertDescription>
          </Alert>
        ))}
        {error !== null && (
          <p className="message message-error" role="alert">
            {error}
          </p>
        )}
        {state === null ? (
          <p className="hint">Loading devices…</p>
        ) : state.devices.length === 0 ? (
          <p className="hint">No device is kept signed in.</p>
        ) : (
          <ul className="grid gap-3">
            {state.devices.map((device) => (
              <li
                key={device.id}
                className="grid gap-2 rounded-md border border-line p-3"
              >
                {renaming?.id === device.id ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onSaveRename();
                    }}
                  >
                    <Input
                      aria-label="Device name"
                      value={renaming.label}
                      maxLength={100}
                      required
                      onChange={(event) => onRenameInput(event.target.value)}
                    />
                    <Button type="submit" disabled={disabled}>
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={onCancelRename}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{device.label}</strong>
                    {device.current && <Badge>This device</Badge>}
                  </div>
                )}
                <p className="hint">
                  Signed in {dateTime(device.createdAt)}. Last active{" "}
                  {dateTime(device.lastSeenAt)} over{" "}
                  {addressFamilyLabel(device.lastAddressFamily)}. Stays signed
                  in until {dateTime(device.expiresAt)} unless used before then.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => onStartRename(device)}
                  >
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => onSignOut(device)}
                  >
                    Sign out
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={disabled || state === null}
          onClick={onSignOutOthers}
        >
          Sign out all other devices
        </Button>
        <p className="hint">
          Signing out other devices also ends browser sessions that are not
          listed. A device loses access on its next request.
        </p>
      </CardContent>
    </Card>
  );
};

export const SignedInDevices = ({
  csrfToken,
  online,
  onSignOutThisDevice,
}: {
  readonly csrfToken: string;
  readonly online: boolean;
  /** Signing out the current device is the ordinary sign-out. */
  readonly onSignOutThisDevice: () => Promise<void>;
}) => {
  const [state, setState] = useState<SignedInDevicesResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] =
    useState<SignedInDevicesViewProps["renaming"]>(null);

  const reload = useCallback(async (): Promise<void> => {
    setState(await listSignedInDevices());
  }, []);
  useEffect(() => {
    if (!online) return;
    void reload().catch((failure: unknown) => {
      setError(
        failure instanceof Error ? failure.message : "Devices did not load.",
      );
    });
  }, [online, reload]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (failure: unknown) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The device change did not complete.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SignedInDevicesView
      state={state}
      busy={busy}
      online={online}
      error={error}
      renaming={renaming}
      onStartRename={(device) =>
        setRenaming({ id: device.id, label: device.label })
      }
      onRenameInput={(label) =>
        setRenaming((current) =>
          current === null ? current : { ...current, label },
        )
      }
      onCancelRename={() => setRenaming(null)}
      onSaveRename={() => {
        if (renaming === null) return;
        void run(async () => {
          await renameSignedInDevice(renaming.id, renaming.label, csrfToken);
          setRenaming(null);
        });
      }}
      onSignOut={(device) =>
        void (device.current
          ? onSignOutThisDevice()
          : run(() => signOutDevice(device.id, csrfToken)))
      }
      onSignOutOthers={() =>
        void run(async () => {
          await signOutOtherDevices(csrfToken);
        })
      }
    />
  );
};
