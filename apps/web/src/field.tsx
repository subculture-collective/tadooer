import { useId } from "react";
import { Field as FieldRoot, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
}) => {
  const id = useId();
  return (
    <FieldRoot className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        minLength={minLength}
        defaultValue={defaultValue}
        required={required}
      />
    </FieldRoot>
  );
};
