import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SofiaServerClient } from "@/app/lib/sofia-server";
import { Switch } from "@/components/ui/switch";
import { SettingsNotice, SettingsStack } from "@/react-app/domains/settings/settings-section";

const clientIds = new WeakMap<SofiaServerClient, number>();
let nextClientId = 0;

export function LocalMemorySettings(props: { client: SofiaServerClient | null; workspaceId: string | null }) {
  const client = props.client;
  if (client && !clientIds.has(client)) clientIds.set(client, ++nextClientId);
  const source = client ? clientIds.get(client) : 0;
  return <WorkspaceLocalMemorySettings key={`${source}:${props.workspaceId}`} {...props} source={source} />;
}

function WorkspaceLocalMemorySettings({ client, workspaceId, source }: {
  client: SofiaServerClient | null;
  workspaceId: string | null;
  source: number | undefined;
}) {
  const queryClient = useQueryClient();
  const key = ["local-memory-settings", source, workspaceId];
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(client && workspaceId),
    queryFn: async () => {
      if (!client || !workspaceId) throw new Error("Select a workspace to configure local memory.");
      const config = await client.getConfig(workspaceId);
      const value = config.engine.memories;
      return {
        use_memories: Boolean(value && typeof value === "object" && "use_memories" in value && value.use_memories === true),
        generate_memories: Boolean(value && typeof value === "object" && "generate_memories" in value && value.generate_memories === true),
      };
    },
  });
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const save = async (name: "use_memories" | "generate_memories", enabled: boolean) => {
    if (!client || !workspaceId || !query.data || saving) return;
    const targetKey = ["local-memory-settings", source, workspaceId];
    setSaving(true);
    setError(null);
    try {
      const memories = { ...query.data, [name]: enabled };
      await client.patchConfig(workspaceId, { engine: { memories } });
      queryClient.setQueryData(targetKey, memories);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not save local memory settings.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return <SettingsStack>
    <h3 className="text-sm font-medium">Local memory</h3>
    <p className="text-sm text-muted-foreground">Stored on this device by the engine. Sofia Cloud is not required. These settings apply to new chats in this workspace.</p>
    {!workspaceId ? <SettingsNotice>Select a workspace to configure local memory.</SettingsNotice> : null}
    {query.isError ? <SettingsNotice tone="error">Could not load local memory settings.</SettingsNotice> : null}
    {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    <label className="flex items-center justify-between gap-4"><span className="text-sm">Use local memories in new chats</span><Switch aria-label="Use local memories" checked={query.data?.use_memories === true} disabled={saving || !query.data} onCheckedChange={enabled => void save("use_memories", enabled)} /></label>
    <label className="flex items-center justify-between gap-4"><span className="text-sm">Generate local memories from earlier chats</span><Switch aria-label="Generate local memories" checked={query.data?.generate_memories === true} disabled={saving || !query.data} onCheckedChange={enabled => void save("generate_memories", enabled)} /></label>
    <p className="text-sm text-muted-foreground">Generation runs in the background when a new chat starts, using the configured provider and model. It can use model credits. Earlier chats must normally be idle for at least six hours; enabling this does not immediately create memories. Turning it off preserves existing memories.</p>
  </SettingsStack>;
}
