import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

/**
 * Repository-file mode is opt-in per project on this device. Projects stay
 * private until the user turns it on, and the first switch asks once.
 */
const STORAGE_KEY = "t3code:skills-shared-mode:v1";
const SharedModeSchema = Schema.Struct({
  shared: Schema.Array(Schema.String),
  confirmed: Schema.Array(Schema.String),
});

export interface SharedModeState {
  readonly shared: ReadonlySet<string>;
  readonly confirmed: ReadonlySet<string>;
}

export function sharedModeKey(environmentId: EnvironmentId, projectPath: string): string {
  return JSON.stringify([environmentId, projectPath]);
}

export function readSharedModeState(): SharedModeState {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, SharedModeSchema);
    return { shared: new Set(stored?.shared), confirmed: new Set(stored?.confirmed) };
  } catch {
    return { shared: new Set(), confirmed: new Set() };
  }
}

/** Records the choice for one project and returns the new state. */
export function saveSharedMode(
  state: SharedModeState,
  key: string,
  shared: boolean,
): SharedModeState {
  const next: SharedModeState = {
    shared: shared
      ? new Set([...state.shared, key])
      : new Set([...state.shared].filter((entry) => entry !== key)),
    confirmed: shared ? new Set([...state.confirmed, key]) : state.confirmed,
  };
  try {
    setLocalStorageItem(
      STORAGE_KEY,
      { shared: [...next.shared], confirmed: [...next.confirmed] },
      SharedModeSchema,
    );
  } catch (error) {
    console.error("Could not save the Skills project mode.", error);
  }
  return next;
}
