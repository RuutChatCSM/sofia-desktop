/** Literal-only decoder. Never evaluates tool input, identifiers or expressions. */
function decodeLiteral(raw: string): unknown {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(raw[cursor] ?? "") && cursor < raw.length) cursor++; };
  function value(): unknown {
    whitespace();
    const ch = raw[cursor];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch; cursor++; let text = "";
      while (cursor < raw.length) {
        const current = raw[cursor++];
        if (current === quote) return text;
        if (quote === "`" && current === "$" && raw[cursor] === "{") throw new Error("Dynamic template");
        if (current !== "\\") { text += current; continue; }
        const escape = raw[cursor++];
        const escapes: Record<string, string> = {n:"\n",r:"\r",t:"\t",b:"\b",f:"\f",v:"\v", "0":"\0"};
        if (escape === "u" || escape === "x") {
          const count = escape === "u" ? 4 : 2; const hex = raw.slice(cursor,cursor+count);
          if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex)) throw new Error("Invalid escape");
          text += String.fromCharCode(parseInt(hex,16)); cursor += count;
        } else if (escape === "\n") { /* continuation */ }
        else text += escapes[escape] ?? escape;
      }
      throw new Error("Unclosed string");
    }
    if (ch === "{" || ch === "[") {
      const object = ch === "{"; cursor++; const result: Record<string,unknown> = {}; const list: unknown[] = [];
      whitespace();
      while (raw[cursor] !== (object ? "}" : "]")) {
        if (object) {
          whitespace(); let key: unknown;
          if (/["'`]/.test(raw[cursor] ?? "")) key = value();
          else { const match = raw.slice(cursor).match(/^[A-Za-z_$][\w$]*/); if (!match) throw new Error("Key expression"); key = match[0]; cursor += match[0].length; }
          whitespace(); if (raw[cursor++] !== ":") throw new Error("Missing colon");
          Object.defineProperty(result,String(key),{value:value(), enumerable:true, configurable:true});
        } else list.push(value());
        whitespace(); if (raw[cursor] !== ",") break; cursor++; whitespace();
      }
      if (raw[cursor++] !== (object ? "}" : "]")) throw new Error("Unclosed container");
      return object ? result : list;
    }
    const match = raw.slice(cursor).match(/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w$])/);
    if (!match) throw new Error("Non-literal expression"); cursor += match[0].length; return JSON.parse(match[0]);
  }
  const decoded = value(); whitespace(); if (cursor !== raw.length) throw new Error("Trailing expression"); return decoded;
}

function skipQuoted(raw: string, start: number): number {
  const quote = raw[start];
  for (let index = start + 1; index < raw.length; index++) {
    if (raw[index] === "\\") { index++; continue; }
    if (raw[index] === quote) return index + 1;
  }
  return raw.length;
}

function shellWords(command: string): string[] | null {
  if (/[$`<>|&\n]/.test(command)) return null;
  const words: string[] = [];
  for (let index = 0; index < command.length;) {
    if (/\s/.test(command[index])) {index++;continue;}
    let word = "";
    while (index < command.length && !/\s/.test(command[index])) {
      if (command[index] === '"' || command[index] === "'") {
        const end = skipQuoted(command,index);
        try {word += String(decodeLiteral(command.slice(index,end)));} catch {return null;}
        index = end;
      } else if (command[index] === "\\") {index++;if(index >= command.length)return null;word += command[index++];}
      else word += command[index++];
    }
    words.push(word);
  }
  return words;
}

export function commandActions(command: string): Array<Record<string,unknown>> {
  const segments: string[] = []; let start = 0;
  for (let index = 0; index < command.length; index++) {
    if (/["'`]/.test(command[index])) {index = skipQuoted(command,index)-1;continue;}
    if (command[index] === ";") {segments.push(command.slice(start,index));start=index+1;}
  }
  segments.push(command.slice(start));
  const actions: Array<Record<string,unknown>> = [];
  for (const segment of segments) {
    const words = shellWords(segment.trim()); if (!words?.length) return [];
    const [name,...args] = words;
    if (["cat","head","tail"].includes(name)) {
      const paths = args.filter(arg=>!arg.startsWith("-") && !/^\d+$/.test(arg));
      if (!paths.length) return [];
      actions.push(...paths.map(path=>({type:"read",command:segment.trim(),path})));
    } else if (name === "sed" && args[0] === "-n" && args.length === 3) actions.push({type:"read",command:segment.trim(),path:args[2]});
    else if (["rg","grep"].includes(name)) {
      const positional = args.filter(arg=>!arg.startsWith("-"));
      if (args.some(arg=>arg.startsWith("-") && !["-n","-i","-l","-F","-S","--files","--hidden"].includes(arg))) return [];
      if (args.includes("--files")) actions.push({type:"listFiles",command:segment.trim(),path:positional[0] ?? "."});
      else if (positional.length) actions.push({type:"search",command:segment.trim(),query:positional[0],path:positional[1] ?? "."});
      else return [];
    } else if (name === "ls") actions.push({type:"listFiles",command:segment.trim(),path:args.find(arg=>!arg.startsWith("-")) ?? "."});
    else return [];
  }
  return actions;
}

export function parseExecActions(raw: string): Array<Record<string,unknown>> {
  const actions: Array<Record<string,unknown>> = [];
  // Bound work on imported text; comments and quoted code are never treated as calls.
  raw = raw.slice(0, 1024 * 1024);
  for (let index = 0; index < raw.length && actions.length < 200; index++) {
    if (/["'`]/.test(raw[index])) { index = skipQuoted(raw,index) - 1; continue; }
    if (raw.startsWith("//",index)) { const end = raw.indexOf("\n",index); index = end < 0 ? raw.length : end; continue; }
    if (raw.startsWith("/*",index)) { const end = raw.indexOf("*/",index+2); index = end < 0 ? raw.length : end+1; continue; }
    const match = raw.slice(index).match(/^tools\.([A-Za-z_$][\w$]*)\s*\(/);
    if (!match || (index > 0 && /[\w$.]/.test(raw[index-1]))) continue;
    const start = index + match[0].length; let end = start; let depth = 1;
    for (; end < raw.length; end++) {
      if (/["'`]/.test(raw[end])) { end = skipQuoted(raw,end) - 1; continue; }
      if (raw[end] === "(") depth++;
      if (raw[end] === ")" && --depth === 0) break;
    }
    if (depth !== 0) break;
    const input = raw.slice(start,end).trim(); let args: unknown;
    try { args = decodeLiteral(input); } catch { args = {rawInput:input}; }
    const action: Record<string,unknown> = {tool:match[1],arguments:args};
    if (match[1] === "exec_command" && args && typeof args === "object" && "cmd" in args && typeof args.cmd === "string") {
      action.command = args.cmd; action.commandActions = commandActions(args.cmd);
    }
    actions.push(action); index = end;
  }
  return actions;
}
