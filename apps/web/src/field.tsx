export const Field = ({
  label,
  name,
  type = "text",
  autoComplete,
  minLength,
  defaultValue,
  required = true,
}: {
  readonly label: string;
  readonly name: string;
  readonly type?: "text" | "password";
  readonly autoComplete: string;
  readonly minLength?: number;
  readonly defaultValue?: string;
  readonly required?: boolean;
}) => (
  <label className="field">
    <span>{label}</span>
    <input
      name={name}
      type={type}
      autoComplete={autoComplete}
      minLength={minLength}
      defaultValue={defaultValue}
      required={required}
    />
  </label>
);
