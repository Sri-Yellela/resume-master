// The two resume tools, named in one place.
//
// These were local consts in JobsPanel.jsx. AutoApplyContext needs A_PLUS_TOOL and GENERATE_TOOL to
// build the same apply-run request startApplyRun always built, and a second copy of a pair of magic
// strings is exactly how the client and the server drift apart on a wire value. JobsPanel imports
// them from here now rather than declaring its own.
export const GENERATE_TOOL = "generate";
export const A_PLUS_TOOL   = "a_plus_resume";
export const TOOL_LABELS   = { [GENERATE_TOOL]: "Generate", [A_PLUS_TOOL]: "A+ Resume" };

export function normalizeTool(tool) {
  return tool === A_PLUS_TOOL ? A_PLUS_TOOL : GENERATE_TOOL;
}
