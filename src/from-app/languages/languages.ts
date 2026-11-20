// THE list of programming languages (docs/04-roadmap/languages-plan.md, assistant-and-cli-plan.md § 6). Used by the app,
// the Cloud Functions and the rabbinatix CLI (both bundle it). Pure: no Angular, no Firebase, no Node.
// Ids are stored (code versions, preferences): never rename one. A new language is one entry here; what each feature
// does with it is in support.ts. `node scripts/language-lists-check.mjs` fails when a list of languages appears elsewhere.

export type LanguageId =
  | 'typescript' | 'javascript' | 'python' | 'java' | 'kotlin' | 'scala' | 'groovy' | 'csharp' | 'fsharp' | 'vbnet'
  | 'go' | 'rust' | 'ruby' | 'php' | 'swift' | 'objective-c' | 'dart' | 'elixir' | 'erlang' | 'clojure' | 'haskell'
  | 'ocaml' | 'c' | 'cpp' | 'lua' | 'perl' | 'r' | 'julia' | 'zig' | 'nim' | 'crystal' | 'gleam' | 'apex' | 'shell'
  | 'powershell' | 'sql' | 'solidity' | 'cobol' | 'abap' | 'pascal' | 'fortran' | 'ada' | 'matlab' | 'vb' | 'terraform';

export interface LanguageDef {
  id: LanguageId;
  label: string;
  /** other names people and tools use (code fences, linguist, file types): lower case */
  aliases: string[];
  /** with the dot, lower case; the first is the usual one */
  extensions: string[];
  /** whole file names (Dockerfile-like): exact case */
  filenames?: string[];
  comments: {
    /** line comments, most usual first: anchors are written with the first */
    line: string[];
    /** block comments as [open, close]: anchors in a language without line comments use the first, on one line */
    block: [string, string][];
  };
  /** words the highlighter marks (short lists for most; the code generator's targets have full ones) */
  keywords: string[];
  /** `#if` / `#include` lines are directives, not comments (C, C++, C#, Objective-C) */
  directives?: boolean;
  /** test files (globs from the repository root, case-sensitive); the shared test folders (detect.ts) apply too */
  tests: string[];
  /** the package ecosystems its lock files belong to (ecosystems.ts) */
  ecosystems: string[];
  /** the same toolchain family: javascript → typescript, kotlin → java (used to share readers and rules) */
  family?: LanguageId;
  /** scripts and infrastructure (shell, Terraform): not application code a map names, so code impact doesn't count it
   *  as “not on the map” */
  tooling?: boolean;
}

const C_LIKE = { line: ['//'], block: [['/*', '*/']] as [string, string][] };
const HASH = { line: ['#'], block: [] as [string, string][] };
const JS_TESTS = (ext: string) => [`**/*.{spec,test,e2e,cy}.${ext}`];

