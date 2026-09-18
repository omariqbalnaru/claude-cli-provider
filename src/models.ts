/**
 * Typed view of the shared catalog and config renderers.
 *
 * The data and the rendering live in plain .mjs (shim/models.mjs,
 * shim/render.mjs) so the shim CLI and this TypeScript module use the same
 * code. This file only adds types for the extension/mod consumers.
 */

import { MODELS as RAW_MODELS, PROVIDER_ID as ID, PROVIDER_NAME as NAME, DEFAULT_PORT as PORT } from "../shim/models.mjs";
import { EFFORTS_BY_MODEL, render as renderImpl } from "../shim/render.mjs";

export interface ShimModel {
  id: string;
  name: string;
  context: number;
  out: number;
  efforts: readonly string[];
}

export const MODELS: readonly ShimModel[] = (RAW_MODELS as Omit<ShimModel, "efforts">[]).map((m) => ({
  ...m,
  efforts: (EFFORTS_BY_MODEL as Record<string, readonly string[]>)[m.id] ?? ["low", "medium", "high"],
}));

export const PROVIDER_ID: string = ID;
export const PROVIDER_NAME: string = NAME;
export const DEFAULT_PORT: number = PORT;

export type ConfigFormat = "providers-json" | "models-yml" | "models-json";

export function render(fmt: ConfigFormat, port: number = DEFAULT_PORT): string {
  return (renderImpl as (f: string, p: number) => string)(fmt, port);
}
