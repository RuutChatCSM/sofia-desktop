export type MessageReference = {
  id: string;
  kind: "file" | "folder" | "repository";
  workspaceId: string;
  path: string;
  label: string;
};

// A readable, self-contained transport representation survives engines that
// persist only text. UI rendering and context resolution share this parser.
export const MESSAGE_REFERENCE_PATTERN = /\[(File|Folder|Repository): ("(?:[^"\\]|\\.)*")\]/g;

export function createMessageReference(path: string, workspaceId = "", workspaceRoot = ""): MessageReference {
  if (workspaceRoot && !/^(?:[\\/]|[a-zA-Z]:[\\/])/.test(path)) {
    path = `${workspaceRoot.replace(/[\\/]+$/, "")}/${path}`;
  }
  const kind = /[\\/]$/.test(path) ? "folder" : "file";
  return {
    id: `${workspaceId}:${kind}:${path}`,
    kind,
    workspaceId,
    path,
    label: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path,
  };
}

export function serializeMessageReference(reference: MessageReference): string {
  const kind = reference.kind[0].toUpperCase() + reference.kind.slice(1);
  return `[${kind}: ${JSON.stringify(reference.path)}]`;
}

export function parseMessageReference(token: string, workspaceId = ""): MessageReference | null {
  const match = token.match(/^\[(File|Folder|Repository): ("(?:[^"\\]|\\.)*")\]$/);
  if (!match) return null;
  try {
    const path: unknown = JSON.parse(match[2]);
    if (typeof path !== "string" || !path.trim()) return null;
    const reference = createMessageReference(path, workspaceId);
    reference.kind = match[1] === "Repository" ? "repository" : match[1] === "Folder" ? "folder" : "file";
    reference.id = `${workspaceId}:${reference.kind}:${path}`;
    return reference;
  } catch {
    return null;
  }
}

export function messageReferences(text: string, workspaceId: string): MessageReference[] {
  return [...text.matchAll(MESSAGE_REFERENCE_PATTERN)].flatMap((match) => {
    const reference = parseMessageReference(match[0], workspaceId);
    return reference ? [reference] : [];
  });
}
