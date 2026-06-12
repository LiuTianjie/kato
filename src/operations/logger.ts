export interface OperationLogger {
  log(message: string): void;
  setItemStatus?(itemId: number, label: string): void;
  throwIfCancelled?(): void;
}

export const silentLogger: OperationLogger = {
  log() {
    // Intentionally empty for CLI/tests that do not need progress output.
  }
};
