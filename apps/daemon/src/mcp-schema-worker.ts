import Ajv2020 from "ajv/dist/2020";

type Request =
  | { id: number; kind: "compile"; schemas: Record<string, unknown>[] }
  | { id: number; kind: "validate"; schema: Record<string, unknown>; value: unknown };

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    if (event.data.kind === "compile") {
      for (const schema of event.data.schemas) new Ajv2020({ allErrors: false, strict: true }).compile(schema);
      self.postMessage({ id: event.data.id, valid: true });
      return;
    }
    const validate = new Ajv2020({ allErrors: false, strict: true }).compile(event.data.schema);
    const valid = validate(event.data.value);
    const errors = valid ? "" : (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join(", ");
    self.postMessage({ errors, id: event.data.id, valid });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error), id: event.data.id, valid: false });
  }
};

self.postMessage({ kind: "ready" });
