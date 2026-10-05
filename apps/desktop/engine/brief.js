// The brief: a task for an AI agent plus Mewndo's safety rules, copied for the user to paste into the agent.
// The rules are editable in the app; {folder} stands for the protected folder's full path.

const DEFAULT_SAFETY_RULES = [
  'Only work inside this folder: {folder}',
  "Don't permanently delete anything. Move files you would delete into a folder named review inside {folder}.",
  "Don't follow symbolic links or junctions, and don't touch anything outside the folder.",
  'Ask me before any action that affects more than 20 files.',
  "When you're done, list every file you created, changed, moved or deleted.",
].map((rule) => `- ${rule}`).join('\n');

// The task, a blank line, then the safety rules for that folder.
function buildBrief(task, folder, rules = DEFAULT_SAFETY_RULES) {
  // A function replacement, so "$" in a path is taken literally.
  const filled = (rules?.trim() || DEFAULT_SAFETY_RULES).replaceAll('{folder}', () => folder);
  return `${task.trim()}\n\nSafety rules from Mewndo:\n${filled}`;
}

// The save point's label: the task's first 60 characters, on one line.
const briefLabel = (task) => task.replace(/\s+/g, ' ').trim().slice(0, 60);

module.exports = { buildBrief, briefLabel, DEFAULT_SAFETY_RULES };
