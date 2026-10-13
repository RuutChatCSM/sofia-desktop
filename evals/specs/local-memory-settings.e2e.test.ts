import { expect } from "vitest";
import { evalIn, waitFor } from "@sofia/behaviors";
import { desktop } from "@sofia/hosts";
import { needs, test } from "@sofia/testkit";

test("local memory controls persist independently without Cloud sign-in", { timeout: 180_000 }, async () => {
  needs({ optIn: ["SOFIA_EVAL_E2E_TESTS"], placement: "local" });
  await using app = await desktop({ name: "local-memory-settings" });
  await waitFor(app, `document.body.textContent.includes("Welcome to Sofia")`, { label: "initial app loaded" });
  await evalIn(app, `(async()=>{
    const {LocalMemorySettings}=await import('/src/react-app/domains/settings/pages/local-memory-settings.tsx');
    const React=(await import('/node_modules/.vite/deps/react.js')).default;
    const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const queryURL=performance.getEntriesByType('resource').find(entry=>entry.name.includes('/@tanstack_react-query.js')).name;
    const {QueryClient,QueryClientProvider}=await import(queryURL);
    window.__memoryProof={saves:[],settings:{use_memories:false,generate_memories:false}};
    const client={getConfig:async()=>({engine:{memories:window.__memoryProof.settings}}),patchConfig:async(workspace,payload)=>{window.__memoryProof.saves.push({workspace,payload});window.__memoryProof.settings=payload.engine.memories;}};
    const el=document.createElement('div');el.id='local-memory-proof';document.body.append(el);
    class Boundary extends React.Component {constructor(props){super(props);this.state={error:null}}static getDerivedStateFromError(error){return {error:String(error)}}render(){return this.state.error?React.createElement("p",null,this.state.error):this.props.children}}
    createRoot(el).render(React.createElement(Boundary,null,React.createElement(QueryClientProvider,{client:new QueryClient()},React.createElement(LocalMemorySettings,{client,workspaceId:'proof-workspace'}))));
  })()`, { awaitPromise: true });
  await waitFor(app, `!!document.querySelector('#local-memory-proof [aria-label="Use local memories"]')&&!document.querySelector('#local-memory-proof [aria-label="Use local memories"]').disabled`, { label: "local settings loaded" });
  expect(await evalIn(app, `document.querySelector('#local-memory-proof [aria-label="Use local memories"]').getAttribute('aria-checked')`)).toBe("false");
  await evalIn(app, `document.querySelector('#local-memory-proof [aria-label="Use local memories"]').click()`);
  await waitFor(app, `document.querySelector('#local-memory-proof [aria-label="Use local memories"]').getAttribute('aria-checked')==='true'`, { label: "local recall enabled" });
  expect(await evalIn(app, `window.__memoryProof.saves`)).toEqual([{ workspace: "proof-workspace", payload: { engine: { memories: { use_memories: true, generate_memories: false } } } }]);
  await evalIn(app, `document.querySelector('#local-memory-proof [aria-label="Generate local memories"]').click()`);
  await waitFor(app, `window.__memoryProof.saves.length===2`, { label: "generation separately saved" });
  expect(await evalIn(app, `window.__memoryProof.settings`)).toEqual({ use_memories: true, generate_memories: true });
  expect(await evalIn(app, `document.querySelector('#local-memory-proof').textContent`)).toContain("Sofia Cloud is not required");
  expect(await evalIn(app, `document.querySelector('#local-memory-proof').textContent`)).toContain("six hours");
});
