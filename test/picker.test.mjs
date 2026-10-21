// The model picker must not clip a model name.
//
// opencode renders a picker row (packages/tui/src/ui/dialog-select.tsx) as
// [model name][gap][provider name], where the name sits in the row's only
// flexible cell and the provider name is the footer, which never shrinks. A
// long provider label therefore eats the model name's cells and the name is
// clipped mid-word.
//
// The dialog is min(60, terminal - 2) cells wide, the list bleeds to the
// dialog edges, the row pads 3 cells each side and the title's own padding
// takes 3 more, so 58 - 12 = 46 cells are left for the name and the provider
// together. 46 is what a 60-column terminal leaves; a wider one leaves more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../shim/render.mjs";

const USABLE = 46;

test("every model name fits beside the provider label", () => {
  const provider = JSON.parse(render("opencode")).providers["claude-cli"];
  const budget = USABLE - provider.name.length - 1;
  const longest = Object.entries(provider.models).reduce((a, b) =>
    b[1].name.length > a[1].name.length ? b : a,
  );
  assert.ok(
    longest[1].name.length <= budget,
    `"${longest[1].name}" is ${longest[1].name.length} cells and the picker gives it ${budget} beside "${provider.name}"`,
  );
});
