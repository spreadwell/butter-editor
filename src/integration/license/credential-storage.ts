import type { CredentialMigrationDirective } from "./session-contract";

export const CREDENTIAL_STATE_SECRET_ID = "butter-editor-credential-state-v1";
export const LICENSE_KEY_SECRET_ID = "butter-editor-license-key-v1";
export const SESSION_TOKEN_SECRET_ID = "butter-editor-session-token-v1";

export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export interface CredentialSettings {
  licenseKey: string;
  sessionToken: string;
  credentialStorageRetired: boolean;
}

export interface CredentialStorageCapability {
  mode: "secret-v1";
  installationId: string;
}

interface CredentialState {
  schema: 1;
  installationId: string;
  bootstrapConsumed: boolean;
  serverReportPending: boolean;
  legacyRetired: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseState(raw: string | null): CredentialState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.schema !== 1
      || typeof value.installationId !== "string"
      || !UUID_PATTERN.test(value.installationId)
      || typeof value.bootstrapConsumed !== "boolean"
      || typeof value.serverReportPending !== "boolean"
      || typeof value.legacyRetired !== "boolean"
    ) return null;
    return {
      schema: 1,
      installationId: value.installationId.toLowerCase(),
      bootstrapConsumed: value.bootstrapConsumed,
      serverReportPending: value.serverReportPending,
      legacyRetired: value.legacyRetired,
    };
  } catch {
    return null;
  }
}

function newState(): CredentialState {
  return {
    schema: 1,
    installationId: crypto.randomUUID(),
    bootstrapConsumed: false,
    serverReportPending: false,
    legacyRetired: false,
  };
}

/**
 * Owns the local half of the credential migration. It never changes the
 * licensing device ID: installationId only proves that this Obsidian
 * installation has a working, non-synced SecretStorage.
 */
export class LicenseCredentialStorage {
  private state: CredentialState | null = null;
  private usable = false;

  constructor(private readonly storage: SecretStorageLike | null) {}

  initialize(settings: CredentialSettings): { settingsChanged: boolean } {
    if (!this.storage) return { settingsChanged: false };
    try {
      const state = parseState(this.storage.getSecret(CREDENTIAL_STATE_SECRET_ID)) ?? newState();
      let localKey = this.storage.getSecret(LICENSE_KEY_SECRET_ID) ?? "";
      let localToken = this.storage.getSecret(SESSION_TOKEN_SECRET_ID) ?? "";

      if (!state.bootstrapConsumed && (localKey || settings.licenseKey)) {
        localKey = localKey || settings.licenseKey;
        localToken = localToken || settings.sessionToken;
        this.writeAndVerify(LICENSE_KEY_SECRET_ID, localKey);
        this.writeAndVerify(SESSION_TOKEN_SECRET_ID, localToken);
        state.bootstrapConsumed = true;
        state.serverReportPending = true;
      }

      if (settings.credentialStorageRetired) state.legacyRetired = true;
      this.writeState(state);
      this.state = state;
      this.usable = true;

      let settingsChanged = false;
      if (state.bootstrapConsumed) {
        if (settings.licenseKey !== localKey) {
          settings.licenseKey = localKey;
          settingsChanged = true;
        }
        if (settings.sessionToken !== localToken) {
          settings.sessionToken = localToken;
          settingsChanged = true;
        }
      }
      if (state.legacyRetired && !settings.credentialStorageRetired) {
        settings.credentialStorageRetired = true;
        settingsChanged = true;
      }
      return { settingsChanged };
    } catch (error) {
      this.usable = false;
      console.error("[Butter] SecretStorage initialization failed; retaining legacy credential storage.", error);
      return { settingsChanged: false };
    }
  }

  capability(): CredentialStorageCapability | undefined {
    return this.usable && this.state
      ? { mode: "secret-v1", installationId: this.state.installationId }
      : undefined;
  }

  get needsServerReport(): boolean {
    return Boolean(this.usable && this.state?.serverReportPending);
  }

  persistCredentials(settings: CredentialSettings): boolean {
    if (!this.storage || !this.usable || !this.state) return false;
    try {
      this.writeAndVerify(LICENSE_KEY_SECRET_ID, settings.licenseKey);
      this.writeAndVerify(SESSION_TOKEN_SECRET_ID, settings.sessionToken);
      if (settings.licenseKey && !this.state.bootstrapConsumed) {
        this.state.bootstrapConsumed = true;
        this.state.serverReportPending = true;
      }
      if (settings.credentialStorageRetired) this.state.legacyRetired = true;
      if (this.state.legacyRetired) settings.credentialStorageRetired = true;
      this.writeState(this.state);
      return true;
    } catch (error) {
      this.usable = false;
      console.error("[Butter] SecretStorage write failed; retaining legacy credential storage.", error);
      return false;
    }
  }

  applyServerDirective(directive: CredentialMigrationDirective | undefined): boolean {
    if (!directive || !this.storage || !this.usable || !this.state) return false;
    const next: CredentialState = {
      ...this.state,
      serverReportPending: false,
      legacyRetired: this.state.legacyRetired || directive.retireLegacyCredentials,
    };
    try {
      this.writeState(next);
      this.state = next;
      return next.legacyRetired;
    } catch (error) {
      this.usable = false;
      console.error("[Butter] SecretStorage migration state write failed; plaintext was not retired.", error);
      return false;
    }
  }

  settingsForPersistence<T extends CredentialSettings>(settings: T): Omit<T, "licenseKey" | "sessionToken"> & Partial<Pick<T, "licenseKey" | "sessionToken">> {
    const persisted = { ...settings };
    if (settings.credentialStorageRetired || this.state?.legacyRetired) {
      persisted.credentialStorageRetired = true;
      delete (persisted as Partial<CredentialSettings>).licenseKey;
      delete (persisted as Partial<CredentialSettings>).sessionToken;
    }
    return persisted;
  }

  private writeAndVerify(id: string, value: string): void {
    if (!this.storage) throw new Error("SecretStorage unavailable");
    this.storage.setSecret(id, value);
    if ((this.storage.getSecret(id) ?? "") !== value) {
      throw new Error(`SecretStorage verification failed for ${id}`);
    }
  }

  private writeState(state: CredentialState): void {
    const serialized = JSON.stringify(state);
    this.writeAndVerify(CREDENTIAL_STATE_SECRET_ID, serialized);
  }
}
