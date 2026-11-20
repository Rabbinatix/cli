// `rabbinatix <command>`: the commands of assistant-and-cli-plan.md § 3.2. Fixed rules, no AI model; what each sends is in
// its --help.
import { main } from '../cli.js';
import { mainDeploy } from '../deploy-cli.js';
import { mainDesign } from '../design-cli.js';
import { mainGenerate } from '../generate-cli.js';
import { mainMock } from '../mock-cli.js';
import { mainOpenApi } from '../openapi-cli.js';
import { mainRelay } from '../relay-cli.js';
import { mainScan } from '../scan-cli.js';
import { mainStatus } from '../status-cli.js';
import { mainTest } from '../test-cli.js';
import { mainVerify } from '../verify-cli.js';
import { mainWatch } from '../watch-cli.js';
import { VERSION } from '../version.js';

const HELP = `rabbinatix ${VERSION}: Rabbinatix in your terminal and in CI

Usage: rabbinatix <command> [options]   (rabbinatix <command> --help for each)

  impact          what a code change affects: flows, contracts, test cases to run
  status          is the code in step with the map? (anchors behind, gone, missing; route files with no anchor)
  test            the flows' test cases, simulated; --affected runs only those a change affects
  scan            security issues: secrets, risky code, vulnerable dependencies (+ Semgrep, Gitleaks, OSV-Scanner)
  deploy check    may this release go to that environment? (exit 1 when it would break a contract)
  deploy record   record a deployment after your deploy step
  generate        the code of logic, as the Code panel downloads it; --check fails when the repo's is older
  verify          the Python, C# or Java code of a logic against its recorded test runs, on this machine
  openapi pull    a system's OpenAPI file (for client generators in any language)
  design          a screen's design (HTML, theme tokens, picture, every widget's box) to build it pixel-perfect
  openapi diff    the repo's spec against the map: what would break callers
  mock            a system's test server on this machine
  watch import    a HAR recording's or trace file's calls checked against the contracts, like the contract watcher
  watch listen    calls from phone apps and OpenTelemetry checked as they happen
  relay           send Test APIs' requests from this machine (no CORS)

Fixed rules, the same answer every time. No AI model, and none of your code leaves the machine (each command's
--help says what it sends). Where a result needs understanding, the command prints the AI prompt for your assistant.

Exit codes: 0 done · 1 the check you asked for failed · 2 an error.`;

const out = (s: string) => void process.stdout.write(`${s}\n`);
const err = (s: string) => void process.stderr.write(`${s}\n`);
const [command, ...rest] = process.argv.slice(2);
const cwd = process.cwd();

const run = (): Promise<number> => {
  switch (command) {
    case 'impact': return main(rest, cwd, process.env, out, err);
    case 'scan': return mainScan(rest, cwd, process.env, out, err);
    case 'status': return mainStatus(rest, cwd, process.env, out, err);
    case 'test': return mainTest(rest, cwd, process.env, out, err);
    case 'deploy': return mainDeploy(rest, cwd, process.env, out, err);
    case 'generate': return mainGenerate(rest, cwd, process.env, out, err);
    case 'verify': return mainVerify(rest, cwd, process.env, out, err);
    case 'openapi': return mainOpenApi(rest, cwd, process.env, out, err);
    case 'design': return mainDesign(rest, cwd, process.env, out, err);
    case 'relay': return mainRelay(rest, out, err);
    case 'watch': return mainWatch(rest, cwd, out, err);
    case 'mock': return mainMock(rest, cwd, process.env, out, err);
    case '-v': case '--version': out(VERSION); return Promise.resolve(0);
    case undefined: case '-h': case '--help': out(HELP); return Promise.resolve(0);
    default: err(`Unknown command ${command}.\n\n${HELP}`); return Promise.resolve(2);
  }
};
run().then((code) => process.exit(code));
