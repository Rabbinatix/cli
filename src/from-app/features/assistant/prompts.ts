// "AI prompts" (the user's request 2026-11-02): the prompts a person copies into their AI assistant, per page, in one
// list so they read the same everywhere. Each is short: the assistant, connected to Rabbinatix, reads the rest itself
// (its guide's topics: scan-code, resolve, security, code-sync, map-repo, questions, flows). Pure.

export interface AiPrompt {
  id: string;
  /** what the menu shows */
  label: string;
  /** a line under it: what the assistant will do */
  detail: string;
  /** what is copied */
  text: string;
}

const named = (key: string | undefined, kind: string, name: string) => `${key || name} (the ${kind} “${name}”)`;
const DRAFTS = 'as drafts for me to review';

/** Security checks: the whole project, or one system (its Security tab) */
export function securityPrompts(o: { system?: { id: string; name: string }; toApply?: number } = {}): AiPrompt[] {
  const of = o.system ? ` of ${o.system.name} (system ${o.system.id})` : '';
  const only = o.system ? ` Scan only ${o.system.name}'s code: the folder its Code repository setting names, or the files that belong to it.` : '';
  const n = o.toApply ?? 0;
  return [
    {
      id: 'scan', label: 'Scan for what rules can’t find',
      detail: 'Your assistant reads this repo for what needs understanding (missing access checks, logic flaws) and reports it. Secrets, risky patterns and vulnerable dependencies: rabbinatix scan.',
      text: `Scan this repo for security issues that need understanding the code, with Rabbinatix (read its guide, topic scan-code): run rabbinatix scan first for the rule-based ones, then report what you find.${only}`,
    },
    {
      id: 'apply', label: 'Apply the fixes marked “Apply fix”',
      detail: n ? `${n === 1 ? '1 finding is' : `${n} findings are`} marked. Fixed ones show as Fixed until the next scan confirms them.` : 'Mark findings with Apply fix first. Fixed ones show as Fixed until the next scan confirms them.',
      text: `Apply the security fixes marked “Apply fix” in Rabbinatix${of} (read its guide, topic resolve): one finding at a time, run the tests after each, and tell Rabbinatix which commit fixed each one.`,
    },
    {
      id: 'design', label: 'Fix the design’s security findings',
      detail: 'Your assistant runs the design checks, explains each finding and drafts the fixes.',
      text: `In Rabbinatix, run the security checks on the design${of} (read its guide, topic security), explain each finding in plain words, and draft the fixes ${DRAFTS}.`,
    },
  ];
}

/** one logic (its editor) */
export function logicPrompts(l: { key?: string; name: string }): AiPrompt[] {
  const it = named(l.key, 'logic', l.name);
  return [
    { id: 'write', label: 'Write its code', detail: 'In this project, the way the project is written, with the code anchors.', text: `In Rabbinatix, get ${it} and write its code in this project the way the project is written, with its code anchors (read its guide, topic code-sync).` },
    { id: 'sync', label: 'Bring my code in step with it', detail: 'Updates only the code its changes touch since your code matched it.', text: `In Rabbinatix, read topic code-sync, then use changes to update only the code that ${it} changed since my code last matched it. Run the tests.` },
    { id: 'change', label: 'Change it', detail: 'You say what to change; your assistant checks it and drafts it.', text: `In Rabbinatix, get ${it}. I'll tell you what to change: check the change and draft it for me to review.` },
    { id: 'improve', label: 'Suggest improvements', detail: 'Runs the suggestions on it, explains them, drafts the ones that help.', text: `In Rabbinatix, run suggest on ${it}, explain what you find, and draft the improvements worth making ${DRAFTS}.` },
    { id: 'explain', label: 'Explain what it does', detail: 'Step by step, who calls it and which flows go through it.', text: `In Rabbinatix, get ${it} and explain step by step what it does, who calls it and which flows go through it (read its guide, topic questions).` },
  ];
}

