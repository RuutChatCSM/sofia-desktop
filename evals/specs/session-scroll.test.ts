import { expect } from "vitest";
import { test } from "@sofia/testkit";
import { intentFromKey, isAtTail } from "../../apps/app/src/react-app/domains/session/surface/scroll-intent";
import { useSessionScrollStore } from "../../apps/app/src/react-app/domains/session/surface/scroll-store";

test("manual position retains stable message identity across content replacement",()=>{
  const store=useSessionScrollStore.getState();
  store.setManualScroll("anchor-proof",400,null,{messageId:"message-20",offset:-17});
  const state=useSessionScrollStore.getState().sessions["anchor-proof"];
  expect(state).toMatchObject({mode:"manual",scrollTop:400,anchor:{messageId:"message-20",offset:-17}});
  store.setTopClippedMessageId("anchor-proof","message-90");
  expect(useSessionScrollStore.getState().sessions["anchor-proof"]).toMatchObject({anchor:{messageId:"message-20",offset:-17}});
  store.setStickyBottom("anchor-proof",null);
  expect(useSessionScrollStore.getState().sessions["anchor-proof"]).toEqual({mode:"stickyBottom",topClippedMessageId:null});
});

test("shipped bottom threshold and shifted-space navigation are retained",()=>{
  expect(isAtTail({scrollTop:576,clientHeight:400,scrollHeight:1000})).toBe(true);
  expect(isAtTail({scrollTop:575,clientHeight:400,scrollHeight:1000})).toBe(false);
  expect(intentFromKey(" ",{scrollTop:600,clientHeight:400,scrollHeight:1000},undefined,true)).toEqual({mode:"detached",reason:"user-scroll"});
  expect(intentFromKey("Spacebar",{scrollTop:600,clientHeight:400,scrollHeight:1000})).toEqual({mode:"follow-tail"});
});
