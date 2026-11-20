// What each feature does for which language (assistant-and-cli-plan.md § 6). The docs' Languages page is drawn from
// this, so what the docs say is what the code does. Every language gets the base from languages.ts alone: anchors in
// its comments, its test files, highlighting. Anything else in any language goes through the AI assistant.
import { ClientDef, CLIENTS, FRAMEWORKS, FrameworkDef } from './frameworks';
import { LanguageDef, LanguageId, LANGUAGES } from './languages';

/** the code generator's targets (codegen/adapters/<id>) */
export const CODEGEN_LANGUAGES = ['typescript', 'python', 'csharp', 'java', 'go', 'kotlin', 'swift', 'dart', 'php', 'ruby', 'rust'] as const satisfies readonly LanguageId[];
export type CodegenLanguage = (typeof CODEGEN_LANGUAGES)[number];
/** generated code verified on the person's machine by `rabbinatix verify` (the rest in the browser) */
export const CLI_VERIFY_LANGUAGES = CODEGEN_LANGUAGES.filter((l): l is Exclude<CodegenLanguage, 'typescript'> => l !== 'typescript');
export const isCodegenLanguage = (v: unknown): v is CodegenLanguage => (CODEGEN_LANGUAGES as readonly string[]).includes(v as string);
/** the generator's language of a file it wrote, by its extension (TypeScript when none matches) */
export const codegenLanguageOf = (fileName: string): CodegenLanguage =>
  CODEGEN_LANGUAGES.find((id) => LANGUAGES.find((l) => l.id === id)!.extensions.some((x) => fileName.endsWith(x))) ?? 'typescript';

export interface CodegenSupport {
  /** formatted with Prettier in the browser, or laid out by its own printer */
  formatter: 'prettier' | 'own';
  /** where generated code is checked against recorded runs: in the browser, or on the machine with `rabbinatix verify` */
  verify: 'browser' | 'cli';
  /** what `rabbinatix verify` needs installed */
  runtime?: { command: string; label: string };
}

export const CODEGEN: Record<CodegenLanguage, CodegenSupport> = {
  typescript: { formatter: 'prettier', verify: 'browser' },
  python: { formatter: 'own', verify: 'cli', runtime: { command: 'python3', label: 'Python 3.10+' } },
  csharp: { formatter: 'own', verify: 'cli', runtime: { command: 'dotnet', label: '.NET 8 SDK' } },
  java: { formatter: 'own', verify: 'cli', runtime: { command: 'java', label: 'JDK 21' } },
  go: { formatter: 'own', verify: 'cli', runtime: { command: 'go', label: 'Go 1.22+' } },
  kotlin: { formatter: 'own', verify: 'cli', runtime: { command: 'kotlinc', label: 'Kotlin 1.9+ (kotlinc) with a JDK' } },
  swift: { formatter: 'own', verify: 'cli', runtime: { command: 'swiftc', label: 'Swift 5.9+' } },
  dart: { formatter: 'own', verify: 'cli', runtime: { command: 'dart', label: 'Dart 3+' } },
  php: { formatter: 'own', verify: 'cli', runtime: { command: 'php', label: 'PHP 8.1+ with mbstring' } },
  ruby: { formatter: 'own', verify: 'cli', runtime: { command: 'ruby', label: 'Ruby 3.1+' } },
  rust: { formatter: 'own', verify: 'cli', runtime: { command: 'rustc', label: 'Rust 1.70+ (rustc)' } },
};

const labelOf = (id: LanguageId) => LANGUAGES.find((l) => l.id === id)!.label;
/** `A, B, C or D` */
export const wordList = (xs: readonly string[], last = 'or') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${last} ${xs[xs.length - 1]}`);
/** for the docs: `TypeScript, Python, C#, Java, Go, Kotlin, Swift, Dart, PHP, Ruby or Rust` */
export const CODEGEN_NAMES = (last = 'or') => wordList(CODEGEN_LANGUAGES.map(labelOf), last);
/** for the docs: the languages `rabbinatix verify` builds, and what each needs */
export const CLI_VERIFY_NAMES = (last = 'or') => wordList(CLI_VERIFY_LANGUAGES.map(labelOf), last);
export const CLI_VERIFY_RUNTIMES = wordList(CLI_VERIFY_LANGUAGES.map((l) => CODEGEN[l].runtime!.label));

/** calls followed through helpers by `rabbinatix impact` (the TypeScript language service) */
export const CALL_FOLLOWING: readonly LanguageId[] = ['typescript', 'javascript'];

/** languages the built-in code rules of `rabbinatix scan` cover (rabbinatix-cli/src/scan/rules.ts; a CLI test keeps the
 *  two in step). Secrets are looked for in every file. */
export const SCAN_RULES: readonly LanguageId[] = ['typescript', 'javascript', 'python', 'csharp', 'java', 'kotlin', 'scala', 'go', 'php', 'ruby', 'rust', 'swift', 'objective-c', 'dart'];

/** “Generate from code” reads calls and types written in these (engine/snippet.ts) */
export const IMPORT_CODE: readonly LanguageId[] = ['typescript', 'javascript'];

/** request snippets (health signals, Test APIs “Copy as …”, the docs): snippets.ts. JavaScript stands for TypeScript too */
export const SNIPPET_LANGUAGES = ['javascript', 'python', 'csharp', 'java', 'kotlin', 'go', 'php', 'ruby', 'rust', 'swift', 'dart'] as const satisfies readonly LanguageId[];
export type SnippetLanguage = (typeof SNIPPET_LANGUAGES)[number];

export interface LanguageSupport {
  language: LanguageDef;
  codegen?: CodegenSupport;
  callFollowing: boolean;
  routes: FrameworkDef[];
  /** HTTP clients whose calls code impact reads */
  clients: ClientDef[];
  scanRules: boolean;
  importCode: boolean;
  snippets: boolean;
}

/** one row per language: what works for it */
export function supportOf(id: LanguageId): LanguageSupport {
  const language = LANGUAGES.find((l) => l.id === id)!;
  return {
    language,
    ...(isCodegenLanguage(id) ? { codegen: CODEGEN[id] } : {}),
    callFollowing: CALL_FOLLOWING.includes(id),
    routes: FRAMEWORKS.filter((f) => f.languages.includes(id)),
    clients: CLIENTS.filter((c) => c.languages.includes(id)),
    scanRules: SCAN_RULES.includes(id),
    importCode: IMPORT_CODE.includes(id),
    snippets: (SNIPPET_LANGUAGES as readonly string[]).includes(id) || id === 'typescript',
  };
}

export const SUPPORT: readonly LanguageSupport[] = LANGUAGES.map((l) => supportOf(l.id));