/** the Logic page */
export function logicListPrompts(): AiPrompt[] {
  return [
    { id: 'from-code', label: 'Turn my code into logic', detail: 'The code you point your assistant to, checked and tested.', text: `In Rabbinatix, read how we build logic, then turn the code I point you to in this project into logic there, checked and tested, ${DRAFTS}.` },
    { id: 'sync-all', label: 'Bring my code in step with every change', detail: 'Updates the code of each logic that changed since your code matched it.', text: 'In Rabbinatix, read topic code-sync, then use changes to update only the code that changed logic touches in this project, one logic at a time. Run the tests.' },
  ];
}

/** one flow (its page) */
export function flowPrompts(f: { key?: string; name: string }): AiPrompt[] {
  const it = named(f.key, 'flow', f.name);
  return [
    { id: 'write', label: 'Write its code', detail: 'The code of each step, the way the project is written.', text: `In Rabbinatix, get ${it} and write the code of its steps in this project the way the project is written, with their code anchors (read its guide, topic code-sync).` },
    { id: 'tests', label: 'Add test cases', detail: 'Test cases and test data for the paths it doesn’t test yet.', text: `In Rabbinatix, get ${it}, read topic flows, and add test cases with test data for the paths it doesn't test yet, ${DRAFTS}.` },
    { id: 'change', label: 'Change it', detail: 'You say what to change; your assistant checks it and drafts it.', text: `In Rabbinatix, get ${it}. I'll tell you what to change: check the change and draft it for me to review.` },
    { id: 'improve', label: 'Suggest improvements', detail: 'Runs the suggestions on it, drafts the ones that help.', text: `In Rabbinatix, run suggest on ${it}, explain what you find, and draft the improvements worth making ${DRAFTS}.` },
    { id: 'explain', label: 'Explain the journey', detail: 'Step by step across the systems it goes through.', text: `In Rabbinatix, get ${it} and explain the journey step by step across the systems it goes through (read its guide, topic questions).` },
  ];
}

/** the Flows page */
export function flowListPrompts(): AiPrompt[] {
  return [
    { id: 'from-code', label: 'Turn a journey in my code into a flow', detail: 'With its logic and a test case.', text: `In Rabbinatix, read how we build flows, then turn the journey in the code I point you to into a flow there, with its logic and a test case, ${DRAFTS}.` },
    { id: 'tests', label: 'Add test cases where they are missing', detail: 'For the flows with paths no test case covers.', text: `In Rabbinatix, find the flows with paths no test case covers (read topic flows), and add test cases with test data for them, one flow at a time, ${DRAFTS}.` },
  ];
}

/** the Systems page */
export function systemsListPrompts(): AiPrompt[] {
  return [
    { id: 'map-repo', label: 'Put my repo on the map', detail: 'Its systems, APIs, calls, logic and flows, one batch per system.', text: `In Rabbinatix, read topic map-repo, then put this repo on the map: its systems, APIs, calls, logic and flows, one batch per system, ${DRAFTS}.` },
    { id: 'scan', label: 'Scan for what rules can’t find', detail: 'Missing access checks, logic flaws: the findings show on Security checks → Code scan (rabbinatix scan finds the rest).', text: securityPrompts()[0].text },
    { id: 'ask', label: 'Answer a question about our systems', detail: '“What happens when…”, “who calls…”, from the map.', text: 'In Rabbinatix, read topic questions. I have a question about how our systems work: answer it from the map, with refs to the exact steps.' },
  ];
}

