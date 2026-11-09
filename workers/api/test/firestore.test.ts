import { describe, expect, it } from "vitest";
import { decodeFields, encodeFields } from "../src/firestore";

describe("codec de campos do Firestore REST", () => {
  it("ida e volta preserva strings, booleanos e números", () => {
    const data = { a: "texto", b: true, c: 42, d: 1.5 };
    expect(decodeFields(encodeFields(data))).toEqual(data);
  });

  it("decodifica timestamp e valores nulos", () => {
    expect(decodeFields({ t: { timestampValue: "2026-01-01T00:00:00Z" }, n: { nullValue: null } })).toEqual({
      t: "2026-01-01T00:00:00Z",
      n: null,
    });
  });

  it("campos ausentes viram objeto vazio", () => {
    expect(decodeFields(undefined)).toEqual({});
  });
});
