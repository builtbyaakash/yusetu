export type SecretPair = {
  key: string;
  value: string;
  /** True when the key already exists server-side (value is never loaded). */
  stored?: boolean;
};

type SecretFieldsProps = {
  secrets: SecretPair[];
  onChange: (next: SecretPair[]) => void;
  hint?: string;
};

export function SecretFields({ secrets, onChange, hint }: SecretFieldsProps) {
  function update(index: number, patch: Partial<SecretPair>) {
    onChange(
      secrets.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function remove(index: number) {
    onChange(secrets.filter((_, i) => i !== index));
  }

  return (
    <div className="field secret-fields">
      <label>Secrets</label>
      {hint ? <span className="hint">{hint}</span> : null}
      <div className="secret-rows">
        {secrets.map((row, index) => (
          <div
            className={`secret-row${row.stored ? " secret-row-stored" : ""}`}
            key={row.stored ? `stored:${row.key}` : `new:${index}`}
          >
            <input
              className="input mono"
              placeholder="KEY"
              value={row.key}
              onChange={(e) => update(index, { key: e.target.value })}
              readOnly={row.stored}
              aria-label={row.stored ? `Secret key ${row.key}` : "Secret key"}
              autoComplete="off"
              spellCheck={false}
            />
            <input
              className="input"
              placeholder={
                row.stored
                  ? "Leave blank to keep current value"
                  : "value"
              }
              type="password"
              value={row.value}
              onChange={(e) => update(index, { value: e.target.value })}
              aria-label={
                row.stored
                  ? `New value for ${row.key}`
                  : "Secret value"
              }
              autoComplete="new-password"
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm secret-row-remove"
              onClick={() => remove(index)}
              aria-label={
                row.stored
                  ? `Remove secret ${row.key}`
                  : "Remove secret row"
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm secret-add"
        onClick={() => onChange([...secrets, { key: "", value: "" }])}
      >
        Add secret
      </button>
    </div>
  );
}

export function secretsToRecord(
  secrets: SecretPair[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of secrets) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keys present on the server that are no longer in the form rows. */
export function secretsToRemove(
  initialKeys: string[] | undefined,
  secrets: SecretPair[],
): string[] | undefined {
  if (!initialKeys?.length) return undefined;
  const present = new Set(
    secrets.map((row) => row.key.trim()).filter(Boolean),
  );
  const removed = initialKeys.filter((key) => !present.has(key));
  return removed.length > 0 ? removed : undefined;
}