/** one system (its page) */
export function systemPrompts(s: { id: string; name: string }): AiPrompt[] {
  const it = `${s.name} (system ${s.id})`;
  return [
    { id: 'map-repo', label: 'Put its code on the map', detail: 'Its APIs, calls, logic and flows, from its code in this repo.', text: `In Rabbinatix, read topic map-repo, then put ${it}'s code in this repo on the map: its APIs, calls, logic and flows, ${DRAFTS}.` },
    { id: 'scan', label: 'Scan its code for what rules can’t find', detail: 'Missing access checks, logic flaws: the findings show on its Security tab.', text: securityPrompts({ system: s })[0].text },
    { id: 'sync', label: 'Bring its code in step', detail: 'Updates its code where its logic changed since your code matched it.', text: `In Rabbinatix, read topic code-sync, then use changes to update only the code of ${it} that its changed logic touches. Run the tests.` },
    { id: 'explain', label: 'Explain how it works', detail: 'What it offers, who calls it, what it calls.', text: `In Rabbinatix, explain how ${it} works: the APIs it offers, who calls them, what it calls, and the flows that go through it (read its guide, topic questions).` },
    { id: 'design', label: 'Fix its design’s security findings', detail: 'Explains each finding and drafts the fixes.', text: securityPrompts({ system: s })[2].text },
  ];
}

/** one screen (the Screen Builder): build it pixel-perfect, match a mock-up, fit every width, change, improve, explain */
export function screenPrompts(x: { key?: string; name: string }): AiPrompt[] {
  const it = named(x.key, 'screen', x.name);
  return [
    { id: 'build', label: 'Build it in my code, pixel-perfect', detail: 'From its design: the page, the theme’s values and every widget’s size and place.', text: `In Rabbinatix, design ${it} at the width I build for and write it in this project the way the project is written, matching its picture and sizes, with the theme's values as variables and each widget's data-key kept (read its guide, topic screens).` },
    { id: 'mockup', label: 'Make it look like my mock-up', detail: 'You give a picture; your assistant drafts the changes and checks its draft against it.', text: `In Rabbinatix, get ${it}. I'll give you a picture of how it should look: draft the changes to match it, then design your draft to check it against the picture (read its guide, topic screens), ${DRAFTS}.` },
    { id: 'widths', label: 'Make it work on phones and tablets', detail: 'Looks at it at each width and drafts what each needs.', text: `In Rabbinatix, design ${it} at phone, tablet and desktop width and draft what it needs to read well at each (hide, stack or resize widgets for a width), ${DRAFTS}.` },
    { id: 'change', label: 'Change it', detail: 'You say what to change; your assistant checks it and drafts it.', text: `In Rabbinatix, get ${it}. I'll tell you what to change: check the change and draft it for me to review.` },
    { id: 'improve', label: 'Suggest improvements', detail: 'Runs the suggestions on it (mismatches with its logic), drafts the ones that help.', text: `In Rabbinatix, run suggest on ${it}, explain what you find, and draft the improvements worth making ${DRAFTS}.` },
    { id: 'explain', label: 'Explain what it does', detail: 'What each button runs, where it leads, what it shows.', text: `In Rabbinatix, get ${it} and explain what it does: what each button and input runs, where it leads, and what it shows (read its guide, topics screens and questions).` },
  ];
}

/** one layout (the Screen Builder): a layout has no design of its own, its screens do */
export function layoutPrompts(x: { key?: string; name: string }): AiPrompt[] {
  const it = named(x.key, 'layout', x.name);
  return [
    { id: 'mockup', label: 'Make it look like my mock-up', detail: 'You give a picture of the header, menu or footer; your assistant drafts the changes.', text: `In Rabbinatix, get ${it}. I'll give you a picture of how it should look: draft the changes to match it, then design one of its screens with your draft to check it (read its guide, topic screens), ${DRAFTS}.` },
    { id: 'change', label: 'Change it', detail: 'You say what to change; your assistant checks it and drafts it.', text: `In Rabbinatix, get ${it}. I'll tell you what to change: check the change and draft it for me to review.` },
  ];
}

