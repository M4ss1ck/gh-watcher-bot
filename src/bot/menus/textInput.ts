// Tracks short-lived ad-hoc text input prompts for menus.
export type TextInputKind = "username" | "timezone" | "repos";

export type TextInputKey = {
  chatId: number;
  userId: number;
};

export type TextInputValue = {
  waitingFor: TextInputKind;
};

type Entry = TextInputValue & {
  expiresAt: number;
};

export class TextInputTtlMap {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number) {}

  set(key: TextInputKey, value: TextInputValue, nowMs = Date.now()): void {
    this.entries.set(this.key(key), {
      ...value,
      expiresAt: nowMs + this.ttlMs
    });
  }

  take(key: TextInputKey, nowMs = Date.now()): TextInputValue | null {
    const entryKey = this.key(key);
    const entry = this.entries.get(entryKey);

    if (entry === undefined) {
      return null;
    }

    this.entries.delete(entryKey);

    if (entry.expiresAt <= nowMs) {
      return null;
    }

    return {
      waitingFor: entry.waitingFor
    };
  }

  private key(key: TextInputKey): string {
    return `${key.chatId}:${key.userId}`;
  }
}

export const textInputs = new TextInputTtlMap(60_000);
