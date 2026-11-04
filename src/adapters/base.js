/**
 * base.js
 *
 * Documents the language-adapter interface. Every pipeline phase that used to hardcode
 * JS/npm/ESLint logic now calls into whichever adapter `resolveAdapter(config)` returns,
 * keyed by `config.language` (default "javascript").
 *
 * Every method EXCEPT `sourceExtensions` and `stripComments` may be null on an adapter to
 * mean "this language has no such concept" (e.g. C++ has no dependency manifest; C++/C#
 * have no npm-style named scripts). Callers must treat a null method as a capability gap,
 * not an error — see DIAGNOSTICS_SHAPE below for the one shape every non-null `lint`/`build`
 * result must conform to.
 *
 * @typedef {Object} Diagnostics
 * @property {number} errors
 * @property {number} warnings
 * @property {string[]} messages          - all issues, friendly-named, most-frequent first
 * @property {string[]} errorMessages     - error-severity issues only, same format
 * @property {string[]} warningMessages   - warning-severity issues only, same format
 * @property {Object<string,number>} ruleCounts - raw rule/diagnostic-code -> count
 *
 * @typedef {Object} Project
 * @property {string} dir                  - project root (a package.json/.csproj/CMakeLists.txt dir)
 * @property {string} type                 - adapter-defined label, e.g. "npm", "csproj", "cmake", "makefile", "loose"
 * @property {string[]|null} buildCommand  - argv array (never a shell string), or null if not buildable
 * @property {string[]|null} runCommand    - argv array to execute the built/interpreted artifact, or null
 * @property {string|null} artifactPath    - path to the build output run_check/test_check should target
 * @property {boolean} [executable]        - csharp.js only: true if this project's OutputType is Exe/WinExe
 *           (vs. a class library or, conventionally, a test project) — lets run_check pick the actual
 *           console app out of a multi-project solution instead of defaulting to whichever project a
 *           .sln happens to list first.
 * @property {string[]} [sourceFiles]      - cpp.js "loose" projects only: the .cpp/.cc/.cxx files passed
 *           directly to the compiler (no build system at all — the common intro-submission case)
 * @property {string} [csprojPath]         - csharp.js only: absolute path to this project's .csproj,
 *           passed to `dotnet build`/`dotnet run --project`/`dotnet test`
 *
 * @typedef {Object} Adapter
 * @property {string} language
 * @property {string[]} sourceExtensions             - drives feature-detection file filtering everywhere
 * @property {(code: string) => string} stripComments - language comment/string-literal-aware stripping
 * @property {((code: string) => string) | null} [extractComments] - the inverse: only the comment
 *           text (docstrings included for Python), built from the same grammar as stripComments.
 *           Optional; analysis falls back to raw content when absent.
 * @property {((dir: string, packageCheckConfig: Object) => {found: boolean, passed: boolean, issues: string[]}) | null} checkManifest
 *           - validates the language's dependency manifest(s) against config.packageCheck; null for
 *             languages with no manifest concept (C++). Deliberately NOT a generic "read the manifest"
 *             method — each adapter owns its own manifest format(s) and comparison logic end to end.
 * @property {((dir: string, manifestPaths: string[]) => Set<string>) | null} extractUsedPackages
 *           - set of package/module names actually referenced in source (imports/requires/#include/using),
 *             used by the npm_package/package_usage mapping type and by checkManifest's "unused extra
 *             dependency" check.
 * @property {((files: string[], cwd: string, configOverride: string|null, config?: Object) => Promise<Diagnostics>) | null} lint
 * @property {((configsDir: string, labName: string, stepName: string|null, courseName?: string|null, repoRootOverride?: string|null) => string[]) | null} lintConfigCandidates
 *           - configsDir is normally the repo-root-level configs/ dir (shipped-default fallback is
 *             derived from it via configsDir/..); courseName, when given, is inserted as a path
 *             segment ONLY for the per-lab/per-step override candidates (configs/{course}/{lab}/...),
 *             not for the shipped default, which stays course-agnostic. repoRootOverride lets a
 *             caller point configsDir at a scratch directory (tests) while still resolving the
 *             shipped default against the real repo root.
 * @property {(dir: string, config?: Object) => Project[]} detectProject
 * @property {((project: Project, config?: Object) => Promise<{success: boolean, errors: string[]}>) | null} install
 * @property {(project: Project, config?: Object) => Promise<{success: boolean, errors: string[], artifacts: string[], artifactPath?: string}>} build
 *           - errors here is a string[] (human-readable messages), NOT the Diagnostics
 *             shape's numeric `errors` count — the two must never be spread together
 *             (both use the field name "errors" for a different type; see cpp.js's
 *             compileLoose()/build()/lint() split for the pattern: run the compiler once,
 *             format two distinct return shapes from the same underlying diagnostics).
 *             A language whose build step produces rich diagnostics (e.g. compiler
 *             warnings) surfaces those through `lint()`, not through `build()`.
 * @property {((project: Project, name: string) => Promise<{defined: boolean, ran: boolean, passed: boolean, error: string|null}>) | null} runScript
 * @property {((project: Project, config?: Object) => Promise<{total: number, passed: number, failures: string[], _failed?: number}>) | null} runTests
 *           - runs the language's test runner (pytest/dotnet test/CTest) and returns proportional
 *             pass/fail counts for the test_check mapping type; null for languages/labs with no
 *             test-runner integration yet (JS/TS explicitly set this to null — no test-runner
 *             integration exists for them, same as any other language that lacks the concept).
 *             csharp.js's runTests also sets `_failed` (the raw "Failed: N" count parsed from
 *             `dotnet test`'s summary line) — currently unused by any caller, kept for parity
 *             with the summary line rather than silently dropped.
 * @property {((config?: Object) => Promise<{available: boolean, hint: string}>) | null} preflight - toolchain availability check
 *
 * The optional trailing `config` parameter on lint/install/build/runTests/preflight is
 * the lab config object, carrying config.toolchains (machine-specific compiler/interpreter
 * paths — see local-config.json's "toolchains" section, merged in by bin/grade.js). JS/TS
 * adapters ignore it (Node/npm are the host runtime, always resolvable); Python/C++/C#
 * adapters use it to resolve their interpreter/compiler/SDK command.
 */

// Referenced by tests to catch adapter drift early — not used in production code paths.
export function isValidDiagnostics(d) {
    if (!d || typeof d !== 'object') return false;
    return typeof d.errors === 'number'
        && typeof d.warnings === 'number'
        && Array.isArray(d.messages)
        && Array.isArray(d.errorMessages)
        && Array.isArray(d.warningMessages)
        && typeof d.ruleCounts === 'object';
}

export const REQUIRED_ADAPTER_KEYS = ['language', 'sourceExtensions', 'stripComments', 'detectProject', 'build'];