/** a system's Screens tab */
export function screensListPrompts(s: { id: string; name: string }): AiPrompt[] {
  const sys = `${s.name} (system ${s.id})`;
  return [
    { id: 'from-mockup', label: 'Build a screen from my mock-up', detail: 'You give a picture of a page; your assistant drafts the screen and the logic its buttons run, and checks it against the picture.', text: `In Rabbinatix, read topic screens. I'll give you a picture of a page: draft it as a screen of ${sys} with the event logic its buttons need, then design your draft to check it against the picture, ${DRAFTS}.` },
    { id: 'from-code', label: 'Turn my app’s pages into screens', detail: 'The pages in your code, as screens with their layouts.', text: `In Rabbinatix, read topic screens, then turn the pages of ${sys} in this project's code into screens with their layouts and the event logic their buttons run, a few screens per batch, ${DRAFTS}.` },
    { id: 'build', label: 'Build its screens in my code, pixel-perfect', detail: 'Each screen from its design, the way your project is written.', text: `In Rabbinatix, read topic screens, then design each screen of ${sys} at the width I build for and write it in this project the way the project is written, matching its picture and sizes, each widget's data-key kept.` },
  ];
}

/** one ticket */
export function ticketPrompts(t: { key: string; title: string }): AiPrompt[] {
  const it = `ticket ${t.key} (“${t.title}”)`;
  return [
    { id: 'work', label: 'Work on this ticket', detail: 'Reads it and what it links to, then does the work.', text: `In Rabbinatix, get ${it} and what it links to, then do the work it asks: change the code in this project, or draft the design change for me to review. Tell me what you did.` },
    { id: 'plan', label: 'Plan this ticket', detail: 'A plan first: nothing changes yet.', text: `In Rabbinatix, get ${it} and what it links to, and reply with a plan for the work: what changes in the code and in the design, in which order, and what to test. Don't change anything yet.` },
    { id: 'impact', label: 'What does it affect?', detail: 'Who uses what it links to.', text: `In Rabbinatix, get ${it}, then use usage on what it links to and tell me what this work would affect: the APIs, flows and systems, and who uses them.` },
  ];
}

/** the Drafts page */
export function draftsPrompts(): AiPrompt[] {
  return [
    { id: 'rejected', label: 'Redo the rejected batches', detail: 'Reads the reasons you gave and drafts them again.', text: 'In Rabbinatix, use drafts to read the batches I rejected and why, then draft them again with my reasons addressed.' },
    { id: 'outdated', label: 'Redo the outdated batches', detail: 'Drafts them again on the current versions.', text: 'In Rabbinatix, use drafts to find my outdated batches (what they change has changed since), get the current versions and draft them again.' },
  ];
}

/** the Code impact page: check a change, compare branches, look before editing (topic impact) */
export function impactListPrompts(): AiPrompt[] {
  return [
    nextStepPrompts.checkMine(),
    { id: 'compare-main', label: 'Compare my branch with main', detail: 'What your branch adds since it left main, checked and kept here.', text: 'In Rabbinatix, compare the branch I’m on with main from where they split (read its guide, topic impact): check what the difference affects and keep the report (store: true, change.base and change.head set). Prefer `npx -y rabbinatix impact --base main --head <my branch> --store --run-by assistant` if you can run commands.' },
    { id: 'before', label: 'Check a change before I make it', detail: 'The flows, contracts and test cases the code you point to reaches.', text: 'In Rabbinatix, before you change the code I point you to, check what it reaches (read its guide, topic impact): the flows, contracts and test cases, and tell me what to watch. Change nothing yet.' },
    nextStepPrompts.fixBroke(),
  ];
}

