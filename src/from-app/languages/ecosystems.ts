// Package ecosystems: their lock files, by OSV's ecosystem names (https://ossf.github.io/osv-schema/#affectedpackage-field).
// `rabbinatix scan` reads the lock files marked `read` itself (rabbinatix-cli/src/scan/deps.ts); with OSV-Scanner
// installed it hands every lock file to it instead, which reads all of these. CocoaPods has no data of its own in OSV:
// the CLI looks up each pod's source repository (the CocoaPods CDN) and checks that in OSV's Swift data (SwiftURL),
// whichever way the rest is checked.

export interface EcosystemDef {
  /** OSV's name */
  id: string;
  label: string;
  /** lock or manifest file names (exact), or a pattern for a family of names */
  lockFiles: (string | RegExp)[];
  /** read by the CLI itself (otherwise only through OSV-Scanner) */
  read: boolean;
}

export const ECOSYSTEMS: readonly EcosystemDef[] = [
  { id: 'npm', label: 'npm', lockFiles: ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'], read: true },
  { id: 'PyPI', label: 'PyPI', lockFiles: [/^requirements[^/]*\.txt$/, 'poetry.lock', 'Pipfile.lock'], read: true },
  { id: 'Go', label: 'Go modules', lockFiles: ['go.sum'], read: true },
  { id: 'RubyGems', label: 'RubyGems', lockFiles: ['Gemfile.lock'], read: true },
  { id: 'crates.io', label: 'crates.io', lockFiles: ['Cargo.lock'], read: true },
  { id: 'Packagist', label: 'Packagist (Composer)', lockFiles: ['composer.lock'], read: true },
  { id: 'NuGet', label: 'NuGet', lockFiles: ['packages.lock.json'], read: true },
  { id: 'Maven', label: 'Maven / Gradle', lockFiles: ['gradle.lockfile', 'libs.versions.toml'], read: true },
  { id: 'Pub', label: 'Pub (Dart, Flutter)', lockFiles: ['pubspec.lock'], read: true },
  { id: 'Hex', label: 'Hex (Elixir, Erlang)', lockFiles: ['mix.lock', 'rebar.lock'], read: false },
  { id: 'SwiftURL', label: 'Swift Package Manager', lockFiles: ['Package.resolved'], read: true },
  // not an OSV ecosystem: checked as its source repository's SwiftURL package (rabbinatix-cli/src/scan/deps.ts podRepos)
  { id: 'CocoaPods', label: 'CocoaPods (through each pod\'s repository)', lockFiles: ['Podfile.lock'], read: true },
  { id: 'Hackage', label: 'Hackage (Haskell)', lockFiles: ['cabal.project.freeze', 'stack.yaml.lock'], read: false },
  { id: 'CRAN', label: 'CRAN (R)', lockFiles: ['renv.lock'], read: false },
  { id: 'ConanCenter', label: 'Conan (C, C++)', lockFiles: ['conan.lock'], read: false },
  { id: 'opam', label: 'opam (OCaml)', lockFiles: [/\.opam\.locked$/], read: false },
];

const base = (file: string) => file.slice(file.replace(/\\/g, '/').lastIndexOf('/') + 1);

/** the ecosystem a lock file belongs to (by its name), or undefined */
export function ecosystemOfLockFile(file: string): EcosystemDef | undefined {
  const b = base(file);
  return ECOSYSTEMS.find((e) => e.lockFiles.some((f) => (typeof f === 'string' ? f === b : f.test(b))));
}
