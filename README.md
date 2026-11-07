# react-complexity

A Node.js CLI and library for ranking React files and top-level components by configurable AST complexity. Requires Node.js 20 or newer.

```sh
npm ci
npm start -- path/to/project/src --top 10
npm start -- path/to/project/src --by component
npm start -- path/to/project/src/App.tsx --explain
npm start -- --help
```

Scores combine control flow, JSX nesting, hooks, effects, size, and other signals:

```text
score = sum(max(0, metric - baseline) * weight)
density = score / sloc * 100
```

Use `--init` to generate a configuration file. Weights, baselines, and finding thresholds (`noteThresholds`) can be customized there. Tests, stories, generated directories, and gitignored files are excluded by default.

## Explore locally and jump to your editor

```sh
node bin/react-complexity.js path/to/project/src --interactive --by component
node bin/react-complexity.js path/to/project/src -i --editor nvim
```

Interactive mode is an opt-in, **numbered command interface**: type a command and press Enter. It keeps the output in your terminal's scrollback rather than taking over the screen.

| In the rankings | Action |
| --- | --- |
| `1`, `2`, … | Inspect a ranked file/component and its score breakdown |
| `n` / `p` | Next / previous page (10 entries per page) |
| `/Dashboard` | Filter by file path or component name, case-insensitively |
| `/` | Clear the filter |
| `s density` | Sort by density, score, file, or another supported metric |
| `q` | Quit |

Inside an entry, findings are numbered:

| In the detail view | Action |
| --- | --- |
| `o` | Open the component's start, or line 1 for a file/module row |
| `o 2` | Open finding 2 at its exact line and column |
| `b` | Return to the rankings |
| `q` | Quit |

`Ctrl-C` or EOF also exits cleanly. A failed editor launch prints a message and leaves the explorer open. Terminal editors take over temporarily; the explorer resumes when they exit. GUI editors launch separately, without waiting for their window to close.

Editor selection uses `--editor`, then `VISUAL`, then `EDITOR`, falling back to VS Code (`code`). Supported commands are `code`, `code-insiders`, `cursor`, `zed`, `subl`/`sublime_text`, `vim`, `nvim`, `vi`, and `nano`. You can specify the full executable path or a command with arguments, e.g. `--editor "nvim -f"`; executable paths containing spaces must be quoted inside environment command strings. Commands are not shell expressions: redirection, pipelines, shell aliases, and variable expansion are not evaluated.

On Windows, VS Code and Cursor are resolved to their installed `.exe`, avoiding `.cmd` shell shims. If automatic detection fails, use `--editor` with the full `Code.exe` / `Cursor.exe` path. Other batch editor launchers are not supported.

The explorer pages through **all results meeting `--min-score`**, regardless of `--top`, and honors the initial `--sort` and `--reverse`. It displays a snapshot, not a live view: rerun after editing. Baseline comparison can be combined with `--interactive`; the change report appears first, then you can browse current results. Existing failure thresholds and baseline-regression exit codes still apply when you quit.

Interactive mode requires terminal input/output and the `table` format. Ordinary commands never prompt, including when piped; omit `--interactive` for JSON, CSV, Markdown, or list output.

## Source-linked findings

Single-file explanations (or directory scans with `--explain`) include findings with file, line, column, source evidence, and contextual suggestions. Findings cover:

- Nested component definitions, including arrow functions and common wrappers.
- Effects without dependency arrays.
- Inline functions passed as JSX props.
- JSX nesting reaching the configured `jsxDepth` note threshold.
- Functions reaching the `cognitive` or `maxFunctionLength` note thresholds.

For example:

```text
App.tsx:3:17 — Component Child is defined inside another component
  > const Child = () => <span/>;
  Consider moving it to module scope and passing its inputs as props; nested definitions can reset child state.
```

These are review signals, not confirmed defects. An inline callback can be the clearest implementation, and omitting an effect's dependency array can be intentional. Findings themselves do not add score penalties or affect exit codes; the configured metrics and limits do.

JSON reports (`--format json`) and library analysis results include a `findings` array:

```json
{
  "metric": "nestedComponents",
  "message": "Component Child is defined inside another component",
  "location": {
    "start": { "line": 3, "column": 17 },
    "end": { "line": 3, "column": 30 }
  },
  "suggestion": "Consider moving it to module scope and passing its inputs as props; nested definitions can reset child state.",
  "evidence": "const Child = () => <span/>;"
}
```

