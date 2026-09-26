import { useEffect, useState } from "react";
import type { CapturePreferencesResponse } from "@suite/contracts";
import { getCapturePreferences, updateCapturePreferences } from "../../api.ts";
import { NativeSelect, NativeSelectOption } from "../ui/native-select.tsx";

const labels = {
  keep: "Keep the address in the title",
  extract: "Move the address into a link attachment",
  keep_and_attach: "Keep the address and attach it as a link",
} as const;

/**
 * ADR 0031: the owner's URL behavior for captured titles, saved with a
 * revision. Loaded lazily; a stale save reports the conflict and reloads.
 */
export const CaptureLinkPreference = ({
  csrfToken,
}: {
  readonly csrfToken: string;
}) => {
  const [state, setState] = useState<CapturePreferencesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getCapturePreferences()
      .then((loaded) => {
        if (active) setState(loaded);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load capture settings",
          );
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (urlBehavior: keyof typeof labels): Promise<void> => {
    if (state === null) return;
    setError(null);
    try {
      setState(
        await updateCapturePreferences(
          { urlBehavior },
          state.revision,
          csrfToken,
        ),
      );
    } catch (caught: unknown) {
      setError(
        caught instanceof Error ? caught.message : "Could not save the setting",
      );
      setState(await getCapturePreferences().catch(() => state));
    }
  };

  return (
    <label className="field capture-link-preference">
      <span>Web addresses in titles</span>
      <NativeSelect
        name="urlBehavior"
        value={state?.preferences.urlBehavior ?? "keep_and_attach"}
        disabled={state === null}
        onChange={(event) =>
          void save(event.target.value as keyof typeof labels)
        }
      >
        {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => (
          <NativeSelectOption key={key} value={key}>
            {labels[key]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error === null ? null : (
        <small role="alert" className="form-error">
          {error}
        </small>
      )}
    </label>
  );
};
