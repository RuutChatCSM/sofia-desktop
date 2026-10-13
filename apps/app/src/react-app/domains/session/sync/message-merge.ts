import type { UIMessage } from "ai";

import { partText } from "@/lib/message-part-text";

type MessagePart = UIMessage["parts"][number];

function partIdentity(part: MessagePart): string | null {
  if ("toolCallId" in part && typeof part.toolCallId === "string") return `tool:${part.toolCallId}`;
  const metadata = "providerMetadata" in part ? part.providerMetadata : undefined;
  const engine = metadata?.engine;
  if (engine && typeof engine === "object" && "partId" in engine && typeof engine.partId === "string") {
    return `part:${engine.partId}`;
  }
  return null;
}

function mergePart(snapshot: MessagePart, cached: MessagePart): MessagePart {
  if (snapshot.type !== cached.type) return snapshot;
  // A lagging read cannot restart a tool that the stream already completed.
  if ("toolCallId" in snapshot && "state" in snapshot && "state" in cached) {
    const terminal = (state: unknown) => state === "output-available" || state === "output-error" || state === "output-denied";
    if (!terminal(snapshot.state) && terminal(cached.state)) return cached;
  }
  if ((snapshot.type === "text" || snapshot.type === "reasoning") &&
      (cached.type === "text" || cached.type === "reasoning") && partText(cached).length > partText(snapshot).length) {
    return { ...snapshot, text: partText(cached) };
  }
  return snapshot;
}

function mergeMessageParts(snapshotMessage: UIMessage, cachedMessage: UIMessage) {
  const cachedById = new Map<string, MessagePart>();
  for (const part of cachedMessage.parts) {
    const id = partIdentity(part);
    if (id) cachedById.set(id, part);
  }
  const consumed = new Set<MessagePart>();
  const parts = snapshotMessage.parts.map((part, index) => {
    const id = partIdentity(part);
    const positional = cachedMessage.parts[index];
    // Positional matching is only valid for legacy parts without identities.
    const cached = id ? cachedById.get(id) : positional && !partIdentity(positional) ? positional : undefined;
    if (!cached) return part;
    consumed.add(cached);
    return mergePart(part, cached);
  });
  for (let index = 0; index < cachedMessage.parts.length; index += 1) {
    const part = cachedMessage.parts[index];
    if (consumed.has(part)) continue;
    const id = partIdentity(part);
    if (!id && index < snapshotMessage.parts.length) continue;
    // Insert unseen live blocks before their next known sibling rather than
    // appending them after a final answer that arrived in the snapshot.
    let before = -1;
    for (let next = index + 1; next < cachedMessage.parts.length; next += 1) {
      const nextId = partIdentity(cachedMessage.parts[next]);
      if (!nextId) continue;
      before = parts.findIndex(candidate => partIdentity(candidate) === nextId);
      if (before >= 0) break;
    }
    parts.splice(before < 0 ? parts.length : before, 0, part);
  }
  return parts;
}

function mergeSnapshotMessageWithCached(snapshotMessage: UIMessage, cachedMessage: UIMessage): UIMessage {
  const metadata = snapshotMessage.metadata ?? cachedMessage.metadata;

  return {
    ...snapshotMessage,
    ...(metadata === undefined ? {} : { metadata }),
    parts: mergeMessageParts(snapshotMessage, cachedMessage),
  };
}

function messageCreated(message: UIMessage) {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("engine" in metadata)) return null;

  const engine = metadata.engine;
  if (!engine || typeof engine !== "object" || !("created" in engine)) return null;

  const created = engine.created;
  return typeof created === "number" ? created : null;
}

function insertMessageByChronology(messages: UIMessage[], message: UIMessage, sourceOrder: UIMessage[]) {
  const created = messageCreated(message);
  if (created !== null) {
    const timestampIndex = messages.findIndex((existing) => {
      const existingCreated = messageCreated(existing);
      return existingCreated !== null && existingCreated > created;
    });
    if (timestampIndex !== -1) {
      messages.splice(timestampIndex, 0, message);
      return;
    }
  }

  const sourceIndex = sourceOrder.findIndex((item) => item.id === message.id);
  if (sourceIndex !== -1) {
    for (let index = sourceIndex + 1; index < sourceOrder.length; index += 1) {
      const nextIndex = messages.findIndex((item) => item.id === sourceOrder[index]?.id);
      if (nextIndex !== -1) {
        messages.splice(nextIndex, 0, message);
        return;
      }
    }

    for (let index = sourceIndex - 1; index >= 0; index -= 1) {
      const previousIndex = messages.findIndex((item) => item.id === sourceOrder[index]?.id);
      if (previousIndex !== -1) {
        messages.splice(previousIndex + 1, 0, message);
        return;
      }
    }
  }

  messages.push(message);
}

function sortFullyTimestampedMessages(messages: UIMessage[]) {
  const withCreated = messages.map((message, index) => ({ message, index, created: messageCreated(message) }));
  if (withCreated.some((item) => item.created === null)) return messages;

  return withCreated
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.index - b.index)
    .map((item) => item.message);
}

export function messageListContainsAll(container: UIMessage[], required: UIMessage[]) {
  if (required.length === 0) return true;
  const ids = new Set(container.map((message) => message.id));
  return required.every((message) => ids.has(message.id));
}

export function mergeSnapshotAndLiveMessages(
  snapshotMessages: UIMessage[],
  liveMessages: UIMessage[],
  options: { appendLiveOnlyMessages?: boolean } = {},
) {
  if (snapshotMessages.length === 0) return liveMessages;
  if (liveMessages.length === 0) return snapshotMessages;

  const liveById = new Map(liveMessages.map((message) => [message.id, message]));
  const snapshotIds = new Set(snapshotMessages.map((message) => message.id));
  const merged = snapshotMessages.map((snapshotMessage) => {
    const liveMessage = liveById.get(snapshotMessage.id);
    return liveMessage ? mergeSnapshotMessageWithCached(snapshotMessage, liveMessage) : snapshotMessage;
  });

  if (options.appendLiveOnlyMessages) {
    for (const liveMessage of liveMessages) {
      if (!snapshotIds.has(liveMessage.id)) insertMessageByChronology(merged, liveMessage, liveMessages);
    }
  }

  return sortFullyTimestampedMessages(merged);
}

export function mergeSnapshotIntoCachedMessages(snapshotMessages: UIMessage[], cachedMessages: UIMessage[]) {
  if (snapshotMessages.length === 0) return cachedMessages;
  if (cachedMessages.length === 0) return snapshotMessages;

  const snapshotById = new Map(snapshotMessages.map((message) => [message.id, message]));
  const cachedById = new Map(cachedMessages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const merged = snapshotMessages.map((message) => {
    seen.add(message.id);
    const snapshotMessage = snapshotById.get(message.id);
    const cachedMessage = cachedById.get(message.id);
    return snapshotMessage && cachedMessage
      ? mergeSnapshotMessageWithCached(snapshotMessage, cachedMessage)
      : message;
  });

  for (const message of cachedMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    insertMessageByChronology(merged, message, cachedMessages);
  }

  return sortFullyTimestampedMessages(merged);
}