/** the API catalog (topics questions, map-repo) */
export function catalogPrompts(): AiPrompt[] {
  return [
    { id: 'ask', label: 'Answer a question about an API', detail: '“Who calls…”, “what does it return when…”, from the map.', text: 'In Rabbinatix, read topic questions. I have a question about one of our APIs: answer it from the map (who provides it, who calls it, its shapes), with refs to the exact APIs and steps.' },
    { id: 'missing', label: 'Add the APIs in my code that aren’t here', detail: 'Reads this repo and drafts the APIs and calls the map is missing.', text: `In Rabbinatix, read topic map-repo, then compare this repo's APIs and the calls it makes with the map, and add the ones missing, ${DRAFTS}.` },
    { id: 'unused', label: 'Find the APIs no one calls', detail: 'APIs with no consumer on the map, and whether the code still uses them.', text: 'In Rabbinatix, find the APIs no system calls on the map (map, usage), check whether this repo still calls them, and list which look safe to retire. Change nothing.' },
  ];
}

/** Retiring APIs (topics questions, code-sync) */
export function retiringPrompts(): AiPrompt[] {
  return [
    { id: 'move-off', label: 'Move my code off retiring APIs', detail: 'Finds the calls this repo still makes to them and moves each to its replacement.', text: 'In Rabbinatix, find the retiring APIs this repo still calls (map, usage), and move each call to its replacement, one at a time, running the tests after each. Tell me where there is no replacement.' },
    { id: 'plan', label: 'Plan who has to move, and how', detail: 'Per retiring API: the systems still on it and what each must change.', text: 'In Rabbinatix, read the retiring APIs and the systems that still use them (map, usage, topic questions), and write a short plan per API: who has to move, what they must change, and what to do first. Change nothing.' },
  ];
}

/** the Whiteboards list (topic whiteboards) */
export function whiteboardListPrompts(): AiPrompt[] {
  return [
    { id: 'sketch', label: 'Sketch a journey on a whiteboard', detail: 'From what you describe, with shapes and arrows.', text: `In Rabbinatix, read topic whiteboards, then sketch the journey I describe on a new whiteboard, ${DRAFTS}.` },
    { id: 'from-code', label: 'Sketch how my code works today', detail: 'The journey in the code you point to, as a whiteboard to discuss.', text: `In Rabbinatix, read topic whiteboards, then sketch the journey in the code I point you to on a new whiteboard, so the team can discuss it, ${DRAFTS}.` },
    { id: 'to-flow', label: 'Turn a whiteboard into a flow', detail: 'With its logic and a test case.', text: `In Rabbinatix, read topic whiteboards and topic flows, then turn the whiteboard I name into a flow with its logic and a test case, ${DRAFTS}.` },
  ];
}

/** what a code impact report needs next: “Fix what this change broke” only when a contract may break (the same rule
 *  as `rabbinatix impact --fail-on breaks`) or the affected flows' test cases fail; “put it on the map” when changed code
 *  isn't on it. The report page and `rabbinatix impact` show the same (hand test 2026-11-07: a change that broke
 *  nothing was offered “Fix what this change broke”, and the CLI printed neither) */
export function impactPrompts(r: { triage?: { kind: string; mustLook: boolean }[]; notMapped?: { file: string }[]; dimensions?: { tests?: { failing: number } } }, report?: string): AiPrompt[] {
  // fields an older server leaves out count as nothing
  const breaks = (r.triage ?? []).some((t) => t.kind === 'contract' && t.mustLook) || (r.dimensions?.tests?.failing ?? 0) > 0;
  const unmapped = r.notMapped ?? [];
  return [...(breaks ? [nextStepPrompts.fixBroke(report)] : []), ...(unmapped.length ? [nextStepPrompts.unmapped(unmapped.map((n) => n.file))] : [])];
}

/** where the rabbinatix CLI gives a fixed answer that needs judgement next (assistant-and-cli-plan.md § 5.4): the app
 *  shows these next to the result, and the CLI prints the same words (it bundles this file) */
