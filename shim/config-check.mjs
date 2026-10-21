/**
 * The comparison between the rendered opencode block and the merged config.
 * Pure, so a fixture can prove each finding: what the config is missing,
 * what it offers that the shim no longer serves, what carries a stale name,
 * and what drifted in the settings.
 *
 * The port is the operator's choice and is left out of the settings
 * comparison; everything else in the block belongs to the shim.
 */
export function configDrift(rendered, merged) {
  const problems = [];
  if (!merged) return problems;

  if (merged.name !== rendered.name) {
    problems.push(`provider name: ${JSON.stringify(merged.name)} -> ${JSON.stringify(rendered.name)}`);
  }

  const mergedIds = Object.keys(merged.models ?? {});
  const renderedIds = Object.keys(rendered.models);
  const missing = renderedIds.filter((id) => !mergedIds.includes(id));
  const extra = mergedIds.filter((id) => !renderedIds.includes(id));
  if (missing.length) {
    problems.push(`${missing.length} model(s) the block is missing (e.g. ${missing.slice(0, 3).join(", ")})`);
  }
  if (extra.length) {
    problems.push(
      `${extra.length} model(s) the block offers that the shim no longer serves (e.g. ${extra.slice(0, 3).join(", ")})`,
    );
  }
  const renamed = renderedIds.filter(
    (id) => mergedIds.includes(id) && merged.models[id]?.name !== rendered.models[id].name,
  );
  if (renamed.length) {
    const id = renamed[0];
    problems.push(
      `${renamed.length} model(s) with a stale name (e.g. ${id}: ${JSON.stringify(merged.models[id]?.name)} -> ${JSON.stringify(rendered.models[id].name)})`,
    );
  }
  if (merged.package !== rendered.package) {
    problems.push(`package: ${JSON.stringify(merged.package)} -> ${JSON.stringify(rendered.package)}`);
  }
  if (settings(merged) !== settings(rendered)) {
    problems.push(`settings differ from the rendered block (${settings(merged)} -> ${settings(rendered)})`);
  }
  return problems;
}

/** The settings without the port: the operator may run the shim anywhere. */
function settings(block) {
  const { baseURL, ...rest } = block.settings ?? {};
  return JSON.stringify(rest);
}
