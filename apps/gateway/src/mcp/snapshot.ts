export type SnapshotTool = {
  upstreamId: string;
  originalName: string;
  slug: string;
  exposedName: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
};

/**
 * In-memory map of enabled exposed tool names → routing metadata.
 * Swapped atomically after discover / CRUD so readers never see a torn map.
 */
export class RuntimeSnapshot {
  #tools: ReadonlyMap<string, SnapshotTool> = new Map();

  get size(): number {
    return this.#tools.size;
  }

  get(exposedName: string): SnapshotTool | undefined {
    return this.#tools.get(exposedName);
  }

  list(): SnapshotTool[] {
    return [...this.#tools.values()];
  }

  /** Atomically replace the entire tool map. */
  swap(tools: Iterable<SnapshotTool>): void {
    const next = new Map<string, SnapshotTool>();
    for (const tool of tools) {
      next.set(tool.exposedName, tool);
    }
    this.#tools = next;
  }
}

export const runtimeSnapshot = new RuntimeSnapshot();