export const nextStepPrompts = {
  /** code impact found changed code no logic or API names */
  unmapped: (files: string[]): AiPrompt => ({
    id: 'unmapped', label: 'Put the changed code that isn’t on the map on it',
    detail: 'Your assistant maps it (systems, APIs, logic) as drafts and adds the anchors, so the next check sees it.',
    text: `In Rabbinatix, put this code on the map (read its guide, topic map-repo) ${DRAFTS}, then add the anchors: ${files.slice(0, 20).join(', ')}${files.length > 20 ? ` and ${files.length - 20} more` : ''}.`,
  }),
  /** code impact: the change may break a contract, a critical flow, or its test cases fail */
  fixBroke: (report?: string): AiPrompt => ({
    id: 'fix-broke', label: 'Fix what this change broke',
    detail: 'Your assistant reads the impact report, fixes what this change caused and leaves what was already there.',
    text: `In Rabbinatix, read the impact of my change${report ? ` (report ${report})` : ''} (its guide, topic impact): fix what this change caused, one item at a time, run the tests after each, and leave what was already there.`,
  }),
  /** code impact checked by the assistant itself, kept on the Code impact page (code-impact-compare-plan.md C3) */
  checkMine: (): AiPrompt => ({
    id: 'check-mine', label: 'Check what my change affects and keep the report',
    detail: 'Your assistant finds where your change lands, checks it in Rabbinatix and keeps the report here.',
    text: 'In Rabbinatix, check what my change affects (read its guide, topic impact) and keep the report (store: true). Tell me what to look at first.',
  }),
  /** code impact between two branches or commits, by the assistant */
  compare: (base = '<older branch or commit>', head = '<newer branch or commit>', straight = false): AiPrompt => ({
    id: 'compare', label: `Compare ${base} with ${head}`,
    detail: 'Your assistant reads the difference between them, checks it in Rabbinatix and keeps the report here.',
    text: `In Rabbinatix, compare ${base} with ${head}${straight ? ' directly' : ' from where they split'} (read its guide, topic impact): check what the difference affects and keep the report (store: true, change.base and change.head set). Prefer \`npx -y rabbinatix impact --base ${base} --head ${head}${straight ? ' --straight' : ''} --store --run-by assistant\` if you can run commands.`,
  }),
  /** rabbinatix status: anchors behind the map, or logic gone */
  behind: (): AiPrompt => ({
    id: 'behind', label: 'Bring my code in step with every change',
    detail: 'Updates the code of each logic that changed since your code matched it.',
    text: 'In Rabbinatix, bring this repo\'s code in step with every logic that changed since the code matched it (read its guide, topic code-sync), then run the tests.',
  }),
  /** rabbinatix test: test cases failed */
  failing: (keys: string[]): AiPrompt => ({
    id: 'failing', label: 'Find out why these test cases fail',
    detail: 'Your assistant runs them in Rabbinatix, reads the steps taken, and says whether the code or the test case is wrong.',
    text: `In Rabbinatix, run the test cases of ${keys.slice(0, 20).join(', ')} (action test), find out why they fail, and say whether the logic or the test case is wrong. Draft a fix ${DRAFTS} only if I agree.`,
  }),
  /** the safety check blocked a deployment */
  blocked: (system: string, version: string, env: string): AiPrompt => ({
    id: 'blocked', label: 'Explain why this deployment is blocked',
    detail: 'Your assistant reads the contracts that block it and says what to change, on which side.',
    text: `In Rabbinatix, explain why ${system} ${version} can't go to ${env}: read the contracts that block it (map, usage) and say, for each, what to change and on which side. Change nothing yet.`,
  }),
  /** Generate from code: a call the parser doesn't read */
  importCall: (): AiPrompt => ({
    id: 'import-call', label: 'Turn this call into an expectation',
    detail: 'Any language: your assistant reads the call and its types and drafts the consumer expectation.',
    text: `In Rabbinatix, turn the HTTP call I point you to into a consumer expectation on the map (read its guide, topic map), with the request and response shapes from its types, ${DRAFTS}.`,
  }),
};