Lines and columns are one-based; end positions are exclusive. Evidence is the trimmed starting line, capped at 200 characters. Component findings belong to their component row; module-level findings belong to the `(module)` row.

## Accuracy and limitations

- React ESM named imports and namespace/default imports are resolved, including aliases. Local parameters and declarations shadow those imports. Unrelated object methods named `useEffect` are not React effects.
- Unbound `use*` calls and `React.use*` calls remain supported as snippet heuristics. Custom hooks are name-based. This is not full type analysis or inter-module data-flow analysis: CommonJS aliases, reassigned aliases, and arbitrary wrapper factories are not resolved.
- `maxProps` counts **explicitly destructured top-level props**, excluding rest properties. An opaque `props` parameter has an unknown shape and contributes 0, not a claim that the component takes no props. Type declarations and runtime usage are not used to infer that shape.
- Cognitive complexity is Sonar-style, not a guarantee of exact SonarSource conformance. Function findings include nested-function contributions.
- Recovered parse errors retain `parseError`, `partial: true`, and a warning on every affected component/module row. JSON also reports the error once per file, and `--strict` fails the scan. Scores from partial analysis may be incomplete.

Corrected detection can change existing scores. Review CI limits when upgrading rather than assuming score changes mean source-code regressions.

## Local baseline reports

Save a baseline from your project root before refactoring (optionally commit it for reuse):

```sh
node bin/react-complexity.js src --save-baseline complexity-baseline.json
```

Compare future scans using the same paths and analysis settings:

```sh
node bin/react-complexity.js src --compare-baseline complexity-baseline.json
node bin/react-complexity.js src --compare-baseline complexity-baseline.json --baseline-tolerance 2
node bin/react-complexity.js src --compare-baseline complexity-baseline.json --format json
```

For component-level tracking, pass `--by component` to **both** commands.

- **New:** an entry absent from the baseline, compared against a score of 0.
- **Worsened / improved:** an existing entry whose score increased / decreased.
- **Removed:** a baseline entry no longer present in the analyzed results.
- **Unchanged:** the score is identical; counted in the summary, omitted from change rows.

Comparison exits **1** if any individual score increase exceeds the tolerance (default 0), and **0** otherwise. New entries also fail when their score exceeds the tolerance. Equality is allowed; improvements elsewhere do not offset regressions. Existing `--max-score` / `--fail-on` checks still apply independently. Invalid/incompatible reports and incomplete scans also exit 1.

Baseline files contain a schema version, analyzer/dependency versions, scoring and scan settings, and all file/component scores. They are deliberately separate from ordinary `--format json` reports. Saving and comparison use **all analyzed entries**, regardless of `--top`, `--min-score`, sorting, or presentation format. Comparison tables, CSV, Markdown, and lists show changes rather than ordinary rankings. JSON retains the normal report and adds `comparison` with `summary`, `changes`, and `tolerance`.

Paths are relative to the working directory and use `/`, so a committed report works in another checkout. Run commands from the same project-relative location. Identity is file path + entry kind + component name; renames appear as removed/new entries. Changes to gitignore contents or source files becoming non-React can also make entries disappear; review removals rather than assuming every removal is a deletion.

Different scoring/scan settings (including scan roots and file/component mode) or analyzer/dependency versions are rejected. Display settings, finding thresholds, and CI limits may change without invalidating comparisons. Pin dependencies with `npm ci` for reproducible results.

After reviewing intentional changes, explicitly refresh the baseline:

```sh
node bin/react-complexity.js src --save-baseline complexity-baseline.json --force
```

Comparison never modifies the baseline. Saving refuses to replace an existing file unless `--force` is supplied, and neither action accepts incomplete scans with parse/read errors or skipped paths. Saving and comparing are separate operations; `--baseline` continues to mean a metric's scoring allowance, not a report file.

The library also supports `analyze("src", { cwd, saveBaseline: "baseline.json" })` and `analyze("src", { cwd, compareBaseline: "baseline.json", baselineTolerance: 2 })`. Check `result.comparison.summary.regressions` in your integration; the library does not set a process exit code. Lower-level `createBaseline`, `readBaseline`, `writeBaseline`, and `compareBaseline` helpers are exported as well.

## Checks

```sh
npm test
```
