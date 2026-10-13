import { create } from "zustand";
import type { SessionResources } from "./session-resources";

export const useSessionResourcesStore = create<{
  sessions: Record<string, SessionResources>;
  setSession: (id: string, resources: SessionResources) => void;
}>((set) => ({sessions:{},setSession:(id,resources)=>set(state=>{
  const sessions={...state.sessions,[id]:resources};
  const keys=Object.keys(sessions);
  if(keys.length>128)delete sessions[keys[0]];
  return {sessions};
})}));