export const LANGUAGES: readonly LanguageDef[] = [
  {
    id: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx'], extensions: ['.ts', '.tsx', '.mts', '.cts'], comments: C_LIKE,
    keywords: [
      'const', 'let', 'var', 'if', 'else', 'return', 'await', 'async', 'function', 'export', 'import', 'from', 'type', 'interface', 'switch', 'case',
      'default', 'break', 'continue', 'for', 'of', 'in', 'while', 'try', 'catch', 'finally', 'throw', 'new', 'null', 'true', 'false', 'typeof', 'as',
      'class', 'extends', 'readonly', 'public', 'private', 'void', 'undefined', 'is',
    ],
    tests: JS_TESTS('{ts,tsx,mts,cts}'), ecosystems: ['npm'],
  },
  {
    id: 'javascript', label: 'JavaScript', aliases: ['js', 'jsx', 'node', 'nodejs'], extensions: ['.js', '.jsx', '.mjs', '.cjs'], comments: C_LIKE,
    keywords: ['const', 'let', 'var', 'if', 'else', 'return', 'await', 'async', 'function', 'export', 'import', 'from', 'switch', 'case', 'default', 'break',
      'continue', 'for', 'of', 'in', 'while', 'try', 'catch', 'finally', 'throw', 'new', 'null', 'true', 'false', 'typeof', 'class', 'extends', 'undefined', 'this'],
    tests: JS_TESTS('{js,jsx,mjs,cjs}'), ecosystems: ['npm'], family: 'typescript',
  },
  {
    id: 'python', label: 'Python', aliases: ['py', 'python3'], extensions: ['.py', '.pyi'], comments: HASH,
    keywords: [
      'False', 'None', 'True', 'and', 'as', 'async', 'await', 'break', 'class', 'continue', 'def', 'elif', 'else', 'except', 'finally', 'for', 'from',
      'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'match', 'case', 'type',
    ],
    tests: ['**/test_*.py', '**/*_test.py', '**/conftest.py'], ecosystems: ['PyPI'],
  },
  {
    id: 'java', label: 'Java', aliases: [], extensions: ['.java'], comments: C_LIKE,
    keywords: [
      'package', 'import', 'public', 'private', 'protected', 'static', 'final', 'record', 'class', 'interface', 'extends', 'implements', 'return', 'if',
      'else', 'switch', 'case', 'default', 'break', 'continue', 'for', 'while', 'do', 'try', 'catch', 'finally', 'throw', 'throws', 'new', 'null', 'true',
      'false', 'var', 'double', 'long', 'boolean', 'int', 'void', 'instanceof', 'this', 'super',
    ],
    tests: ['**/?*Test.java', '**/?*Tests.java', '**/?*IT.java'], ecosystems: ['Maven'],
  },
  {
    id: 'kotlin', label: 'Kotlin', aliases: ['kt'], extensions: ['.kt', '.kts'], comments: C_LIKE,
    keywords: ['package', 'import', 'fun', 'val', 'var', 'class', 'object', 'interface', 'data', 'sealed', 'when', 'if', 'else', 'return', 'for', 'while',
      'try', 'catch', 'finally', 'throw', 'null', 'true', 'false', 'is', 'as', 'in', 'suspend', 'override', 'private', 'public', 'internal', 'companion'],
    tests: ['**/?*Test.kt', '**/?*Tests.kt', '**/?*Spec.kt', '**/?*IT.kt'], ecosystems: ['Maven'], family: 'java',
  },
  {
    id: 'scala', label: 'Scala', aliases: ['sc'], extensions: ['.scala', '.sc'], comments: C_LIKE,
    keywords: ['package', 'import', 'def', 'val', 'var', 'class', 'object', 'trait', 'case', 'match', 'if', 'else', 'for', 'yield', 'while', 'try', 'catch',
      'finally', 'throw', 'new', 'null', 'true', 'false', 'extends', 'with', 'override', 'private', 'implicit', 'given', 'using', 'enum'],
    tests: ['**/?*Spec.scala', '**/?*Test.scala', '**/?*Suite.scala'], ecosystems: ['Maven'], family: 'java',
  },
  {
    id: 'groovy', label: 'Groovy', aliases: ['gradle'], extensions: ['.groovy', '.gradle', '.gvy'], comments: C_LIKE,
    keywords: ['def', 'class', 'interface', 'import', 'package', 'if', 'else', 'return', 'for', 'while', 'switch', 'case', 'try', 'catch', 'finally', 'throw',
      'new', 'null', 'true', 'false', 'in', 'as', 'static', 'final'],
    tests: ['**/?*Spec.groovy', '**/?*Test.groovy'], ecosystems: ['Maven'], family: 'java',
  },
  {
    id: 'csharp', label: 'C#', aliases: ['cs', 'c#', 'dotnet', '.net'], extensions: ['.cs', '.csx'], comments: C_LIKE, directives: true,
    keywords: [
      'using', 'namespace', 'public', 'private', 'static', 'sealed', 'record', 'class', 'interface', 'async', 'await', 'return', 'if', 'else', 'switch',
      'case', 'default', 'break', 'continue', 'goto', 'for', 'foreach', 'in', 'while', 'try', 'catch', 'when', 'throw', 'new', 'null', 'true', 'false',
      'var', 'object', 'string', 'double', 'long', 'bool', 'int', 'void', 'is', 'not', 'required', 'get', 'init',
    ],
    tests: ['**/?*Test.cs', '**/?*Tests.cs'], ecosystems: ['NuGet'],
  },
  {
    id: 'fsharp', label: 'F#', aliases: ['fs', 'f#'], extensions: ['.fs', '.fsi', '.fsx'], comments: { line: ['//'], block: [['(*', '*)']] },
    keywords: ['let', 'mutable', 'fun', 'function', 'match', 'with', 'if', 'then', 'else', 'elif', 'type', 'module', 'open', 'namespace', 'member', 'async',
      'return', 'yield', 'for', 'in', 'do', 'while', 'try', 'finally', 'true', 'false', 'null', 'rec', 'and', 'of'],
    tests: ['**/?*Tests.fs', '**/?*Test.fs'], ecosystems: ['NuGet'], family: 'csharp',
  },
  {
    id: 'vbnet', label: 'VB.NET', aliases: ['vb.net', 'visual basic .net'], extensions: ['.vb'], comments: { line: ["'"], block: [] },
    keywords: ['Imports', 'Namespace', 'Public', 'Private', 'Class', 'Module', 'Sub', 'Function', 'End', 'Dim', 'As', 'If', 'Then', 'Else', 'ElseIf', 'For',
      'Each', 'Next', 'While', 'Return', 'New', 'Nothing', 'True', 'False', 'Try', 'Catch', 'Finally', 'Throw', 'Async', 'Await'],
    tests: ['**/?*Tests.vb', '**/?*Test.vb'], ecosystems: ['NuGet'], family: 'csharp',
  },
  {
    id: 'go', label: 'Go', aliases: ['golang'], extensions: ['.go'], comments: C_LIKE,
    keywords: ['package', 'import', 'func', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'if', 'else', 'for', 'range',
      'switch', 'case', 'default', 'select', 'return', 'break', 'continue', 'nil', 'true', 'false', 'error'],
    tests: ['**/*_test.go'], ecosystems: ['Go'],
  },
  {
    id: 'rust', label: 'Rust', aliases: ['rs'], extensions: ['.rs'], comments: C_LIKE,
    keywords: ['fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'trait', 'impl', 'pub', 'use', 'mod', 'crate', 'self', 'Self', 'match', 'if', 'else',
      'for', 'in', 'while', 'loop', 'return', 'break', 'continue', 'async', 'await', 'move', 'ref', 'where', 'true', 'false', 'unsafe', 'dyn'],
    tests: ['**/tests/**/*.rs'], ecosystems: ['crates.io'],
  },
  {
    id: 'ruby', label: 'Ruby', aliases: ['rb'], extensions: ['.rb', '.rake', '.gemspec'], filenames: ['Gemfile', 'Rakefile'], comments: { line: ['#'], block: [['=begin', '=end']] },
    keywords: ['def', 'end', 'class', 'module', 'if', 'elsif', 'else', 'unless', 'case', 'when', 'while', 'until', 'for', 'in', 'do', 'return', 'yield',
      'begin', 'rescue', 'ensure', 'raise', 'nil', 'true', 'false', 'self', 'require', 'attr_accessor', 'private', 'lambda'],
    tests: ['**/*_spec.rb', '**/*_test.rb'], ecosystems: ['RubyGems'],
  },
  {
    id: 'php', label: 'PHP', aliases: [], extensions: ['.php', '.phtml'], comments: { line: ['//', '#'], block: [['/*', '*/']] },
    keywords: ['function', 'class', 'interface', 'trait', 'namespace', 'use', 'public', 'private', 'protected', 'static', 'return', 'if', 'else', 'elseif',
      'foreach', 'for', 'while', 'switch', 'case', 'match', 'try', 'catch', 'finally', 'throw', 'new', 'null', 'true', 'false', 'echo', 'fn', 'readonly'],
    tests: ['**/?*Test.php'], ecosystems: ['Packagist'],
  },
  {
    id: 'swift', label: 'Swift', aliases: [], extensions: ['.swift'], comments: C_LIKE,
    keywords: ['import', 'func', 'let', 'var', 'class', 'struct', 'enum', 'protocol', 'extension', 'if', 'else', 'guard', 'switch', 'case', 'default', 'for',
      'in', 'while', 'return', 'throw', 'throws', 'try', 'catch', 'do', 'async', 'await', 'nil', 'true', 'false', 'self', 'public', 'private'],
    tests: ['**/?*Tests.swift', '**/?*Test.swift'], ecosystems: ['SwiftURL'],
  },
  {
    id: 'objective-c', label: 'Objective-C', aliases: ['objc', 'obj-c'], extensions: ['.m', '.mm'], comments: C_LIKE, directives: true,
    keywords: ['@interface', '@implementation', '@end', '@property', '@protocol', 'if', 'else', 'for', 'while', 'return', 'nil', 'YES', 'NO', 'self', 'super',
      'void', 'int', 'id', 'static', 'const'],
    tests: ['**/?*Tests.m'], ecosystems: [],
  },
  {
    id: 'dart', label: 'Dart', aliases: ['flutter'], extensions: ['.dart'], comments: C_LIKE,
    keywords: ['import', 'class', 'abstract', 'extends', 'implements', 'with', 'final', 'const', 'var', 'void', 'if', 'else', 'for', 'while', 'switch', 'case',
      'return', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'null', 'true', 'false', 'late', 'required'],
    tests: ['**/*_test.dart'], ecosystems: ['Pub'],
  },
  {
    id: 'elixir', label: 'Elixir', aliases: ['ex', 'exs'], extensions: ['.ex', '.exs'], comments: HASH,
    keywords: ['def', 'defp', 'defmodule', 'defstruct', 'do', 'end', 'fn', 'if', 'else', 'unless', 'case', 'cond', 'with', 'when', 'import', 'alias', 'use',
      'require', 'nil', 'true', 'false', 'raise', 'try', 'rescue'],
    tests: ['**/*_test.exs'], ecosystems: ['Hex'],
  },
  {
    id: 'erlang', label: 'Erlang', aliases: ['erl'], extensions: ['.erl', '.hrl'], comments: { line: ['%'], block: [] },
    keywords: ['module', 'export', 'fun', 'case', 'of', 'end', 'if', 'receive', 'after', 'when', 'try', 'catch', 'throw', 'begin', 'true', 'false'],
    tests: ['**/*_SUITE.erl', '**/*_tests.erl'], ecosystems: ['Hex'],
  },
  {
    id: 'clojure', label: 'Clojure', aliases: ['clj', 'cljs'], extensions: ['.clj', '.cljs', '.cljc', '.edn'], comments: { line: [';;', ';'], block: [] },
    keywords: ['def', 'defn', 'defn-', 'fn', 'let', 'if', 'when', 'cond', 'do', 'ns', 'require', 'loop', 'recur', 'nil', 'true', 'false'],
    tests: ['**/*_test.clj', '**/*_test.cljs', '**/*_test.cljc'], ecosystems: ['Maven'], family: 'java',
  },
  {
    id: 'haskell', label: 'Haskell', aliases: ['hs'], extensions: ['.hs', '.lhs'], comments: { line: ['--'], block: [['{-', '-}']] },
    keywords: ['module', 'import', 'where', 'data', 'type', 'newtype', 'class', 'instance', 'let', 'in', 'case', 'of', 'if', 'then', 'else', 'do', 'deriving'],
    tests: ['**/?*Spec.hs', '**/?*Test.hs'], ecosystems: ['Hackage'],
  },
  {
    id: 'ocaml', label: 'OCaml', aliases: ['ml'], extensions: ['.ml', '.mli'], comments: { line: [], block: [['(*', '*)']] },
    keywords: ['let', 'rec', 'in', 'fun', 'function', 'match', 'with', 'if', 'then', 'else', 'type', 'module', 'open', 'struct', 'end', 'sig', 'of', 'true', 'false'],
    tests: ['**/test_*.ml', '**/*_test.ml'], ecosystems: ['opam'],
  },
  {
    id: 'c', label: 'C', aliases: ['h'], extensions: ['.c', '.h'], comments: C_LIKE, directives: true,
    keywords: ['int', 'char', 'void', 'long', 'short', 'float', 'double', 'unsigned', 'signed', 'struct', 'union', 'enum', 'typedef', 'static', 'const',
      'extern', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'sizeof', 'NULL'],
    tests: ['**/test_*.c', '**/*_test.c'], ecosystems: ['ConanCenter'],
  },
  {
    id: 'cpp', label: 'C++', aliases: ['c++', 'cxx', 'hpp'], extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], comments: C_LIKE, directives: true,
    keywords: ['class', 'struct', 'namespace', 'template', 'typename', 'public', 'private', 'protected', 'virtual', 'override', 'const', 'auto', 'if', 'else',
      'for', 'while', 'switch', 'case', 'return', 'new', 'delete', 'nullptr', 'true', 'false', 'using', 'static', 'void', 'int', 'try', 'catch', 'throw'],
    tests: ['**/*_test.cpp', '**/*_test.cc', '**/test_*.cpp'], ecosystems: ['ConanCenter'],
  },
  {
    id: 'lua', label: 'Lua', aliases: [], extensions: ['.lua'], comments: { line: ['--'], block: [['--[[', ']]']] },
    keywords: ['local', 'function', 'end', 'if', 'then', 'else', 'elseif', 'for', 'in', 'do', 'while', 'repeat', 'until', 'return', 'nil', 'true', 'false', 'and', 'or', 'not'],
    tests: ['**/*_spec.lua', '**/*_test.lua'], ecosystems: [],
  },
  {
    id: 'perl', label: 'Perl', aliases: ['pl'], extensions: ['.pl', '.pm', '.t'], comments: HASH,
    keywords: ['my', 'our', 'sub', 'use', 'package', 'if', 'elsif', 'else', 'unless', 'foreach', 'for', 'while', 'return', 'require', 'undef'],
    tests: ['**/*.t'], ecosystems: [],
  },
  {
    id: 'r', label: 'R', aliases: ['rlang'], extensions: ['.r'], comments: HASH,
    keywords: ['function', 'if', 'else', 'for', 'while', 'repeat', 'return', 'library', 'NULL', 'TRUE', 'FALSE', 'NA', 'in'],
    tests: ['**/test-*.R', '**/test_*.R'], ecosystems: ['CRAN'],
  },
  {
    id: 'julia', label: 'Julia', aliases: ['jl'], extensions: ['.jl'], comments: { line: ['#'], block: [['#=', '=#']] },
    keywords: ['function', 'end', 'module', 'using', 'import', 'struct', 'mutable', 'if', 'elseif', 'else', 'for', 'while', 'return', 'let', 'begin', 'true', 'false', 'nothing'],
    tests: ['**/runtests.jl'], ecosystems: [],
  },
  {
    id: 'zig', label: 'Zig', aliases: [], extensions: ['.zig'], comments: { line: ['//'], block: [] },
    keywords: ['const', 'var', 'fn', 'pub', 'struct', 'enum', 'union', 'if', 'else', 'while', 'for', 'switch', 'return', 'try', 'catch', 'defer', 'null', 'true', 'false', 'test'],
    tests: [], ecosystems: [],
  },
  {
    id: 'nim', label: 'Nim', aliases: [], extensions: ['.nim'], comments: { line: ['#'], block: [['#[', ']#']] },
    keywords: ['proc', 'func', 'let', 'var', 'const', 'type', 'object', 'if', 'elif', 'else', 'for', 'while', 'return', 'import', 'nil', 'true', 'false'],
    tests: ['**/t*.nim'], ecosystems: [],
  },
  {
    id: 'crystal', label: 'Crystal', aliases: ['cr'], extensions: ['.cr'], comments: HASH,
    keywords: ['def', 'end', 'class', 'struct', 'module', 'if', 'elsif', 'else', 'case', 'when', 'while', 'return', 'require', 'nil', 'true', 'false'],
    tests: ['**/*_spec.cr'], ecosystems: [],
  },
  {
    id: 'gleam', label: 'Gleam', aliases: [], extensions: ['.gleam'], comments: { line: ['//'], block: [] },
    keywords: ['fn', 'pub', 'let', 'case', 'type', 'import', 'const', 'use', 'assert', 'todo', 'True', 'False'],
    tests: ['**/*_test.gleam'], ecosystems: ['Hex'],
  },
  {
    id: 'apex', label: 'Apex', aliases: ['salesforce'], extensions: ['.cls', '.trigger'], comments: C_LIKE,
    keywords: ['public', 'private', 'global', 'class', 'interface', 'static', 'void', 'if', 'else', 'for', 'while', 'return', 'new', 'null', 'true', 'false', 'try', 'catch', 'trigger'],
    tests: ['**/?*Test.cls'], ecosystems: [],
  },
  {
    id: 'shell', label: 'Shell', aliases: ['bash', 'sh', 'zsh'], extensions: ['.sh', '.bash', '.zsh'], comments: HASH,
    keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'export', 'local'],
    tests: ['**/*.bats'], ecosystems: [], tooling: true,
  },
  {
    id: 'powershell', label: 'PowerShell', aliases: ['ps1', 'pwsh'], extensions: ['.ps1', '.psm1', '.psd1'], comments: { line: ['#'], block: [['<#', '#>']] },
    keywords: ['function', 'param', 'if', 'elseif', 'else', 'foreach', 'for', 'while', 'switch', 'return', 'try', 'catch', 'finally', 'throw', '$true', '$false', '$null'],
    tests: ['**/*.Tests.ps1'], ecosystems: [], tooling: true,
  },
  {
    id: 'sql', label: 'SQL', aliases: ['plsql', 'tsql', 'postgresql', 'mysql'], extensions: ['.sql'], comments: { line: ['--'], block: [['/*', '*/']] },
    keywords: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'JOIN', 'ON', 'AND', 'OR', 'NOT',
      'NULL', 'AS', 'GROUP', 'BY', 'ORDER', 'VALUES', 'BEGIN', 'END', 'FUNCTION', 'RETURNS', 'select', 'from', 'where', 'insert', 'update', 'delete', 'create', 'table'],
    tests: [], ecosystems: [],
  },
  {
    id: 'solidity', label: 'Solidity', aliases: ['sol'], extensions: ['.sol'], comments: C_LIKE,
    keywords: ['contract', 'function', 'modifier', 'event', 'struct', 'mapping', 'public', 'private', 'external', 'internal', 'view', 'pure', 'payable',
      'returns', 'return', 'if', 'else', 'for', 'while', 'require', 'emit', 'true', 'false'],
    tests: ['**/*.t.sol'], ecosystems: [],
  },
  {
    id: 'cobol', label: 'COBOL', aliases: ['cbl'], extensions: ['.cbl', '.cob', '.cpy'], comments: { line: ['*>'], block: [] },
    keywords: ['IDENTIFICATION', 'DIVISION', 'PROGRAM-ID', 'PROCEDURE', 'DATA', 'WORKING-STORAGE', 'SECTION', 'MOVE', 'TO', 'IF', 'ELSE', 'END-IF', 'PERFORM',
      'DISPLAY', 'CALL', 'STOP', 'RUN'],
    tests: [], ecosystems: [],
  },
  {
    id: 'abap', label: 'ABAP', aliases: [], extensions: ['.abap'], comments: { line: ['"'], block: [] },
    keywords: ['DATA', 'TYPES', 'METHOD', 'ENDMETHOD', 'CLASS', 'ENDCLASS', 'IF', 'ELSE', 'ENDIF', 'LOOP', 'ENDLOOP', 'SELECT', 'FROM', 'WHERE', 'RETURN'],
    tests: [], ecosystems: [],
  },
  {
    id: 'pascal', label: 'Pascal / Delphi', aliases: ['delphi', 'object pascal'], extensions: ['.pas', '.dpr', '.pp'], comments: { line: ['//'], block: [['{', '}'], ['(*', '*)']] },
    keywords: ['program', 'unit', 'uses', 'begin', 'end', 'procedure', 'function', 'var', 'const', 'type', 'if', 'then', 'else', 'for', 'to', 'do', 'while',
      'repeat', 'until', 'case', 'of', 'class', 'nil', 'True', 'False'],
    tests: ['**/Test*.pas'], ecosystems: [],
  },
  {
    id: 'fortran', label: 'Fortran', aliases: ['f90'], extensions: ['.f90', '.f95', '.f03', '.f', '.for'], comments: { line: ['!'], block: [] },
    keywords: ['program', 'end', 'subroutine', 'function', 'module', 'use', 'implicit', 'none', 'integer', 'real', 'if', 'then', 'else', 'do', 'call', 'return'],
    tests: [], ecosystems: [],
  },
  {
    id: 'ada', label: 'Ada', aliases: [], extensions: ['.adb', '.ads'], comments: { line: ['--'], block: [] },
    keywords: ['procedure', 'function', 'package', 'body', 'is', 'begin', 'end', 'if', 'then', 'else', 'loop', 'for', 'while', 'return', 'with', 'use', 'type', 'null'],
    tests: [], ecosystems: [],
  },
  {
    id: 'matlab', label: 'MATLAB', aliases: ['octave'], extensions: ['.mlx'], comments: { line: ['%'], block: [['%{', '%}']] },
    keywords: ['function', 'end', 'if', 'elseif', 'else', 'for', 'while', 'switch', 'case', 'otherwise', 'return', 'try', 'catch'],
    tests: [], ecosystems: [],
  },
  {
    id: 'vb', label: 'Visual Basic (VBA, VB6)', aliases: ['vba', 'vb6', 'vbscript'], extensions: ['.bas', '.vbs', '.frm'], comments: { line: ["'"], block: [] },
    keywords: ['Sub', 'Function', 'End', 'Dim', 'As', 'If', 'Then', 'Else', 'For', 'Next', 'While', 'Wend', 'Set', 'Call', 'Private', 'Public', 'True', 'False', 'Nothing'],
    tests: [], ecosystems: [],
  },
  {
    id: 'terraform', label: 'Terraform / HCL', aliases: ['hcl', 'tf'], extensions: ['.tf', '.tfvars', '.hcl'], comments: { line: ['#', '//'], block: [['/*', '*/']] },
    keywords: ['resource', 'data', 'variable', 'output', 'module', 'provider', 'locals', 'terraform', 'true', 'false', 'null'],
    tests: ['**/*.tftest.hcl'], ecosystems: [], tooling: true,
  },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));
export const languageById = (id: string): LanguageDef | undefined => BY_ID.get(id as LanguageId);
export const isLanguageId = (v: unknown): v is LanguageId => typeof v === 'string' && BY_ID.has(v as LanguageId);
/** a language from a name people write (`C#`, `golang`, `ts`), or undefined */
export function languageByName(name: string): LanguageDef | undefined {
  const n = name.trim().toLowerCase();
  return LANGUAGES.find((l) => l.id === n || l.label.toLowerCase() === n || l.aliases.includes(n));
}
