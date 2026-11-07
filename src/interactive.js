import { createInterface } from "node:readline";
import { rankResults } from "./scan.js";
import { normalizeSort } from "./schema.js";
import { formatExplanation, formatPrecise, relativeName } from "./format.js";
import { openInEditor } from "./editor.js";

const PAGE_SIZE = 10;
const HELP = "Enter a result number to inspect · n/p next/previous page · /text filter (/ clears) · s metric sort · q quit";
const DETAIL_HELP = "o opens this entry · o N opens finding N · b back to rankings · q quit";

export async function exploreReport(report, config, io = {}) {
  const input = io.stdin || process.stdin;
  const output = io.stdout || process.stdout;
  const errors = io.stderr || process.stderr;
  let rl;
  let prompt = io.prompt;
  if (!prompt) {
    rl = createInterface({ input, output, terminal: true });
    rl.on("SIGINT", () => rl.close());
    const lines = rl[Symbol.asyncIterator]();
    prompt = async (text) => {
      rl.setPrompt(text);
      rl.prompt();
      const next = await lines.next();
      return next.done ? null : next.value;
    };
  }
  let filter = "";
  let sort = config.sort;
  let page = 0;
  let selected = null;
  const ranked = () => rankResults(report.results.filter((item) =>
    relativeName(item, config).toLowerCase().includes(filter.toLowerCase())), { ...config, sort, top: 0 }).shown;
  const showList = () => {
    const entries = ranked();
    const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    output.write(`\nReact complexity explorer · ${entries.length} entries · sort ${sort}${filter ? ` · filter "${filter}"` : ""}\n`);
    output.write(`Page ${page + 1}/${pages}\n`);
    for (let i = page * PAGE_SIZE; i < Math.min(entries.length, (page + 1) * PAGE_SIZE); i++) {
      const item = entries[i];
      output.write(`  ${String(i + 1).padStart(3)}  score ${formatPrecise(item.score).padStart(7)}  ${relativeName(item, config)}  (${item.findings?.length || 0} findings)\n`);
    }
    if (!entries.length) output.write("No matching entries. Use / to clear the filter, or q to quit.\n");
    output.write(`${HELP}\n`);
  };
  try {
    showList();
    while (true) {
      const response = await prompt(selected ? "detail> " : "explore> ");
      if (response === null || response === undefined) break;
      const command = response.trim();
      if (command === "q" || command === "quit") break;
      if (selected) {
        if (command === "b" || command === "back") {
          selected = null;
          showList();
        } else if (/^o(?:\s+\d+)?$/.test(command)) {
          const number = command === "o" ? null : Number(command.slice(1).trim());
          const finding = number === null ? null : selected.findings?.[number - 1];
          if (number !== null && (!Number.isSafeInteger(number) || !finding)) {
            errors.write("Choose a valid finding number from this entry.\n");
            continue;
          }
          const location = finding?.location.start || selected.location?.start || { line: 1, column: 1 };
          const wasRaw = input.isRaw;
          rl?.pause();
          if (rl && wasRaw) input.setRawMode(false);
          try {
            await (io.openEditor || openInEditor)(selected.file, location, { editor: io.editor, cwd: config.cwd });
            output.write(`Editor launched: ${relativeName({ file: selected.file }, config)}:${location.line}:${location.column}\n`);
          } catch (error) {
            errors.write(`${error.message}\n`);
          } finally {
            if (rl && !rl.closed && wasRaw) input.setRawMode(true);
            rl?.resume();
          }
        } else output.write(`${DETAIL_HELP}\n`);
        continue;
      }
      if (/^\d+$/.test(command)) {
        const number = Number(command);
        selected = Number.isSafeInteger(number) ? ranked()[number - 1] : null;
        if (!selected) errors.write("Choose a valid result number.\n");
        else {
          output.write(`\n${formatExplanation(selected, { ...config, numberFindings: true })}\n${DETAIL_HELP}\n`);
        }
      } else if (command.startsWith("/")) {
        filter = command.slice(1).trim();
        page = 0;
        showList();
      } else if (command.startsWith("s ")) {
        try {
          sort = normalizeSort(command.slice(2).trim());
          page = 0;
          showList();
        } catch (error) {
          errors.write(`${error.message}\n`);
        }
      } else if (command === "n" || command === "p") {
        page = Math.max(0, page + (command === "n" ? 1 : -1));
        showList();
      } else output.write(`${HELP}\n`);
    }
  } finally {
    rl?.close();
  }
}
