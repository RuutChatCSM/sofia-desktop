/** @jsxImportSource react */
import { Atom, Braces, Code2, Container, File, FileImage, FileText, Gem, GitBranch, Hash, Settings, Terminal, Music, Film } from "lucide-react";

export function fileType(path: string) {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (/^(dockerfile|\.dockerignore)/.test(name)) return "docker";
  if (/^\.git/.test(name)) return "git";
  if (/\.(md|mdx|markdown)$/.test(name)) return "markdown";
  if (/\.(json|jsonc)$/.test(name)) return "json";
  if (/\.(tsx|jsx)$/.test(name)) return "react";
  if (/\.(ts|mts|cts)$/.test(name)) return "typescript";
  if (/\.(js|mjs|cjs)$/.test(name)) return "javascript";
  if (/\.(rb|rake)$/.test(name) || /^(gemfile|rakefile)$/.test(name)) return "ruby";
  if (/\.(css|scss|less)$/.test(name)) return "css";
  if (/\.(yaml|yml|toml|ini|conf)$/.test(name)) return "config";
  if (/\.(sh|bash|zsh)$/.test(name)) return "shell";
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(name)) return "audio";
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(name)) return "video";
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico)$/.test(name)) return "image";
  if (/\.(py|rs|go|java|kt|swift|c|cpp|h|sql|html)$/.test(name)) return "code";
  return "file";
}

export function FileTypeIcon({ path }: { path: string }) {
  const kind = fileType(path);
  const common = "size-4 shrink-0 stroke-[1.5]";
  const icon = kind === "json" ? <Braces className={`${common} text-orange-400`} />
    : kind === "react" ? <Atom className={`${common} text-sky-400`} />
    : kind === "ruby" ? <Gem className={`${common} text-red-400`} />
    : kind === "markdown" ? <FileText className={`${common} text-emerald-400`} />
    : kind === "typescript" ? <span className="text-[10px] font-semibold text-sky-400">TS</span>
    : kind === "javascript" ? <span className="text-[10px] font-semibold text-yellow-400">JS</span>
    : kind === "css" ? <Hash className={`${common} text-violet-400`} />
    : kind === "config" ? <Settings className={`${common} text-orange-400`} />
    : kind === "shell" ? <Terminal className={`${common} text-emerald-400`} />
    : kind === "git" ? <GitBranch className={`${common} text-orange-500`} />
    : kind === "docker" ? <Container className={`${common} text-sky-400`} />
    : kind === "audio" ? <Music className={`${common} text-pink-400`} />
    : kind === "video" ? <Film className={`${common} text-violet-400`} />
    : kind === "image" ? <FileImage className={`${common} text-violet-400`} />
    : kind === "code" ? <Code2 className={`${common} text-sky-400`} /> : <File className={`${common} text-muted-foreground`} />;
  return <span aria-hidden="true" data-file-type={kind} className="flex size-4 shrink-0 items-center justify-center">{icon}</span>;
}
